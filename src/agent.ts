// Ana döngü. Her 60 s tick: pozisyon yönetimi. Her 15 dk mum kapanışı: BTC filtresi → tarama → LLM seçici → risk → emir.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CFG } from "./config";
import { Atk } from "./mcp";
import { getUniverse, getInstruments, getCandles, getLast, getBook, getSmartMoney, getNews, getSentiment, getImportantNews, getFreshCoinNews, type Inst, type Ticker } from "./market";
import { detectSweep, relStrength, btcGate, dayRangePct, targetPrice, bookImbalance, technicalContext, type Bar } from "./signals";
import { positionNotional, canOpen, dailyStopHit, stopPrice, roundSize, roundPrice } from "./risk";
import { getBalance, placeLimitBuy, getOrder, cancelOrder, sellMarket, placeOco, lastSellFill, moveStop } from "./exchange";
import { decide, ask, type Candidate } from "./llm";
import { log, trTime } from "./journal";
import { flush as anchorFlush, anchorStatus, anchorAddress, pendingCount, lastFlushTs } from "./anchor";
import { startCommandLoop, getMode, askApproval } from "./commands";
import { buildReport } from "./report";
import { emptyShadow, stepShadow, flattenShadow, shadowSummary, type ShadowState } from "./shadow";

type Position = { instId: string; qty: number; entry: number; target: number; sl: number; openedTs: number; openedBucket: number; reason: string; oco?: boolean; locked?: boolean };
type Pending = { instId: string; ordId: string; px: number; sz: number; target: number; sl: number; ts: number; reason: string };
type State = {
  day: string; dayStartEquity: number; equity: number; halted: boolean; tradesToday: number;
  positions: Record<string, Position>; pending: Record<string, Pending>; cooldown: Record<string, number>; seen: Record<string, number>;
  closed: { instId: string; entry: number; exit: number; qty: number; pnl: number; why: string; ts: number }[];
  lastBucket: number; postmortem?: boolean; shadow: ShadowState; seenNews?: Record<string, number>; newsTradesToday?: number;
};

const BAR_MS = CFG.barMin * 60_000;   // tarama ritmi = mum çözünürlüğü
const TR_OFFSET_MS = 3 * 3600_000; // Türkiye UTC+3, yaz saati yok

