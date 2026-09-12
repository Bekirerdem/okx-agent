// Saf sinyal fonksiyonları. Yan etkisiz, test edilebilir.
export type Bar = { ts: number; o: number; h: number; l: number; c: number; v: number };

export type Sweep = {
  depthPct: number;   // dibin altına inme derinliği (%)
  lo: number;         // son N mumun en düşüğü (süpürülen seviye)
  hi: number;         // son N mumun en yükseği
  mid: number;        // aralık ortası (hedef adayı)
  close: number;      // sinyal mumu kapanışı (giriş fiyatı adayı)
};

/** Dip süpürme + içeri yeşil kapanış. bars artan zaman sıralı, son eleman = kapanmış son mum. */
export function detectSweep(bars: Bar[], lookback = 12, minDepthPct = 0.3): Sweep | null {
  if (bars.length < lookback + 1) return null;
  const last = bars[bars.length - 1]!;
  const win = bars.slice(bars.length - 1 - lookback, bars.length - 1);
  const lo = Math.min(...win.map((b) => b.l));
  const hi = Math.max(...win.map((b) => b.h));
  if (!(last.l < lo && last.c > lo && last.c > last.o)) return null;
  const depthPct = ((lo - last.l) / lo) * 100;
  if (depthPct < minDepthPct) return null;
  return { depthPct, lo, hi, mid: (lo + hi) / 2, close: last.c };
}

/** Coin'in BTC'ye göre n mumluk göreli gücü (%). */
export function relStrength(bars: Bar[], btc: Bar[], n = 16): number {
  if (bars.length < n + 1 || btc.length < n + 1) return 0;
  const a = bars[bars.length - 1]!.c / bars[bars.length - 1 - n]!.c - 1;
  const b = btc[btc.length - 1]!.c / btc[btc.length - 1 - n]!.c - 1;
  return (a - b) * 100;
}

/** BTC kapısı: son n mumluk getiri eşik altındaysa kapalı. */
export function btcGate(btc: Bar[], n = 16, minRetPct = -1.0): { open: boolean; retPct: number } {
  if (btc.length < n + 1) return { open: false, retPct: 0 };
  const retPct = (btc[btc.length - 1]!.c / btc[btc.length - 1 - n]!.c - 1) * 100;
  return { open: retPct >= minRetPct, retPct };
}

/** Gün içi aralık (%), sessionStartTs'den itibaren. */
export function dayRangePct(bars: Bar[], sessionStartTs: number): number {
  const s = bars.filter((b) => b.ts >= sessionStartTs);
  if (!s.length) return 0;
  const o = s[0]!.o;
  return ((Math.max(...s.map((b) => b.h)) - Math.min(...s.map((b) => b.l))) / o) * 100;
}

/** Hedef: aralık ortası, ama en az giriş + minPct. */
export function targetPrice(entry: number, mid: number, minPct = 0.3): number {
  return Math.max(mid, entry * (1 + minPct / 100));
}

/* ---------- Teknik bağlam: Karar katmanına verilir, tetik DEĞİLDİR (26 haftada tetik olarak hepsi eksi) ---------- */

export function ema(vals: number[], n: number): number[] {
  if (!vals.length) return [];
  const k = 2 / (n + 1); const out = [vals[0]!];
  for (let i = 1; i < vals.length; i++) out.push(out[i - 1]! + k * (vals[i]! - out[i - 1]!));
  return out;
}

export function rsi(vals: number[], n = 14): number {
  if (vals.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = vals[i]! - vals[i - 1]!; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < vals.length; i++) {
    const d = vals[i]! - vals[i - 1]!;
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

/** ATR'nin fiyata oranı (%). */
export function atrPct(bars: Bar[], n = 14): number {
  if (bars.length < n + 1) return 0;
  const trs: number[] = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i]!, p = bars[i - 1]!;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  return (trs.reduce((s, x) => s + x, 0) / n) / bars[bars.length - 1]!.c * 100;
}

/** Oturum VWAP'ına uzaklık (%): + üstünde, − altında. */
export function vwapDistPct(bars: Bar[], sessionStartTs: number): number {
  const s = bars.filter((b) => b.ts >= sessionStartTs);
  if (!s.length) return 0;
  let pv = 0, vv = 0;
  for (const b of s) { pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v; }
  if (!vv) return 0;
  return (s[s.length - 1]!.c / (pv / vv) - 1) * 100;
}

/** Son mum hacmi / önceki n mum ortalaması. */
export function volRatio(bars: Bar[], n = 24): number {
  if (bars.length < n + 1) return 1;
  const prev = bars.slice(bars.length - 1 - n, bars.length - 1);
  const avg = prev.reduce((s, b) => s + b.v, 0) / n;
  return avg ? bars[bars.length - 1]!.v / avg : 1;
}

export type Ta = { rsi: number; trend: "yukarı" | "aşağı" | "yatay"; atrPct: number; vwapDist: number; volRatio: number };

export function technicalContext(bars: Bar[], sessionStartTs: number): Ta {
  const c = bars.map((b) => b.c);
  const e20 = ema(c, 20), e50 = ema(c, 50);
  const a = e20[e20.length - 1] ?? 0, b = e50[e50.length - 1] ?? 0;
  const diff = b ? (a / b - 1) * 100 : 0;
  return {
    rsi: +rsi(c, 14).toFixed(1),
    trend: diff > 0.15 ? "yukarı" : diff < -0.15 ? "aşağı" : "yatay",
    atrPct: +atrPct(bars, 14).toFixed(2),
    vwapDist: +vwapDistPct(bars, sessionStartTs).toFixed(2),
    volRatio: +volRatio(bars, 24).toFixed(2),
  };
}

/** Emir defteri alış/satış derinlik oranı (±bandPct). >1 alıcı ağır. */
export function bookImbalance(bids: [number, number][], asks: [number, number][], bandPct = 1.0): number {
  if (!bids.length || !asks.length) return 1;
  const midPx = (bids[0]![0] + asks[0]![0]) / 2;
  const bidQ = bids.filter(([p]) => p >= midPx * (1 - bandPct / 100)).reduce((s, [p, q]) => s + p * q, 0);
  const askQ = asks.filter(([p]) => p <= midPx * (1 + bandPct / 100)).reduce((s, [p, q]) => s + p * q, 0);
  return askQ > 0 ? bidQ / askQ : 9;
}
