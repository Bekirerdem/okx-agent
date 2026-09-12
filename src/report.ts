// Gün sonu performans dökümü: günlükteki snapshot ve kapanan işlemlerden.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CFG } from "./config";

type J = { ts: string; kind: string; msg: string; data?: any };
export function buildReport(): string {
const lines: J[] = existsSync(CFG.paths.journal) ? readFileSync(CFG.paths.journal, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const st = existsSync(CFG.paths.state) ? JSON.parse(readFileSync(CFG.paths.state, "utf-8")) : null;

const snaps = lines.filter((l) => l.kind === "snapshot").map((l) => ({ ts: l.ts, eq: Number((l.msg.match(/özkaynak ([\d.]+)/) ?? [])[1]) })).filter((s) => s.eq > 0);
const start = st?.dayStartEquity ?? snaps[0]?.eq ?? 0;
const end = st?.equity ?? snaps.at(-1)?.eq ?? start;
let peak = start, maxDd = 0;
for (const s of snaps) { peak = Math.max(peak, s.eq); maxDd = Math.min(maxDd, (s.eq / peak - 1) * 100); }
const rets = snaps.slice(1).map((s, i) => s.eq / snaps[i]!.eq - 1);
const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)) : 0;
const sharpe = sd ? (mean / sd) * Math.sqrt(rets.length) : 0;
const closed: any[] = st?.closed ?? [];
const wins = closed.filter((c) => c.pnl > 0).length;
const count = (k: string) => lines.filter((l) => l.kind === k).length;

const md = `# Performans dökümü — ${st?.day ?? ""}

| Metrik | Değer |
|---|---|
| Başlangıç özkaynak | ${start.toFixed(2)} USDT |
| Bitiş özkaynak | ${end.toFixed(2)} USDT |
| Getiri | ${start ? ((end / start - 1) * 100).toFixed(2) : "0"}% |
| Max drawdown | ${maxDd.toFixed(2)}% |
| Risk-ayarlı (snapshot Sharpe) | ${sharpe.toFixed(2)} |
| Kapanan işlem | ${closed.length} (kazanan ${wins}) |
| Giriş / iptal / hedef / stop | ${count("entry")} / ${count("cancel")} / ${count("exit")} / ${count("stop")} |
| LLM kararı / ret | ${count("llm")} / ${count("reject")} |
| Kapı kapalı sayısı | ${count("gate")} |
| Hata | ${count("error")} |

## İşlemler
${closed.length ? closed.map((c) => `- ${c.instId}: ${c.qty} @${c.entry} → ${c.exit} (${c.why}) pnl ${c.pnl >= 0 ? "+" : ""}${c.pnl.toFixed(3)} USDT`).join("\n") : "- işlem yok"}

## Özkaynak eğrisi
${snaps.map((s) => `- ${s.ts.slice(11, 16)}Z ${s.eq.toFixed(2)}`).join("\n")}
`;
writeFileSync("state/report.md", md);
return md;
}
if (import.meta.main) console.log(buildReport());
