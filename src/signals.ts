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

/** Emir defteri alış/satış derinlik oranı (±bandPct). >1 alıcı ağır. */
export function bookImbalance(bids: [number, number][], asks: [number, number][], bandPct = 1.0): number {
  if (!bids.length || !asks.length) return 1;
  const midPx = (bids[0]![0] + asks[0]![0]) / 2;
  const bidQ = bids.filter(([p]) => p >= midPx * (1 - bandPct / 100)).reduce((s, [p, q]) => s + p * q, 0);
  const askQ = asks.filter(([p]) => p <= midPx * (1 + bandPct / 100)).reduce((s, [p, q]) => s + p * q, 0);
  return askQ > 0 ? bidQ / askQ : 9;
}
