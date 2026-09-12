// Telegram komutları: ajanla iki yönlü etkileşim. Sadece TG_CHAT_ID'den gelen mesajlar işlenir.
import { existsSync, readFileSync } from "node:fs";
import { CFG } from "./config";
import { telegram, log } from "./journal";
import { anchorStatus } from "./anchor";
import { ask } from "./llm";

export type CmdCtx = {
  snapshot: () => { equity: number; dayStart: number; halted: boolean; trades: number; positions: any[]; pending: any[]; mcpCalls: number; mcpErrors: number; lastScan: string; lastGate: string; lastLlm: string };
  lastPrice: (instId: string) => Promise<number>;
  halt: (why: string) => Promise<void>;
  resume: () => void;
  report: () => string;
};

const TG = { token: process.env.TG_BOT_TOKEN ?? "", chat: process.env.TG_CHAT_ID ?? "" };
let offset = 0;

// Mod: otonom (varsayılan) | onaylı (her girişten önce sahibine sorar, süre dolarsa reddeder)
export type Mode = "otonom" | "onaylı";
let mode: Mode = "otonom";
export function getMode(): Mode { return mode; }
let pendingApproval: { resolve: (ok: boolean) => void } | null = null;
const YES = /^(evet|e|yes|ok|tamam|onay|✅)$/i, NO = /^(hayır|hayir|h|no|ret|iptal|❌)$/i;

/** Onaylı modda giriş öncesi soru. Cevap gelmezse false. */
export function askApproval(question: string, timeoutMs = 60_000): Promise<boolean> {
  return new Promise((resolve) => {
    if (pendingApproval) pendingApproval.resolve(false);
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; pendingApproval = null; clearTimeout(t); resolve(ok); };
    const t = setTimeout(() => finish(false), timeoutMs);
    pendingApproval = { resolve: finish };
    void telegram(`❓ ONAY GEREKİYOR (${Math.round(timeoutMs / 1000)} sn)\n${question}\nCevap: evet / hayır`);
  });
}

const HELP = `Komutlar:
/durum — kasa, BTC filtresi, pozisyon, işlem sayısı
/pozisyon — açık pozisyonlar ve anlık kâr/zarar
/adaylar — son taramanın adayları ve Karar katmanının gerekçesi
/neden COIN — o coin hakkında günlükteki son gerekçeler
/kurallar — risk kuralları (sabit, LLM erişemez)
/rapor — anlık performans dökümü
/dur — acil fren: her şeyi sat, yeni işlem yok
/devam — freni kaldır
/zincir — X Layer denetim izi durumu
/mod — otonom | onaylı (onaylı: her girişten önce sana sorar, 60 sn cevap yoksa reddeder)`;

const LF = String.fromCharCode(10);
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtQ = (q: number) => (q >= 100 ? q.toFixed(0) : q >= 1 ? q.toFixed(2) : q.toPrecision(3));
type Reply = string | { text: string; html: true };
const html = (text: string): Reply => ({ text, html: true });

