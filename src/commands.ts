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

const HELP = `Komutlar:
/durum — özkaynak, kapı, pozisyon, işlem sayısı
/pozisyon — açık pozisyonlar ve anlık kâr/zarar
/adaylar — son taramanın adayları ve Seçici'nin kararı
/neden COIN — o coin hakkında günlükteki son gerekçeler
/kurallar — risk kafesi (sabit, LLM erişemez)
/rapor — anlık performans dökümü
/dur — acil fren: her şeyi sat, yeni işlem yok
/devam — freni kaldır
/zincir — X Layer denetim izi durumu`;

function journalLines(): any[] {
  if (!existsSync(CFG.paths.journal)) return [];
  return readFileSync(CFG.paths.journal, "utf-8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function handle(text: string, ctx: CmdCtx): Promise<string> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = (rest[0] ?? "").toUpperCase().replace("-USDT", "");
  const s = ctx.snapshot();
  const pct = s.dayStart ? ((s.equity / s.dayStart - 1) * 100).toFixed(2) : "0.00";
  switch ((cmd ?? "").toLowerCase().split("@")[0]) {
    case "/start": case "/yardim": case "/yardım": case "/help": return HELP;
    case "/durum":
      return `📊 Özkaynak ${s.equity.toFixed(2)} USDT (${pct}%)\n${s.lastGate || "kapı: henüz tarama yok"}\nAçık ${s.positions.length} · bekleyen ${s.pending.length} · işlem ${s.trades}/${CFG.risk.maxTradesPerDay}\nFren: ${s.halted ? "AKTİF" : "yok"}\nMCP çağrı ${s.mcpCalls}, hata ${s.mcpErrors}\nSon tarama: ${s.lastScan || "-"}`;
    case "/pozisyon": {
      if (!s.positions.length && !s.pending.length) return "Açık pozisyon yok. Nakitteyim.";
      const rows: string[] = [];
      for (const p of s.positions) {
        const px = await ctx.lastPrice(p.instId).catch(() => 0);
        const u = px ? ((px / p.entry - 1) * 100).toFixed(2) : "?";
        rows.push(`• ${p.instId}: ${p.qty} @${p.entry} → şimdi ${px || "?"} (${u}%) | hedef ${p.target} | SL ${p.sl}\n  gerekçe: ${p.reason}`);
      }
      for (const p of s.pending) rows.push(`• ${p.instId}: bekleyen limit ${p.sz} @${p.px}`);
      return rows.join("\n");
    }
    case "/adaylar": return `${s.lastScan || "henüz tarama yok"}\n\n${s.lastLlm || "Seçici henüz karar vermedi"}`;
    case "/neden": {
      if (!arg) return "Kullanım: /neden COIN (örn. /neden ZEC)";
      const hits = journalLines().filter((e) => JSON.stringify(e).toUpperCase().includes(arg + "-USDT")).slice(-4);
      if (!hits.length) return `${arg} hakkında günlükte kayıt yok.`;
      return hits.map((e) => `${e.ts.slice(11, 16)}Z ${e.role}·${e.kind}: ${e.msg}${e.data?.reason ? "\n  → " + e.data.reason : ""}`).join("\n");
    }
    case "/kurallar":
      return `🔒 Risk kafesi (kod, LLM erişemez)\nİşlem başı risk %${CFG.risk.riskPct} · stop %${CFG.risk.slPct} borsada · pozisyon tavanı %${CFG.risk.posCapPct}\nAynı anda ≤${CFG.risk.maxPositions} pozisyon · günde ≤${CFG.risk.maxTradesPerDay} işlem · gün freni ${CFG.risk.dailyStopPct}%\nBTC kapısı: 4h getiri < ${CFG.gate.btcMinRetPct}% → giriş yok\nGiriş: dip süpürme ≥%${CFG.entry.minDepthPct} + içeri yeşil kapanış · RS4h ≤ +%${CFG.entry.maxRs4hPct}\nÇıkış: aralık ortası (≥ +%${CFG.exit.targetMinPct}) · ${CFG.session.flat} zorunlu nakit`;
    case "/rapor": return ctx.report();
    case "/dur": await ctx.halt("Telegram /dur"); return "⏸️ Fren çekildi: pozisyonlar satıldı, yeni işlem yok. /devam ile açılır.";
    case "/devam": ctx.resume(); return "▶️ Fren kaldırıldı. Bir sonraki mum kapanışında tarama sürer.";
    case "/zincir": return `⛓️ X Layer denetim izi: ${anchorStatus()}`;
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
          if (m.text.startsWith("/")) { await telegram(await handle(m.text, ctx)); log("info", `komut: ${m.text}`); }
          else {
            const s = ctx.snapshot();
            const recent = journalLines().slice(-40).map((e) => `${e.ts.slice(11, 19)}Z ${e.role}·${e.kind}: ${e.msg}${e.data?.reason ? " → " + e.data.reason : ""}`).join("
");
            const context = `DURUM: özkaynak ${s.equity.toFixed(2)} USDT, gün başı ${s.dayStart.toFixed(2)}, açık ${s.positions.length}, bekleyen ${s.pending.length}, işlem ${s.trades}, fren ${s.halted ? "aktif" : "yok"}.
${s.lastGate}
SON TARAMA: ${s.lastScan}
SEÇİCİ: ${s.lastLlm}
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
