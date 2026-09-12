// Ana döngü. Her 60 s tick: pozisyon yönetimi. Her 15 dk mum kapanışı: kapı → tarama → LLM seçici → risk → emir.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CFG } from "./config";
import { Atk } from "./mcp";
import { getUniverse, getInstruments, getCandles, getLast, getBook, getSmartMoney, getNews, type Inst, type Ticker } from "./market";
import { detectSweep, relStrength, btcGate, dayRangePct, targetPrice, bookImbalance, type Bar } from "./signals";
import { positionNotional, canOpen, dailyStopHit, stopPrice, roundSize, roundPrice } from "./risk";
import { getBalance, placeLimitBuy, getOrder, cancelOrder, sellMarket } from "./exchange";
import { decide, type Candidate } from "./llm";
import { log, trTime } from "./journal";
import { flush as anchorFlush, anchorStatus, anchorAddress } from "./anchor";
import { startCommandLoop } from "./commands";
import { buildReport } from "./report";

type Position = { instId: string; qty: number; entry: number; target: number; sl: number; openedTs: number; openedBucket: number; reason: string };
type Pending = { instId: string; ordId: string; px: number; sz: number; target: number; sl: number; ts: number; reason: string };
type State = {
  day: string; dayStartEquity: number; equity: number; halted: boolean; tradesToday: number;
  positions: Record<string, Position>; pending: Record<string, Pending>; cooldown: Record<string, number>; seen: Record<string, number>;
  closed: { instId: string; entry: number; exit: number; qty: number; pnl: number; why: string; ts: number }[];
  lastBucket: number;
};

const BAR_MS = 15 * 60_000;
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
    if (s.day === day) return s;
  }
  return { day, dayStartEquity: 0, equity: 0, halted: false, tradesToday: 0, positions: {}, pending: {}, cooldown: {}, seen: {}, closed: [], lastBucket: 0 };
}
function saveState(s: State) { mkdirSync("state", { recursive: true }); writeFileSync(CFG.paths.state, JSON.stringify(s, null, 1)); }