function journalLines(): any[] {
  if (!existsSync(CFG.paths.journal)) return [];
  return readFileSync(CFG.paths.journal, "utf-8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function handle(text: string, ctx: CmdCtx): Promise<Reply> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = (rest[0] ?? "").toUpperCase().replace("-USDT", "");
  const s = ctx.snapshot();
  const pct = s.dayStart ? ((s.equity / s.dayStart - 1) * 100).toFixed(2) : "0.00";
  switch ((cmd ?? "").toLowerCase().split("@")[0]) {
    case "/start": case "/yardim": case "/yardım": case "/help": return HELP;
    case "/durum": {
      const met = (() => { try { return JSON.parse(readFileSync("state/metrics.json", "utf-8")); } catch { return null; } })();
      const hb = met ? Math.round((Date.now() - met.ts) / 1000) : -1;
      const gate = (s.lastGate.match(/filtresi (AÇIK|KAPALI)/) ?? [])[1] ?? "henüz tarama yok";
      const btc = (s.lastGate.match(/BTC 4h ([-\d.]+%)/) ?? [])[1] ?? "—";
      return html([
        `<b>Kasa</b>  ${s.equity.toFixed(2)} USDT  (${Number(pct) > 0 ? "+" : ""}${pct}%)`,
        `<b>BTC filtresi</b>  ${gate} · BTC 4h ${btc}`,
        `<b>Pozisyon</b>  ${s.positions.length} açık · ${s.pending.length} bekleyen · işlem ${s.trades}/${CFG.risk.maxTradesPerDay}`,
        `<b>Fren</b>  ${s.halted ? "AKTİF" : "yok"} · <b>Mod</b>  ${mode}`,
        `<b>Nabız</b>  ${hb >= 0 ? hb + " sn" : "?"} · MCP ${s.mcpCalls} çağrı, ${s.mcpErrors} hata`,
        met?.shadow ? `<b>Kovalayan bot</b>  ${esc(met.shadow.summary.replace("kovalayan bot: ", ""))}` : "",
        `<b>Son tarama</b>  ${esc(s.lastScan || "—")}`,
      ].filter(Boolean).join(LF));
    }
    case "/pozisyon": {
      if (!s.positions.length && !s.pending.length) return "Açık pozisyon yok. Nakitteyim.";
      const blocks: string[] = [];
      for (const p of s.positions) {
        const px = await ctx.lastPrice(p.instId).catch(() => 0);
        const u = px ? (px / p.entry - 1) * 100 : NaN;
        const usd = px ? (px - p.entry) * p.qty : NaN;
        blocks.push([
          `<b>${p.instId}</b>`,
          `adet ${fmtQ(p.qty)} · giriş ${p.entry}`,
          `şimdi ${px || "?"}  ${isNaN(u) ? "" : `(${u >= 0 ? "+" : ""}${u.toFixed(2)}% · ${usd >= 0 ? "+" : ""}${usd.toFixed(3)} USDT)`}`,
          `hedef ${p.target.toFixed(4)} (+${((p.target / p.entry - 1) * 100).toFixed(2)}%) · stop ${p.sl} (${((p.sl / p.entry - 1) * 100).toFixed(2)}%, borsada)`,
          `<i>${esc(p.reason)}</i>`,
        ].join(LF));
      }
      for (const p of s.pending) blocks.push(`<b>${p.instId}</b>${LF}bekleyen limit ${fmtQ(p.sz)} @ ${p.px}${LF}<i>${esc(p.reason)}</i>`);
      return html(blocks.join(LF + LF));
    }
    case "/adaylar": return `${s.lastScan || "henüz tarama yok"}\n\n${s.lastLlm || "Karar katmanı henüz seçim yapmadı"}`;
    case "/neden": {
      if (!arg) return "Kullanım: /neden COIN (örn. /neden ZEC)";
      const hits = journalLines().filter((e) => JSON.stringify(e).toUpperCase().includes(arg + "-USDT")).slice(-4);
      if (!hits.length) return `${arg} hakkında günlükte kayıt yok.`;
      return hits.map((e) => `${e.ts.slice(11, 16)}Z ${e.role}·${e.kind}: ${e.msg}${e.data?.reason ? "\n  → " + e.data.reason : ""}`).join("\n");
    }
    case "/kurallar":
      return `🔒 Risk kuralları (kod, LLM erişemez)\nİşlem başı risk %${CFG.risk.riskPct} · stop %${CFG.risk.slPct} borsada · pozisyon tavanı %${CFG.risk.posCapPct}\nAynı anda ≤${CFG.risk.maxPositions} pozisyon · günde ≤${CFG.risk.maxTradesPerDay} işlem · gün freni ${CFG.risk.dailyStopPct}%\nBTC filtresi: 4h getiri < ${CFG.gate.btcMinRetPct}% → giriş yok\nGiriş: dip avı ≥%${CFG.entry.minDepthPct} + içeri yeşil kapanış · RS4h ≤ +%${CFG.entry.maxRs4hPct}\nÇıkış: aralık ortası (≥ +%${CFG.exit.targetMinPct}) · ${CFG.session.flat} zorunlu nakit`;
    case "/rapor": return ctx.report();
    case "/dur": await ctx.halt("Telegram /dur"); return "⏸️ Fren çekildi: pozisyonlar satıldı, yeni işlem yok. /devam ile açılır.";
    case "/devam": ctx.resume(); return "▶️ Fren kaldırıldı. Bir sonraki mum kapanışında tarama sürer.";
    case "/zincir": return `⛓️ X Layer denetim izi: ${anchorStatus()}`;
    case "/mod": {
      const want = (rest[0] ?? "").toLowerCase();
      if (want === "onaylı" || want === "onayli") { mode = "onaylı"; log("info", "mod: ONAYLI (girişler sahibinin onayına bağlı)"); return "🤝 Onaylı mod: her girişten önce sana soracağım. 60 sn içinde evet demezsen işlem açılmaz."; }
      if (want === "otonom") { mode = "otonom"; if (pendingApproval) pendingApproval.resolve(false); log("info", "mod: OTONOM"); return "🤖 Otonom mod: kurallar içinde kendi kararımla giriyorum."; }
      return `Mod: ${mode}. Değiştirmek için /mod onaylı veya /mod otonom`;
    }
    default: return `Anlamadım: ${cmd}\n${HELP}`;
  }
}

export function startCommandLoop(ctx: CmdCtx): void {
  if (!TG.token || !TG.chat) return;
  const poll = async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TG.token}/getUpdates?timeout=20&offset=${offset}`, { signal: AbortSignal.timeout(30_000) });
      const j: any = await res.json();
      for (const u of j.result ?? []) {
        offset = u.update_id + 1;
        const m = u.message; if (!m?.text) continue;
        if (String(m.chat?.id) !== TG.chat) continue;           // yalnız sahibi
        try {
          if (pendingApproval && (YES.test(m.text.trim()) || NO.test(m.text.trim()))) {
            const ok = YES.test(m.text.trim()); pendingApproval.resolve(ok);
            await telegram(ok ? "✅ Onaylandı, emir gidiyor." : "⛔ Reddedildi, işlem açılmadı."); log("info", `onay cevabı: ${m.text}`); continue;
          }
          if (m.text.startsWith("/")) { const r = await handle(m.text, ctx); await telegram(typeof r === "string" ? r : r.text, typeof r !== "string"); log("info", `komut: ${m.text}`); }
          else {
            const s = ctx.snapshot();
            const recent = journalLines().slice(-40).map((e) => `${e.ts.slice(11, 19)}Z ${e.role}·${e.kind}: ${e.msg}${e.data?.reason ? " → " + e.data.reason : ""}`).join(String.fromCharCode(10));
            const context = `DURUM: kasa ${s.equity.toFixed(2)} USDT, gün başı ${s.dayStart.toFixed(2)}, açık ${s.positions.length}, bekleyen ${s.pending.length}, işlem ${s.trades}, fren ${s.halted ? "aktif" : "yok"}.
${s.lastGate}
SON TARAMA: ${s.lastScan}
KARAR: ${s.lastLlm}
SON GÜNLÜK:
${recent}`;
            await telegram(await ask(m.text, context)); log("info", `soru: ${m.text}`);
          }
        }
        catch (e) { await telegram(`hata: ${(e as Error).message?.slice(0, 200)}`); }
      }
    } catch { /* ağ; tekrar dene */ }
    setTimeout(poll, 1000);
  };
  void poll();
}
