// Tüm ayarlar tek yerde. Risk kafesi buradaki sayılardır; LLM bunlara erişemez.
export const CFG = {
  profile: process.env.OKX_PROFILE ?? "live",
  modules: "market,spot,account,news,smartmoney",
  dryRun: process.argv.includes("--dry-run"),
  once: process.argv.includes("--once"),
  tz: "Europe/Istanbul",
  session: { start: "09:00", flat: "19:15", end: "19:30" },
  universe: {
    quote: "USDT",
    minVolUsd: 3_000_000,
    max: 50,
    exclude: ["USDC", "USDG", "DAI", "XAUT", "PAXG", "TUSD", "FDUSD", "USDE", "EUR", "USDT", "BTC"],
    refreshMin: 60,
  },
  gate: { btcBars: 16, btcMinRetPct: -1.0 },
  entry: { lookback: 12, minDepthPct: 0.3, maxRs4hPct: 2.0, rsBars: 16 },
  risk: {
    riskPct: 0.5,        // özkaynağın %'si, işlem başına
    slPct: 4.0,          // felaket stopu, borsada ekli
    posCapPct: 12.5,     // tek pozisyon tavanı
    maxPositions: 3,
    maxTradesPerDay: 10,
    dailyStopPct: -2.0,  // gün freni
    cooldownBars: 8,
  },
  exit: { targetMinPct: 0.3, orderTimeoutSec: 120 },
  llm: { provider: process.env.LLM_PROVIDER ?? "claude", timeoutMs: 75_000 },
  tickMs: 60_000,
  paths: process.argv.includes("--dry-run")
    ? { state: "state/state.dry.json", journal: "state/journal.dry.jsonl", md: "state/journal.dry.md" }
    : { state: "state/state.json", journal: "state/journal.jsonl", md: "state/journal.md" },
} as const;
