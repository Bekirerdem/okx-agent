// Risk motoru: saf fonksiyonlar. LLM'in erişemediği kafes.
export type RiskCfg = {
  riskPct: number; slPct: number; posCapPct: number; maxPositions: number;
  maxTradesPerDay: number; dailyStopPct: number; cooldownBars: number;
};

export type RiskState = {
  equity: number;            // anlık özkaynak (USDT)
  dayStartEquity: number;
  openPositions: number;
  tradesToday: number;
  halted: boolean;
};

/** Pozisyon büyüklüğü (USDT): risk/stop ile tavanın küçüğü. */
export function positionNotional(equity: number, cfg: RiskCfg): number {
  const byRisk = (equity * cfg.riskPct / 100) / (cfg.slPct / 100);
  const byCap = equity * cfg.posCapPct / 100;
  return Math.max(0, Math.min(byRisk, byCap));
}

/** Yeni giriş izni ve gerekçe. */
export function canOpen(s: RiskState, cfg: RiskCfg): { ok: boolean; why: string } {
  if (s.halted) return { ok: false, why: "gün freni aktif" };
  if (s.openPositions >= cfg.maxPositions) return { ok: false, why: `pozisyon tavanı (${cfg.maxPositions})` };
  if (s.tradesToday >= cfg.maxTradesPerDay) return { ok: false, why: `günlük işlem tavanı (${cfg.maxTradesPerDay})` };
  return { ok: true, why: "" };
}

/** Gün freni: özkaynak gün başına göre eşik altına indi mi. */
export function dailyStopHit(equityNow: number, dayStartEquity: number, cfg: RiskCfg): boolean {
  if (dayStartEquity <= 0) return false;
  return (equityNow / dayStartEquity - 1) * 100 <= cfg.dailyStopPct;
}

/** Stop fiyatı. */
export function stopPrice(entry: number, cfg: RiskCfg): number {
  return entry * (1 - cfg.slPct / 100);
}

/** Borsa lot kurallarına yuvarla; minSz altındaysa 0 döner. */
export function roundSize(qty: number, lotSz: number, minSz: number): number {
  if (lotSz <= 0) return qty >= minSz ? qty : 0;
  const steps = Math.floor(qty / lotSz + 1e-9);
  const q = Number((steps * lotSz).toFixed(decimalsOf(lotSz)));
  return q >= minSz ? q : 0;
}

/** Fiyatı tick'e yuvarla (aşağı). */
export function roundPrice(px: number, tickSz: number): number {
  if (tickSz <= 0) return px;
  return Number((Math.floor(px / tickSz + 1e-9) * tickSz).toFixed(decimalsOf(tickSz)));
}

export function decimalsOf(x: number): number {
  const s = x.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.split(".")[1]!.length : 0;
}
