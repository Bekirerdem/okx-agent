// Gölge bot: "kırılım kovalayan" naif strateji, emir göndermeden paralel simüle edilir.
// Amaç: disiplinin değerini canlı kanıtlamak. Kural: hacimli 15 dk kırılım (kapanış > önceki 24 mum tepesi,
// hacim > 1.5× ort) → kapanışta al, TP +2 / SL −1 / 2 saat zaman stopu, komisyon %0,2. Pozisyon = özkaynağın %12,5'i.
import type { Bar } from "./signals";

export type ShadowPos = { instId: string; entry: number; openedTs: number; notional: number };
export type ShadowState = { open: Record<string, ShadowPos>; closed: { instId: string; entry: number; exit: number; pnlPct: number; why: string; ts: number }[]; pnlUsdt: number; trades: number; wins: number };

export const emptyShadow = (): ShadowState => ({ open: {}, closed: [], pnlUsdt: 0, trades: 0, wins: 0 });

const FEE = 0.2, TP = 2.0, SL = 1.0, TIME_MS = 2 * 3600_000, NOTIONAL_PCT = 12.5, MAXPOS = 3;

/** Naif kırılım sinyali: son kapanmış mum. */
export function detectBreakout(bars: Bar[], lookback = 24, volMult = 1.5): boolean {
  if (bars.length < lookback + 1) return false;
  const last = bars[bars.length - 1]!;
  const prev = bars.slice(bars.length - 1 - lookback, bars.length - 1);
  const ref = Math.max(...prev.map((b) => b.c));
  const avgV = prev.reduce((s, b) => s + b.v, 0) / prev.length;
  return last.c > ref && last.v > volMult * avgV;
}

/** Her mum kapanışında: açık gölge pozisyonları son mumun h/l'siyle güncelle, yeni kırılımları aç. */
export function stepShadow(s: ShadowState, instId: string, bars: Bar[], equity: number, now: number): ShadowState {
  const last = bars[bars.length - 1];
  if (!last) return s;
  const p = s.open[instId];
  if (p) {
    let exit: number | null = null, why = "";
    if (last.l <= p.entry * (1 - SL / 100)) { exit = p.entry * (1 - SL / 100); why = "SL"; }
    else if (last.h >= p.entry * (1 + TP / 100)) { exit = p.entry * (1 + TP / 100); why = "TP"; }
    else if (now - p.openedTs >= TIME_MS) { exit = last.c; why = "zaman"; }
    if (exit !== null) {
      const pnlPct = (exit / p.entry - 1) * 100 - FEE;
      s.pnlUsdt += p.notional * pnlPct / 100; s.wins += pnlPct > 0 ? 1 : 0;
      s.closed.push({ instId, entry: p.entry, exit, pnlPct, why, ts: now });
      delete s.open[instId];
    }
    return s;
  }
  if (Object.keys(s.open).length < MAXPOS && detectBreakout(bars)) {
    s.open[instId] = { instId, entry: last.c, openedTs: now, notional: equity * NOTIONAL_PCT / 100 };
    s.trades++;
  }
  return s;
}

/** Gün sonu / fren: hepsini son fiyattan kapat. */
export function flattenShadow(s: ShadowState, lastPx: Record<string, number>, now: number): ShadowState {
  for (const [id, p] of Object.entries(s.open)) {
    const exit = lastPx[id] ?? p.entry; const pnlPct = (exit / p.entry - 1) * 100 - FEE;
    s.pnlUsdt += p.notional * pnlPct / 100; s.wins += pnlPct > 0 ? 1 : 0;
    s.closed.push({ instId: id, entry: p.entry, exit, pnlPct, why: "gün sonu", ts: now }); delete s.open[id];
  }
  return s;
}

export function shadowSummary(s: ShadowState, dayStart: number): string {
  const pct = dayStart ? (s.pnlUsdt / dayStart) * 100 : 0;
  return `kovalayan gölge bot: ${s.trades} işlem, ${s.wins} kazanan, açık ${Object.keys(s.open).length}, PnL ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}
