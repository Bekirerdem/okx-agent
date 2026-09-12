// Tüm ayarlar tek yerde. Risk kuralları buradaki sayılardır; LLM bunlara erişemez.
export const CFG = {
  profile: process.env.OKX_PROFILE ?? "live",
  modules: "market,spot,account,news,smartmoney",
  dryRun: process.argv.includes("--dry-run"),
  once: process.argv.includes("--once"),
  tz: "Europe/Istanbul",
  session: { start: "09:00", flat: "19:15", end: "19:30" },
  universe: {
    quote: "USDT",
    minVolUsd: 1_000_000,
    max: 80,
    exclude: ["USDC", "USDG", "DAI", "XAUT", "PAXG", "TUSD", "FDUSD", "USDE", "EUR", "USDT", "BTC"],
    refreshMin: 60,
  },
  bar: "5m", barMin: 5,          // mum çözünürlüğü (09-12 14:45: ölü piyasada 15m → 5m; kurallar aynı, süreler mum sayısına çevrildi)
  gate: { btcBars: 48, btcMinRetPct: -1.0 },                              // 4 saat
  entry: { lookback: 36, minDepthPct: 0.15, maxRs4hPct: 2.0, rsBars: 48 },  // 3 saatlik dip, 4 saatlik göreli güç
  risk: {
    riskPct: 0.5,        // özkaynağın %'si, işlem başına
    slPct: 4.0,          // felaket stopu, borsada ekli
    posCapPct: 12.5,     // tek pozisyon tavanı
    maxPositions: 3,
    maxTradesPerDay: 10,
    dailyStopPct: -2.0,  // gün freni
    cooldownBars: 24,    // 2 saat (5m mum)
  },
  exit: {
    targetMinPct: 0.3,
    targetMaxPct: 1.5,     // hedef tavanı: aralık ortası uzaksa +%1,5'te al (09-12 dersi: RAY ve STORJ ikisi de +%2,1 gördü)
    lockAtPct: 1.0,        // fiyat giriş +%1'e gelince…
    lockToPct: 0.2,        // …stop girişin +%0,2 üstüne çekilir (kâr kilidi, borsada)
    orderTimeoutSec: 120,
  },
  bookMin: 0.7,            // emir defteri alış/satış oranı bunun altındaysa aday LLM'e gitmez (satıcı ağır defterde geri dönüş oynanmaz)
  llm: { provider: process.env.LLM_PROVIDER ?? "claude", timeoutMs: 75_000 },
  tickMs: 60_000,
  paths: process.argv.includes("--dry-run")
    ? { state: "state/state.dry.json", journal: "state/journal.dry.jsonl", md: "state/journal.dry.md" }
    : { state: "state/state.json", journal: "state/journal.jsonl", md: "state/journal.md" },
} as const;