async function main() {
  const atk = new Atk();
  await atk.connect();
  const { day } = trNow();
  const st = loadState(day);
  let inst: Map<string, Inst> = await getInstruments(atk);
  let universe: Ticker[] = await getUniverse(atk);
  let universeTs = Date.now();
  let smart = await getSmartMoney(atk); let smartTs = Date.now();
  const last = { scan: "", gate: "", llm: "" };

  // Uzlaştırma: borsadaki gerçek bakiye ile başla.
  const bal = await getBalance(atk);
  st.equity = bal.totalEq;
  if (!st.dayStartEquity) st.dayStartEquity = bal.totalEq;
  for (const [id, p] of Object.entries(st.positions)) {
    const have = bal.coins[id.split("-")[0]!] ?? 0;
    if (have < p.qty * 0.5) { log("stop", `${id}: bakiye yok, pozisyon borsada kapanmış (SL?)`, { qty: p.qty, have }); delete st.positions[id]; }
  }
  saveState(st);
  log("boot", `ajan ayakta | ${CFG.dryRun ? "DRY-RUN" : "CANLI"} | özkaynak ${st.equity.toFixed(2)} USDT | evren ${universe.length} parite | LLM ${CFG.llm.provider}`,
    { dayStartEquity: st.dayStartEquity, positions: Object.keys(st.positions), risk: CFG.risk, anchor: anchorStatus(), anchorAddress: anchorAddress() });

  async function flattenAll(why: string) {
    for (const [id, p] of Object.entries(st.pending)) {
      try { await cancelOrder(atk, id, p.ordId); log("cancel", `${id}: bekleyen emir iptal (${why})`); } catch (e) { log("error", `${id} iptal: ${(e as Error).message}`); }
      delete st.pending[id];
    }
    for (const [id, p] of Object.entries(st.positions)) await closePosition(id, p, why);
  }

  async function closePosition(id: string, p: Position, why: string) {
    try {
      const px = await getLast(atk, id);
      await sellMarket(atk, id, String(p.qty), inst.get(id)?.lotSz ?? 0);
      const pnl = (px - p.entry) * p.qty - px * p.qty * 0.001;
      st.closed.push({ instId: id, entry: p.entry, exit: px, qty: p.qty, pnl, why, ts: Date.now() });
      st.cooldown[id] = Math.floor(Date.now() / BAR_MS);
      delete st.positions[id];
      log(why === "hedef" ? "exit" : why === "gün sonu" ? "flat" : "halt", `${id}: satıldı @${px} (${why}) pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)} USDT`, { entry: p.entry, target: p.target });
    } catch (e) { log("error", `${id} satış başarısız: ${(e as Error).message}`); }
  }

  async function tick() {
    const { hm, minutes } = trNow();
    try {
      const b = await getBalance(atk); st.equity = b.totalEq;
      if (!st.dayStartEquity && b.totalEq > 0) { st.dayStartEquity = b.totalEq; log("info", `gün başı özkaynak belirlendi: ${b.totalEq.toFixed(2)} USDT`); }
      // bekleyen emirler
      for (const [id, p] of Object.entries(st.pending)) {
        const o = await getOrder(atk, id, p.ordId, p.px, p.sz);
        if (o.state === "filled" || (o.accFillSz > 0 && (o.state === "canceled" || Date.now() - p.ts > CFG.exit.orderTimeoutSec * 1000))) {
          if (o.state === "live" || o.state === "partially_filled") { try { await cancelOrder(atk, id, p.ordId); } catch { /* */ } }
          const entry = o.avgPx || p.px;
          const base = id.split("-")[0]!;
          const qty = (o.accFillSz || p.sz) + (o.feeCcy === base ? o.fee : 0);   // OKX alış komisyonunu coin cinsinden keser (fee negatif)
          st.positions[id] = { instId: id, qty, entry, target: targetPrice(entry, p.target, CFG.exit.targetMinPct), sl: p.sl, openedTs: Date.now(), openedBucket: Math.floor(Date.now() / BAR_MS), reason: p.reason };
          delete st.pending[id];
          log("fill", `${id}: alındı ${qty} @${entry} | hedef ${st.positions[id]!.target.toFixed(6)} | SL ${p.sl} (borsada)`, { reason: p.reason });
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
          st.closed.push({ instId: id, entry: p.entry, exit: p.sl, qty: p.qty, pnl: (p.sl - p.entry) * p.qty, why: "SL", ts: Date.now() });
          st.cooldown[id] = Math.floor(Date.now() / BAR_MS); delete st.positions[id];
          log("stop", `${id}: borsa stopu tetiklendi (~@${p.sl})`, { entry: p.entry }); continue;
        }
        const px = await getLast(atk, id);
        if (px >= p.target) await closePosition(id, p, "hedef");
      }
      // gün sonu ve fren
      if (minutes >= toMin(CFG.session.flat)) {
        if (Object.keys(st.positions).length || Object.keys(st.pending).length) { await flattenAll("gün sonu"); log("flat", `${hm}: zorunlu nakit tamam. Gün getirisi ${((st.equity / st.dayStartEquity - 1) * 100).toFixed(2)}%`); }
      } else if (!st.halted && dailyStopHit(st.equity, st.dayStartEquity, CFG.risk)) {
        st.halted = true; await flattenAll("gün freni");
        log("halt", `GÜN FRENİ: özkaynak ${st.equity.toFixed(2)} (${((st.equity / st.dayStartEquity - 1) * 100).toFixed(2)}%). Bugün yeni işlem yok.`);
      }
      // mum kapanışı
      const bucket = Math.floor(Date.now() / BAR_MS);
      if (bucket > st.lastBucket && Date.now() - bucket * BAR_MS > 20_000) {
        st.lastBucket = bucket; saveState(st);
        if (minutes >= toMin(CFG.session.start) && minutes < toMin(CFG.session.flat)) await onBarClose();
        else log("info", `${hm}: seans dışı, sadece izleme`);
      }
      if (minutes % 15 === 0) log("snapshot", `özkaynak ${st.equity.toFixed(2)} USDT (${((st.equity / st.dayStartEquity - 1) * 100).toFixed(2)}%) | açık ${Object.keys(st.positions).length} | bekleyen ${Object.keys(st.pending).length} | işlem ${st.tradesToday} | MCP çağrı ${atk.calls} hata ${atk.errors}`);
      if (minutes % 15 === 0) { const a = await anchorFlush(); if (a) log("info", `X Layer denetim izi: ${a.n} karar → ${a.root.slice(0, 18)}… ${a.url}`); }
    } catch (e) {
      log("error", `tick: ${(e as Error).message?.slice(0, 200)}`);
    }
    saveState(st);
  }

  async function onBarClose() {
    const { hm } = trNow();
    if (st.halted) { log("info", `${hm}: fren aktif, tarama yok`); return; }
    if (Date.now() - universeTs > CFG.universe.refreshMin * 60_000) { try { universe = await getUniverse(atk); inst = await getInstruments(atk); universeTs = Date.now(); } catch { /* eski evren */ } }
    if (Date.now() - smartTs > 15 * 60_000) { smart = await getSmartMoney(atk); smartTs = Date.now(); }

    const btc = await getCandles(atk, "BTC-USDT", 40);
    const gate = btcGate(btc, CFG.gate.btcBars, CFG.gate.btcMinRetPct);
    const slots = canOpen({ equity: st.equity, dayStartEquity: st.dayStartEquity, openPositions: Object.keys(st.positions).length + Object.keys(st.pending).length, tradesToday: st.tradesToday, halted: st.halted }, CFG.risk);
    const bucket = Math.floor(Date.now() / BAR_MS);
    const sStart = sessionStartTs();

    // tarama (5 paralel)
    const raw: { t: Ticker; sweep: NonNullable<ReturnType<typeof detectSweep>>; rs: number; range: number }[] = [];
    const skipped: string[] = [];
    const queue = universe.filter((t) => !st.positions[t.instId] && !st.pending[t.instId]);
    let idx = 0;
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (idx < queue.length) {
        const t = queue[idx++]!;
        try {
          const bars = await getCandles(atk, t.instId, 40);
          const sweep = detectSweep(bars, CFG.entry.lookback, CFG.entry.minDepthPct);
          if (!sweep) continue;
          const sigTs = bars[bars.length - 1]!.ts;
          if (st.seen[t.instId] === sigTs) continue;   // aynı mum ikinci kez değerlendirilmez
          st.seen[t.instId] = sigTs;
          const rs = relStrength(bars, btc, CFG.entry.rsBars);
          if (rs > CFG.entry.maxRs4hPct) { skipped.push(`${t.instId} (RS ${rs.toFixed(1)}% kovalama)`); continue; }
          if ((st.cooldown[t.instId] ?? -999) > bucket - CFG.risk.cooldownBars) { skipped.push(`${t.instId} (cooldown)`); continue; }
          raw.push({ t, sweep, rs, range: dayRangePct(bars, sStart) });
        } catch (e) { skipped.push(`${t.instId} (veri: ${(e as Error).message?.slice(0, 40)})`); }
      }
    }));
    raw.sort((a, b) => b.sweep.depthPct - a.sweep.depthPct);
    last.scan = `${hm}: ${raw.length} aday: ${raw.map((r) => `${r.t.instId} (derinlik ${r.sweep.depthPct.toFixed(2)}%)`).join(", ") || "yok"}`;
    last.gate = `Kapı ${gate.open ? "AÇIK" : "KAPALI"} — BTC 4h ${gate.retPct.toFixed(2)}% (${hm})`;
    log("scan", `${hm}: BTC 4h ${gate.retPct.toFixed(2)}% → kapı ${gate.open ? "AÇIK" : "KAPALI"} | ${universe.length} parite tarandı | ${raw.length} süpürme adayı${skipped.length ? " | elenen " + skipped.length : ""}`,
      { candidates: raw.map((r) => `${r.t.instId} d${r.sweep.depthPct.toFixed(2)}`), skipped: skipped.slice(0, 12) });

    if (!gate.open) { log("gate", `KAPI KAPALI: BTC 4 saatte ${gate.retPct.toFixed(2)}%. ${raw.length} aday reddedildi, nakitte bekliyorum.`, { reason: "BTC düşerken long-only spotta risk bütçesi sıfır" }); return; }
    if (!raw.length) return;
    if (!slots.ok) { log("reject", `${raw.length} aday var ama giriş yok: ${slots.why}`); return; }
    const freeSlots = CFG.risk.maxPositions - Object.keys(st.positions).length - Object.keys(st.pending).length;

    // zenginleştirme (en derin 6)
    const top = raw.slice(0, 6);
    const cands: Candidate[] = await Promise.all(top.map(async (r) => {
      let bookImb = 1; let news: string[] = [];
      try { const bk = await getBook(atk, r.t.instId, 20); bookImb = bookImbalance(bk.bids, bk.asks, 1.0); } catch { /* */ }
      news = await getNews(atk, r.t.instId.split("-")[0]!);
      return { instId: r.t.instId, close: r.sweep.close, depthPct: r.sweep.depthPct, mid: r.sweep.mid, rs4h: r.rs, dayRangePct: r.range, volUsd: r.t.volUsd, bookImb, smart: smart.get(r.t.instId.split("-")[0]!), news };
    }));

    const d = await decide(cands, freeSlots, { btcRetPct: gate.retPct, equity: st.equity, tr: hm });
    last.llm = [`Seçici (${d.provider}): ${d.note}`, ...d.picks.map((p) => `✅ ${p.instId}: ${p.reason}`), ...d.rejects.map((p) => `⛔ ${p.instId}: ${p.reason}`)].join(String.fromCharCode(10));
    log("llm", `${d.provider}: ${d.picks.length} seçim, ${d.rejects.length} ret. ${d.note}`, {
      picks: d.picks.map((p) => `${p.instId}: ${p.reason}`), rejects: d.rejects.map((p) => `${p.instId}: ${p.reason}`),
    });
    for (const rj of d.rejects) log("reject", `${rj.instId}: ${rj.reason}`);

    for (const pick of d.picks) {
      const c = cands.find((x) => x.instId === pick.instId)!; const i = inst.get(c.instId);
      if (!i) { log("reject", `${c.instId}: enstrüman bilgisi yok`); continue; }
      const notional = positionNotional(st.equity, CFG.risk);
      const px = roundPrice(c.close, i.tickSz);
      const sz = roundSize(notional / px, i.lotSz, i.minSz);
      if (sz <= 0) { log("reject", `${c.instId}: ${notional.toFixed(2)} USDT minimum lotun altında (minSz ${i.minSz})`); continue; }
      const sl = roundPrice(stopPrice(px, CFG.risk), i.tickSz);
      try {
        const ordId = await placeLimitBuy(atk, { instId: c.instId, px: String(px), sz: String(sz), slPx: String(sl), clOrdId: `ag${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 32) });
        st.pending[c.instId] = { instId: c.instId, ordId, px, sz, target: c.mid, sl, ts: Date.now(), reason: pick.reason };
        st.tradesToday++;
        log("entry", `${c.instId}: limit alış ${sz} @${px} (${(sz * px).toFixed(2)} USDT) | SL ${sl} borsada | hedef ${targetPrice(px, c.mid, CFG.exit.targetMinPct).toFixed(6)}`, { reason: pick.reason, depth: c.depthPct, book: c.bookImb });
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