function trNow(): { day: string; hm: string; minutes: number } {
  const t = new Date(Date.now() + TR_OFFSET_MS);
  const hm = t.toISOString().slice(11, 16);
  return { day: t.toISOString().slice(0, 10), hm, minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
function sessionStartTs(): number {
  const t = new Date(Date.now() + TR_OFFSET_MS); t.setUTCHours(toMin(CFG.session.start) / 60 | 0, toMin(CFG.session.start) % 60, 0, 0);
  return t.getTime() - TR_OFFSET_MS;
}

function loadState(day: string): State {
  if (existsSync(CFG.paths.state)) {
    const s: State = JSON.parse(readFileSync(CFG.paths.state, "utf-8"));
    if (s.day === day) { s.shadow ??= emptyShadow(); return s; }
  }
  return { day, dayStartEquity: 0, equity: 0, halted: false, tradesToday: 0, positions: {}, pending: {}, cooldown: {}, seen: {}, closed: [], lastBucket: 0, shadow: emptyShadow() };
}
function saveState(s: State) { mkdirSync("state", { recursive: true }); writeFileSync(CFG.paths.state, JSON.stringify(s, null, 1)); }
function saveMetrics(m: Record<string, unknown>) { try { writeFileSync("state/metrics.json", JSON.stringify(m)); } catch { /* */ } }

/** Ağ yokken açılışta çökme yerine bekle ve tekrar dene (hotspot kesintileri). */
async function retry<T>(what: string, fn: () => Promise<T>, tries = 12, waitMs = 10_000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { lastErr = e; console.log(`açılış: ${what} başarısız (${i + 1}/${tries}) — ${(e as Error).message?.slice(0, 80)} · ${waitMs / 1000} sn sonra tekrar`); await new Promise((r) => setTimeout(r, waitMs)); }
  }
  throw lastErr;
}

async function main() {
  const atk = new Atk();
  await retry("MCP bağlantısı", () => atk.connect());
  const { day } = trNow();
  const st = loadState(day);
  let inst: Map<string, Inst> = await retry("enstrümanlar", () => getInstruments(atk));
  let universe: Ticker[] = await retry("izleme listesi", () => getUniverse(atk));
  let universeTs = Date.now();
  let smart = await getSmartMoney(atk); let smartTs = Date.now();
  const last = { scan: "", gate: "", llm: "", cands: [] as Record<string, unknown>[] };
  try {   // yeniden başlatmada son tarama/karar kaybolmasın
    const m = JSON.parse(readFileSync("state/metrics.json", "utf-8"));
    if (m?.mode === (CFG.dryRun ? "dry" : "live")) { last.scan = m.lastScan ?? ""; last.gate = m.lastGate ?? ""; last.llm = m.lastLlm ?? ""; last.cands = m.lastCands ?? []; }
  } catch { /* ilk çalışma */ }
  const H = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pctOf = (a: number, b: number) => `${a / b - 1 >= 0 ? "+" : ""}${((a / b - 1) * 100).toFixed(2)}%`;
  const dayPct = () => (st.dayStartEquity ? `${st.equity / st.dayStartEquity - 1 >= 0 ? "+" : ""}${((st.equity / st.dayStartEquity - 1) * 100).toFixed(2)}%` : "0.00%");

  // Uzlaştırma: borsadaki gerçek bakiye ile başla.
  const bal = await getBalance(atk);
  st.equity = bal.totalEq;
  if (!st.dayStartEquity) st.dayStartEquity = bal.totalEq;
  for (const [id, p] of Object.entries(st.positions)) {
    const have = bal.coins[id.split("-")[0]!] ?? 0;
    if (have < p.qty * 0.5) { log("stop", `${id}: bakiye yok, pozisyon borsada kapanmış (SL?)`, { qty: p.qty, have }); delete st.positions[id]; }
  }
  saveState(st);
  log("boot", `ajan başladı · ${CFG.dryRun ? "dry-run" : "canlı"} · kasa ${st.equity.toFixed(2)} USDT · izleme listesi ${universe.length} parite · ${Object.keys(st.positions).length} açık pozisyon devralındı`,
    { dayStartEquity: st.dayStartEquity, positions: Object.keys(st.positions), risk: CFG.risk, anchor: anchorStatus(), anchorAddress: anchorAddress(),
      tg: `<b>Ajan başladı</b> · ${CFG.dryRun ? "dry-run" : "canlı"}${String.fromCharCode(10)}Kasa ${st.equity.toFixed(2)} USDT · izleme listesi ${universe.length} parite${Object.keys(st.positions).length ? `${String.fromCharCode(10)}Devralınan pozisyon: ${Object.keys(st.positions).join(", ")}` : ""}` });

  async function flattenAll(why: string) {
    for (const [id, p] of Object.entries(st.pending)) {
      try { await cancelOrder(atk, id, p.ordId); log("cancel", `${id}: bekleyen emir iptal (${why})`); } catch (e) { log("error", `${id} iptal: ${(e as Error).message}`); }
      delete st.pending[id];
    }
    for (const [id, p] of Object.entries(st.positions)) await closePosition(id, p, why);
  }

  async function closePosition(id: string, p: Position, why: string) {
    try {
      let px = await getLast(atk, id);
      const sellId = await sellMarket(atk, id, String(p.qty), inst.get(id)?.lotSz ?? 0);
      let pnl = (px - p.entry) * p.qty - px * p.qty * 0.001;
      try {   // gerçekleşen satış fiyatı ve komisyon borsadan (tahmin değil)
        await new Promise((r) => setTimeout(r, 1200));
        const so = await getOrder(atk, id, sellId, px, p.qty);
        if (so.avgPx > 0 && so.accFillSz > 0) { px = so.avgPx; pnl = so.accFillSz * so.avgPx - p.qty * p.entry - (so.feeCcy === "USDT" ? Math.abs(so.fee) : 0); }
      } catch { /* tahminle devam */ }
      st.closed.push({ instId: id, entry: p.entry, exit: px, qty: p.qty, pnl, why, ts: Date.now() });
      st.cooldown[id] = Math.floor(Date.now() / BAR_MS);
      delete st.positions[id];
      const title = why === "hedef" ? "HEDEFE ULAŞTI" : why === "gün sonu" ? "GÜN SONU NAKİT" : "FREN SATIŞI";
      log(why === "hedef" ? "exit" : why === "gün sonu" ? "flat" : "halt", `${id} satıldı @${px} · ${why} · sonuç ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} USDT (${pctOf(px, p.entry)})`, { entry: p.entry, target: p.target,
        tg: `<b>${title} · ${id}</b>${String.fromCharCode(10)}Giriş ${p.entry} → çıkış ${px} (${pctOf(px, p.entry)})${String.fromCharCode(10)}Sonuç ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} USDT · kasa ${st.equity.toFixed(2)} (${dayPct()})` });
    } catch (e) { log("error", `${id} satış başarısız: ${(e as Error).message}`); }
  }

  let busy = false;   // tick 60 sn'yi aşarsa (LLM + onay bekleme) ikinci tick üst üste binmesin: emir/satış tekrarı olmaz
  async function tick() {
    if (busy) { console.log("tick atlandı: önceki tick sürüyor"); return; }
    busy = true;
    try { await tickInner(); } finally { busy = false; }
  }
  async function tickInner() {
    const { hm, minutes } = trNow();
    try {
      const b = await getBalance(atk); st.equity = b.totalEq;
      if (!st.dayStartEquity && b.totalEq > 0) { st.dayStartEquity = b.totalEq; log("info", `gün başı kasa belirlendi: ${b.totalEq.toFixed(2)} USDT`); }
      // bekleyen emirler
      for (const [id, p] of Object.entries(st.pending)) {
        const o = await getOrder(atk, id, p.ordId, p.px, p.sz);
        if (o.state === "filled" || (o.accFillSz > 0 && (o.state === "canceled" || Date.now() - p.ts > CFG.exit.orderTimeoutSec * 1000))) {
          if (o.state === "live" || o.state === "partially_filled") { try { await cancelOrder(atk, id, p.ordId); } catch { /* */ } }
          const entry = o.avgPx || p.px;
          const base = id.split("-")[0]!;
          const qty = (o.accFillSz || p.sz) + (o.feeCcy === base ? o.fee : 0);   // OKX alış komisyonunu coin cinsinden keser (fee negatif)
          st.positions[id] = { instId: id, qty, entry, target: targetPrice(entry, p.target, CFG.exit.targetMinPct, CFG.exit.targetMaxPct), sl: p.sl, openedTs: Date.now(), openedBucket: Math.floor(Date.now() / BAR_MS), reason: p.reason, oco: true };
          delete st.pending[id];
          // dolum fiyatı limitten %0,2'den fazla saparsa hedef ve stop gerçek girişe göre yeniden borsaya konur (STORJ dersi: stop %4 yerine %2,55 kalmıştı)
          if (!CFG.dryRun && Math.abs(entry / p.px - 1) > 0.002) {
            const i = inst.get(id); const pos = st.positions[id]!;
            const sl2 = roundPrice(stopPrice(entry, CFG.risk), i?.tickSz ?? 0); const tp2 = roundPrice(pos.target, i?.tickSz ?? 0);
            try { await placeOco(atk, id, String(roundSize(qty, i?.lotSz ?? 0, 0)), String(tp2), String(sl2)); pos.sl = sl2; log("info", `${id}: dolum ${pctOf(entry, p.px)} sapmış → hedef ${tp2} ve stop ${sl2} gerçek girişe göre yeniden borsaya kondu`); }
            catch (e) { log("error", `${id} OCO yeniden: ${(e as Error).message?.slice(0, 120)}`); }
          }
          const tgt = st.positions[id]!.target;
          log("fill", `${id} alındı · ${qty} adet @${entry} · hedef ${tgt.toFixed(4)} (${pctOf(tgt, entry)}) ve stop ${p.sl} borsada (OCO)`, { reason: p.reason,
            tg: `<b>ALIŞ DOLDU · ${id}</b>${String.fromCharCode(10)}${qty.toFixed(4)} adet @ ${entry} (${(qty * entry).toFixed(2)} USDT)${String.fromCharCode(10)}Hedef ${tgt.toFixed(4)} (${pctOf(tgt, entry)}) · stop ${p.sl} (${pctOf(p.sl, entry)}) · ikisi de borsada${String.fromCharCode(10)}<i>${H(p.reason)}</i>` });
        } else if (o.state === "canceled" || Date.now() - p.ts > CFG.exit.orderTimeoutSec * 1000) {
          if (o.state !== "canceled") { try { await cancelOrder(atk, id, p.ordId); } catch { /* */ } }
          delete st.pending[id];
          log("cancel", `${id}: ${CFG.exit.orderTimeoutSec}s içinde dolmadı, iptal. Kaçırılan işlem = işlem değil.`);
        }
      }
      // açık pozisyonlar
      for (const [id, p] of Object.entries(st.positions)) {
        const have = b.coins[id.split("-")[0]!];
        if (!CFG.dryRun && have !== undefined && have < p.qty * 0.5) {
          // borsa tarafında kapanmış: hedef mi stop mu? gerçek satış fill'inden oku
          const f = await lastSellFill(atk, id, p.openedTs - 60_000);
          const exitPx = f?.avgPx ?? (await getLast(atk, id).catch(() => p.sl));
          const hitTp = exitPx >= (p.entry + p.target) / 2;
          const pnl = f ? f.qty * f.avgPx - p.qty * p.entry - f.feeUsdt : (exitPx - p.entry) * p.qty;
          st.closed.push({ instId: id, entry: p.entry, exit: exitPx, qty: p.qty, pnl, why: hitTp ? "hedef (borsada)" : "SL", ts: Date.now() });
          st.cooldown[id] = Math.floor(Date.now() / BAR_MS); delete st.positions[id];
          log(hitTp ? "exit" : "stop", `${id} ${hitTp ? "hedefe ulaştı" : "stop oldu"} · borsa tarafında @${exitPx} (${pctOf(exitPx, p.entry)}) · sonuç ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} USDT`, { entry: p.entry,
            tg: `<b>${hitTp ? "HEDEFE ULAŞTI" : "STOP"} · ${id}</b> · borsa tarafında${String.fromCharCode(10)}Giriş ${p.entry} → çıkış ${exitPx} (${pctOf(exitPx, p.entry)})${String.fromCharCode(10)}Sonuç ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} USDT · kasa ${st.equity.toFixed(2)} (${dayPct()})` }); continue;
        }
        if (!p.oco && !CFG.dryRun) {   // eski pozisyon: hedefi de borsaya taşı (OCO)
          try {
            const i = inst.get(id); const sz = roundSize(have ?? p.qty, i?.lotSz ?? 0, 0);
            await placeOco(atk, id, String(sz), String(roundPrice(p.target, i?.tickSz ?? 0)), String(p.sl));
            p.oco = true; saveState(st);
            log("info", `${id}: hedef ${p.target.toFixed(4)} ve stop ${p.sl} borsaya OCO olarak taşındı; ajan kör kalsa bile çıkış gerçekleşir`, { tg: `<b>${id}</b> · hedef ve stop artık borsada (OCO)` });
          } catch (e) { log("error", `${id} OCO: ${(e as Error).message?.slice(0, 160)}`); }
        }
        // hedef tavanı düştüyse açık pozisyonun borsadaki hedefi de tavana çekilir (kural değişikliği eski pozisyona da uygulanır)
        const cap = p.entry * (1 + CFG.exit.targetMaxPct / 100);
        if (p.oco && !p.locked && p.target > cap * 1.0005) {
          try {
            const i = inst.get(id); const sz = roundSize(have ?? p.qty, i?.lotSz ?? 0, 0); const tp = roundPrice(cap, i?.tickSz ?? 0);
            await placeOco(atk, id, String(sz), String(tp), String(p.sl));
            const old = p.target; p.target = tp; saveState(st);
            log("info", `${id}: hedef tavanı +${CFG.exit.targetMaxPct}% → hedef ${old.toFixed(4)} yerine ${tp}, borsada yenilendi (stop ${p.sl} aynı)`, { tg: `<b>${id}</b> · hedef ${tp}'e çekildi (giriş +${CFG.exit.targetMaxPct}%), borsada · stop ${p.sl}` });
          } catch (e) { log("error", `${id} hedef güncelleme: ${(e as Error).message?.slice(0, 160)}`); }
        }
        const px = await getLast(atk, id);
        if (px >= p.target) { await closePosition(id, p, "hedef"); continue; }
        // kâr kilidi: +%1 görüldü → stop girişin üstüne (borsada). Kârdayken zarara dönmek biter.
        if (!p.locked && px >= p.entry * (1 + CFG.exit.lockAtPct / 100)) {
          const newSl = roundPrice(p.entry * (1 + CFG.exit.lockToPct / 100), inst.get(id)?.tickSz ?? 0);
          try {
            if (await moveStop(atk, id, String(newSl))) { p.sl = newSl; p.locked = true; saveState(st); log("info", `${id}: kâr kilidi · fiyat ${px} (+${((px / p.entry - 1) * 100).toFixed(2)}%) → stop ${newSl}'e çekildi (giriş +${CFG.exit.lockToPct}%)`, { tg: `<b>KÂR KİLİDİ · ${id}</b>${String.fromCharCode(10)}Fiyat ${px} (${pctOf(px, p.entry)}) → stop ${newSl}, artık zarara dönemez` }); }
          } catch (e) { log("error", `${id} kâr kilidi: ${(e as Error).message?.slice(0, 120)}`); }
        }
      }
      // gün sonu ve fren
      if (minutes >= toMin(CFG.session.flat)) {
        if (Object.keys(st.positions).length || Object.keys(st.pending).length) { await flattenAll("gün sonu"); log("flat", `${hm}: zorunlu nakit tamam. Gün getirisi ${((st.equity / st.dayStartEquity - 1) * 100).toFixed(2)}%`); }
        if (Object.keys(st.shadow.open).length) {
          const px: Record<string, number> = {};
          for (const id of Object.keys(st.shadow.open)) px[id] = await getLast(atk, id).catch(() => 0) || st.shadow.open[id]!.entry;
          st.shadow = flattenShadow(st.shadow, px, Date.now());
          log("info", `gün sonu ${shadowSummary(st.shadow, st.dayStartEquity)} | ben: ${((st.equity / st.dayStartEquity - 1) * 100).toFixed(2)}%`);
        }
        if (!st.postmortem) {
          st.postmortem = true; saveState(st);
          try {
            const journal = existsSync(CFG.paths.journal) ? readFileSync(CFG.paths.journal, "utf-8").trim().split(String.fromCharCode(10)).slice(-200).map((l) => { try { const e = JSON.parse(l); return `${e.ts.slice(11, 16)}Z ${e.role}·${e.kind}: ${e.msg}${e.data?.reason ? " → " + e.data.reason : ""}`; } catch { return ""; } }).join(String.fromCharCode(10)) : "";
            const text = await ask("Günün post-mortem'ini yaz: ne oldu, kaç tarama, kaç aday, neden girdin/girmedin, risk kuralları ne zaman devreye girdi, yarın için tek ders. En fazla 10 cümle.", `GÜN: ${st.day} · başlangıç ${st.dayStartEquity.toFixed(2)} → bitiş ${st.equity.toFixed(2)} USDT · kapanan işlem ${st.closed.length}
${journal}`);
            log("info", `GÜN SONU ANLATISI (Karar): ${text}`);
          } catch (e) { log("error", `post-mortem: ${(e as Error).message?.slice(0, 120)}`); }
        }
      } else if (!st.halted && dailyStopHit(st.equity, st.dayStartEquity, CFG.risk)) {
        st.halted = true; await flattenAll("gün freni");
        log("halt", `GÜN FRENİ: kasa ${st.equity.toFixed(2)} (${((st.equity / st.dayStartEquity - 1) * 100).toFixed(2)}%). Bugün yeni işlem yok.`);
      }
      // mum kapanışı
      const bucket = Math.floor(Date.now() / BAR_MS);
      if (bucket > st.lastBucket && Date.now() - bucket * BAR_MS > 20_000) {
        st.lastBucket = bucket; saveState(st);
        if (minutes >= toMin(CFG.session.start) && minutes < toMin(CFG.session.flat)) await onBarClose();
        else log("info", `${hm}: seans dışı, sadece izleme`);
      }
      if (minutes % 15 === 0) {
        const shPct = st.dayStartEquity ? (st.shadow.pnlUsdt / st.dayStartEquity) * 100 : 0;
        log("snapshot", `kasa ${st.equity.toFixed(2)} USDT (${dayPct()}) · ${Object.keys(st.positions).length} açık · ${Object.keys(st.pending).length} bekleyen · ${st.tradesToday} işlem · MCP ${atk.calls} çağrı ${atk.errors} hata · ${shadowSummary(st.shadow, st.dayStartEquity)}`,
          { tg: `<b>${hm} durum</b>${String.fromCharCode(10)}Kasa ${st.equity.toFixed(2)} USDT (${dayPct()})${String.fromCharCode(10)}${Object.keys(st.positions).length} açık · ${Object.keys(st.pending).length} bekleyen · ${st.tradesToday}/${CFG.risk.maxTradesPerDay} işlem${String.fromCharCode(10)}Kovalayan bot ${shPct >= 0 ? "+" : ""}${shPct.toFixed(2)}% (${st.shadow.trades} işlem) · ben ${dayPct()}` });
      }
      if (minutes % 15 === 0 || (pendingCount() > 0 && Date.now() - lastFlushTs > 16 * 60_000)) {
        const a = await anchorFlush();
        if (a) log("info", `X Layer denetim izi · ${a.n} karar zincire yazıldı · ${a.url}`, { tg: `<b>X Layer denetim izi</b>${String.fromCharCode(10)}${a.n} karar hash'lendi ve zincire yazıldı${String.fromCharCode(10)}${a.url}` });
        else if (pendingCount() > 0) log("info", `X Layer: ${anchorStatus()}`);
      }
    } catch (e) {
      log("error", `tick: ${(e as Error).message?.slice(0, 200)}`);
    }
    saveState(st);
    saveMetrics({ ts: Date.now(), mode: CFG.dryRun ? "dry" : "live", mcpCalls: atk.calls, mcpErrors: atk.errors, byTool: atk.byTool, lastScan: last.scan, lastGate: last.gate, lastLlm: last.llm, lastCands: last.cands, anchor: anchorStatus(), universe: universe.length, llm: CFG.llm.provider,
      shadow: { summary: shadowSummary(st.shadow, st.dayStartEquity), pnlPct: st.dayStartEquity ? (st.shadow.pnlUsdt / st.dayStartEquity) * 100 : 0, trades: st.shadow.trades, wins: st.shadow.wins, open: Object.values(st.shadow.open), closed: st.shadow.closed.slice(-8) } });
  }

  async function onBarClose() {
    const { hm, minutes } = trNow();
    if (st.halted) { log("info", `${hm}: fren aktif, tarama yok`); return; }
    if (minutes >= toMin(CFG.session.lastEntry)) { log("info", `${hm}: son giriş saati ${CFG.session.lastEntry} geçti, yeni giriş yok; açık pozisyonu 19:15'e kadar izliyorum`); return; }
    if (Date.now() - universeTs > CFG.universe.refreshMin * 60_000) { try { universe = await getUniverse(atk); inst = await getInstruments(atk); universeTs = Date.now(); } catch { /* eski izleme listesi */ } }
    if (Date.now() - smartTs > 15 * 60_000) { smart = await getSmartMoney(atk); smartTs = Date.now(); }

    const btc = await getCandles(atk, "BTC-USDT", 120);
    const gate = btcGate(btc, CFG.gate.btcBars, CFG.gate.btcMinRetPct);
    const slots = canOpen({ equity: st.equity, dayStartEquity: st.dayStartEquity, openPositions: Object.keys(st.positions).length + Object.keys(st.pending).length, tradesToday: st.tradesToday, halted: st.halted }, CFG.risk);
    const bucket = Math.floor(Date.now() / BAR_MS);
    const sStart = sessionStartTs();

    // tarama (5 paralel)
    const raw: { t: Ticker; sweep: NonNullable<ReturnType<typeof detectSweep>>; rs: number; range: number; bars: Bar[] }[] = [];
    const skipped: string[] = [];
    const queue = universe.filter((t) => !st.positions[t.instId] && !st.pending[t.instId]);
    let idx = 0;
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (idx < queue.length) {
        const t = queue[idx++]!;
        try {
          const bars = await getCandles(atk, t.instId, 120);
          st.shadow = stepShadow(st.shadow, t.instId, bars, st.equity, Date.now());   // kovalayan bot: kovalayan naif strateji, emir yok
          const sweep = detectSweep(bars, CFG.entry.lookback, CFG.entry.minDepthPct);
          if (!sweep) continue;
          const sigTs = bars[bars.length - 1]!.ts;
          if (st.seen[t.instId] === sigTs) continue;   // aynı mum ikinci kez değerlendirilmez
          st.seen[t.instId] = sigTs;
          const rs = relStrength(bars, btc, CFG.entry.rsBars);
          if (rs > CFG.entry.maxRs4hPct) { skipped.push(`${t.instId} (RS ${rs.toFixed(1)}% kovalama)`); continue; }
          if ((st.cooldown[t.instId] ?? -999) > bucket - CFG.risk.cooldownBars) { skipped.push(`${t.instId} (cooldown)`); continue; }
          raw.push({ t, sweep, rs, range: dayRangePct(bars, sStart), bars });
        } catch (e) { skipped.push(`${t.instId} (veri: ${(e as Error).message?.slice(0, 40)})`); }
      }
    }));
    raw.sort((a, b) => b.sweep.depthPct - a.sweep.depthPct);
    last.scan = `${hm}: ${raw.length} aday: ${raw.map((r) => `${r.t.instId} (derinlik ${r.sweep.depthPct.toFixed(2)}%)`).join(", ") || "yok"}`;
    last.gate = `BTC filtresi ${gate.open ? "AÇIK" : "KAPALI"} — BTC 4h ${gate.retPct.toFixed(2)}% (${hm})`;
    log("scan", `${hm} taraması · ${universe.length} parite · BTC 4 saatlik ${gate.retPct >= 0 ? "+" : ""}${gate.retPct.toFixed(2)}% → filtre ${gate.open ? "açık" : "kapalı"} · ${raw.length ? raw.length + " dip avı adayı: " + raw.map((r) => r.t.instId).join(", ") : "aday yok"}${skipped.length ? ` · ${skipped.length} elendi` : ""}`,
      { candidates: raw.map((r) => `${r.t.instId} d${r.sweep.depthPct.toFixed(2)}`), skipped: skipped.slice(0, 12) });

    if (bucket % (60 / CFG.barMin) === 0) {   // saat başı taraması
      const heads = await getImportantNews(atk, 4);
      if (heads.length) log("info", `${hm} piyasa notu (OKX news, yüksek önem): ${heads.map((h) => "• " + h.slice(0, 100)).join(" ")}`, { tg: `<b>${hm} piyasa notu</b> · OKX news${String.fromCharCode(10)}${heads.map((h) => "• " + H(h.slice(0, 120))).join(String.fromCharCode(10))}` });
    }
    if (!gate.open) { log("gate", `BTC filtresi kapalı · BTC 4 saatte ${gate.retPct.toFixed(2)}% · ${raw.length} aday reddedildi, nakitte bekliyorum`, { reason: "BTC düşerken long-only spotta risk bütçesi sıfır", tg: `<b>BTC FİLTRESİ KAPALI</b>${String.fromCharCode(10)}BTC 4 saatte ${gate.retPct.toFixed(2)}% · ${raw.length} aday reddedildi · nakitte bekliyorum` }); return; }
    // haber adayları: son 45 dk, izleme listesinde coin etiketi olan yüksek önemli haber (teknik kurulum şartı yok)
    st.seenNews ??= {}; st.newsTradesToday ??= 0;
    const newsCands: { t: Ticker; headline: string; bars: Bar[]; rs: number; range: number }[] = [];
    if (gate.open && (st.newsTradesToday ?? 0) < 1) {
      try {
        const fresh = await getFreshCoinNews(atk, 45);
        for (const n of fresh) {
          if (st.seenNews[n.id]) continue;
          st.seenNews[n.id] = Date.now();
          for (const coin of n.coins) {
            const t = universe.find((u) => u.instId === `${coin}-USDT`);
            if (!t || st.positions[t.instId] || st.pending[t.instId] || raw.some((r) => r.t.instId === t.instId) || newsCands.some((x) => x.t.instId === t.instId)) continue;
            if ((st.cooldown[t.instId] ?? -999) > bucket - CFG.risk.cooldownBars) continue;
            const bars = await getCandles(atk, t.instId, 120);
            const rs = relStrength(bars, btc, CFG.entry.rsBars);
            if (rs > 3) { log("info", `haber adayı elendi: ${t.instId} fiyat zaten fırlamış (RS ${rs.toFixed(1)}%) · "${n.title.slice(0, 80)}"`); continue; }
            newsCands.push({ t, headline: n.title, bars, rs, range: dayRangePct(bars, sStart) });
            log("info", `HABER ADAYI: ${t.instId} · "${n.title.slice(0, 110)}"`, { tg: `<b>Haber adayı · ${t.instId}</b>${String.fromCharCode(10)}${H(n.title.slice(0, 160))}${String.fromCharCode(10)}Karar katmanına gidiyor (günde en fazla 1 haber işlemi)` });
            if (newsCands.length >= 2) break;
          }
          if (newsCands.length >= 2) break;
        }
      } catch (e) { log("error", `haber taraması: ${(e as Error).message?.slice(0, 120)}`); }
    }

    if (!raw.length && !newsCands.length) return;
    if (!slots.ok) { log("reject", `${raw.length + newsCands.length} aday var ama giriş yok: ${slots.why}`); return; }
    const freeSlots = CFG.risk.maxPositions - Object.keys(st.positions).length - Object.keys(st.pending).length;

    // zenginleştirme (en derin 6 dip avı + haber adayları)
    const top = raw.slice(0, 6);
    const newsEnriched: Candidate[] = await Promise.all(newsCands.map(async (r) => {
      let bookImb = 1;
      try { const bk = await getBook(atk, r.t.instId, 20); bookImb = bookImbalance(bk.bids, bk.asks, 1.0); } catch { /* */ }
      const coin = r.t.instId.split("-")[0]!;
      const close = r.bars[r.bars.length - 1]!.c;
      return { instId: r.t.instId, close, depthPct: 0, mid: close * 1.015, rs4h: r.rs, dayRangePct: r.range, volUsd: r.t.volUsd, bookImb, smart: smart.get(coin), news: await getNews(atk, coin), sentiment: await getSentiment(atk, coin), ta: technicalContext(r.bars, sStart), source: "haber" as const, headline: r.headline };
    }));
    const cands: Candidate[] = (await Promise.all(top.map(async (r): Promise<Candidate> => {
      let bookImb = 1; let news: string[] = [];
      try { const bk = await getBook(atk, r.t.instId, 20); bookImb = bookImbalance(bk.bids, bk.asks, 1.0); } catch { /* */ }
      const coin = r.t.instId.split("-")[0]!;
      news = await getNews(atk, coin);
      const sentiment = await getSentiment(atk, coin);
      const ta = technicalContext(r.bars, sStart);
      return { instId: r.t.instId, close: r.sweep.close, depthPct: r.sweep.depthPct, mid: r.sweep.mid, rs4h: r.rs, dayRangePct: r.range, volUsd: r.t.volUsd, bookImb, smart: smart.get(coin), news, sentiment, ta, source: "dip avı" as const };
    }))).concat(newsEnriched);

    // defter filtresi (kod): satıcı ağır defterde geri dönüş oynanmaz
    for (const c of cands.filter((x) => x.bookImb < CFG.bookMin)) log("reject", `${c.instId}: emir defteri satıcı ağır (${c.bookImb.toFixed(2)} < ${CFG.bookMin}), Karar katmanına gitmedi`);
    const kept = cands.filter((x) => x.bookImb >= CFG.bookMin);
    cands.length = 0; cands.push(...kept);
    if (!cands.length) return;
    last.cands = cands.map((c) => ({ instId: c.instId, source: c.source ?? "dip avı", close: c.close, depth: +c.depthPct.toFixed(2), mid: c.mid, rs4h: +c.rs4h.toFixed(2), range: +c.dayRangePct.toFixed(2), book: +c.bookImb.toFixed(2), smart: c.smart ? +c.smart.longRatio.toFixed(2) : null, sentiment: c.sentiment?.label ?? null, news: c.news.length, hm, rsi: c.ta?.rsi ?? null, trend: c.ta?.trend ?? null, atr: c.ta?.atrPct ?? null, vwap: c.ta?.vwapDist ?? null, volr: c.ta?.volRatio ?? null }));
    const d = await decide(cands, freeSlots, { btcRetPct: gate.retPct, equity: st.equity, tr: hm });
    last.llm = [`Karar (${d.provider}): ${d.note}`, ...d.picks.map((p) => `✅ ${p.instId}: ${p.reason}`), ...d.rejects.map((p) => `⛔ ${p.instId}: ${p.reason}`)].join(String.fromCharCode(10));
    log("llm", `${d.provider}: ${d.picks.length} seçim, ${d.rejects.length} ret. ${d.note}`, {
      picks: d.picks.map((p) => `${p.instId}: ${p.reason}`), rejects: d.rejects.map((p) => `${p.instId}: ${p.reason}`),
    });
    for (const rj of d.rejects) log("reject", `${rj.instId}: ${rj.reason}`);

    for (const pick of d.picks) {
      const c = cands.find((x) => x.instId === pick.instId)!; const i = inst.get(c.instId);
      if (!i) { log("reject", `${c.instId}: enstrüman bilgisi yok`); continue; }
      if (c.source === "haber" && (st.newsTradesToday ?? 0) >= 1) { log("reject", `${c.instId}: günlük haber işlemi hakkı dolu`); continue; }
      const notional = positionNotional(st.equity, CFG.risk);
      const px = roundPrice(c.close, i.tickSz);
      const sz = roundSize(notional / px, i.lotSz, i.minSz);
      if (sz <= 0) { log("reject", `${c.instId}: ${notional.toFixed(2)} USDT minimum lotun altında (minSz ${i.minSz})`); continue; }
      const sl = roundPrice(stopPrice(px, CFG.risk), i.tickSz);
      if (getMode() === "onaylı") {
        log("info", `${c.instId}: onaylı mod, sahibine soruluyor (60 sn)`);
        const ok = await askApproval(`${c.instId} al?\n${sz} @ ${px} (${(sz * px).toFixed(2)} USDT) · SL ${sl} · hedef ${targetPrice(px, c.mid, CFG.exit.targetMinPct, CFG.exit.targetMaxPct).toFixed(6)}\nKarar: ${pick.reason}`, 60_000);
        if (!ok) { log("reject", `${c.instId}: sahibi onaylamadı ya da süre doldu (onaylı mod)`); continue; }
      }
      try {
        const ordId = await placeLimitBuy(atk, { instId: c.instId, px: String(px), sz: String(sz), slPx: String(sl), tpPx: String(roundPrice(targetPrice(px, c.mid, CFG.exit.targetMinPct, CFG.exit.targetMaxPct), i.tickSz)), clOrdId: `ag${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 32) });
        st.pending[c.instId] = { instId: c.instId, ordId, px, sz, target: c.mid, sl, ts: Date.now(), reason: (c.source === "haber" ? `[haber: ${c.headline?.slice(0, 80)}] ` : "") + pick.reason };
        st.tradesToday++; if (c.source === "haber") st.newsTradesToday = (st.newsTradesToday ?? 0) + 1;
        const tgt = targetPrice(px, c.mid, CFG.exit.targetMinPct, CFG.exit.targetMaxPct);
        log("entry", `${c.instId} alış emri · ${sz} adet @${px} (${(sz * px).toFixed(2)} USDT, kasanın %${((sz * px) / st.equity * 100).toFixed(1)}'i) · hedef ${tgt.toFixed(4)} (${pctOf(tgt, px)}) · stop ${sl} borsada`, { reason: pick.reason, depth: c.depthPct, book: c.bookImb, source: c.source ?? "dip avı",
          tg: `<b>ALIŞ EMRİ · ${c.instId}</b>${c.source === "haber" ? " · haber adayı" : ""}${String.fromCharCode(10)}${sz} adet @ ${px} (${(sz * px).toFixed(2)} USDT, kasanın %${((sz * px) / st.equity * 100).toFixed(1)}'i)${String.fromCharCode(10)}Hedef ${tgt.toFixed(4)} (${pctOf(tgt, px)}) · stop ${sl} (${pctOf(sl, px)}, borsada)${String.fromCharCode(10)}<i>${H(pick.reason)}</i>` });
      } catch (e) { log("error", `${c.instId} emir: ${(e as Error).message?.slice(0, 200)}`); }
    }
    saveState(st);
  }

  startCommandLoop({
    snapshot: () => ({ equity: st.equity, dayStart: st.dayStartEquity, halted: st.halted, trades: st.tradesToday, positions: Object.values(st.positions), pending: Object.values(st.pending), mcpCalls: atk.calls, mcpErrors: atk.errors, lastScan: last.scan, lastGate: last.gate, lastLlm: last.llm }),
    lastPrice: (id) => getLast(atk, id),
    halt: async (why) => { st.halted = true; await flattenAll(why); saveState(st); log("halt", `MANUEL FREN (${why}): pozisyonlar kapatıldı, yeni işlem yok.`); },
    resume: () => { st.halted = false; saveState(st); log("info", "fren kaldırıldı (Telegram /devam)"); },
    report: () => buildReport(),
  });

  process.on("SIGINT", async () => { log("info", "kapatılıyor, durum kaydedildi (pozisyonlar ve borsa SL'leri duruyor)"); saveState(st); await atk.close(); process.exit(0); });

  if (CFG.once) { await tick(); st.lastBucket = 0; await onBarClose(); saveState(st); await atk.close(); return; }
  await tick();
  setInterval(tick, CFG.tickMs);
}

main().catch((e) => { log("error", `ölümcül: ${(e as Error).message}`); process.exit(1); });
