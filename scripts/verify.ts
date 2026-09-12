// Denetim izi doğrulama: batch dosyasını yeniden hash'le, X Layer'daki işlemin data alanıyla karşılaştır.
// Kullanım: bun run scripts/verify.ts [seq]   (seq verilmezse son kayıt)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, http, defineChain, type Hex } from "viem";

const RPC = process.env.ANCHOR_RPC ?? "https://testrpc.xlayer.tech";
const CHAIN_ID = Number(process.env.ANCHOR_CHAIN_ID ?? 1952);
const chain = defineChain({ id: CHAIN_ID, name: "X Layer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

const anchors = existsSync("state/anchors.jsonl") ? readFileSync("state/anchors.jsonl", "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
if (!anchors.length) { console.log("zincir kaydı yok"); process.exit(1); }
const seq = Number(process.argv[2] ?? anchors.at(-1)!.seq);
const a = [...anchors].reverse().find((x) => x.seq === seq);
if (!a) { console.log(`seq ${seq} bulunamadı`); process.exit(1); }
const file = `state/anchor-batch-${seq}.jsonl`;
const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
const local = "0x" + createHash("sha256").update(lines.join("\n")).digest("hex");
const pub = createPublicClient({ chain, transport: http(RPC) });
const tx = await pub.getTransaction({ hash: a.txHash as Hex });
const onchain = (tx.input ?? "0x").toLowerCase();
const ok = onchain === local.toLowerCase() && onchain === String(a.root).toLowerCase();
console.log(`batch #${seq} · ${lines.length} karar · ${a.ts}`);
console.log(`dosya hash   ${local}`);
console.log(`zincir data  ${onchain}`);
console.log(`blok ${tx.blockNumber} · https://www.oklink.com/xlayer-test/tx/${a.txHash}`);
console.log(ok ? "SONUÇ: EŞLEŞTİ — günlük değiştirilmemiş." : "SONUÇ: EŞLEŞMEDİ — günlük ya da kayıt değişmiş!");
process.exit(ok ? 0 : 2);
