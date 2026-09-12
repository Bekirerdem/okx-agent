// X Layer denetim izi: karar günlüğü toplu hash'lenir, 0 değerli işlemle zincire yazılır.
// Günlük sonradan değiştirilemez: jüri zincirdeki hash ile dosyadaki batch'i karşılaştırabilir.
// Anahtar/gaz yoksa modül kendini kapatır; ajan etkilenmez.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { createWalletClient, createPublicClient, http, defineChain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.ANCHOR_RPC ?? "https://testrpc.xlayer.tech";
const CHAIN_ID = Number(process.env.ANCHOR_CHAIN_ID ?? 1952);
const EXPLORER = process.env.ANCHOR_EXPLORER ?? "https://www.oklink.com/xlayer-test";
const PK = (process.env.ANCHOR_PK ?? "") as Hex;

const chain = defineChain({
  id: CHAIN_ID, name: "X Layer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } }, blockExplorers: { default: { name: "OKLink", url: EXPLORER } },
});

let batch: string[] = [];
let seq = 0;
let disabled = !PK;
let lastErr = "";

export function anchorEnabled(): boolean { return !disabled; }
export function anchorAddress(): string { return PK ? privateKeyToAccount(PK).address : ""; }

/** Batch'e satır ekle (JSON string). */
export function queue(line: string): void { if (!disabled) batch.push(line); }

/** Batch'i hash'le, zincire yaz, yerel kanıt dosyasına ekle. Döner: {txHash, root, n} ya da null. */
export async function flush(): Promise<{ txHash: string; root: string; n: number; url: string } | null> {
  if (disabled || !batch.length) return null;
  const lines = batch; batch = [];
  const root = "0x" + createHash("sha256").update(lines.join("\n")).digest("hex");
  try {
    const account = privateKeyToAccount(PK);
    const wallet = createWalletClient({ account, chain, transport: http(RPC, { timeout: 20_000 }) });
    const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 20_000 }) });
    const bal = await pub.getBalance({ address: account.address });
    if (bal === 0n) { disabled = true; lastErr = "gaz yok"; batch = lines.concat(batch); return null; }
    const txHash = await wallet.sendTransaction({ to: account.address, value: 0n, data: root as Hex });
    seq++;
    mkdirSync("state", { recursive: true });
    appendFileSync("state/anchors.jsonl", JSON.stringify({ seq, ts: new Date().toISOString(), n: lines.length, root, txHash, chainId: CHAIN_ID }) + "\n");
    appendFileSync(`state/anchor-batch-${seq}.jsonl`, lines.join("\n") + "\n");
    return { txHash, root, n: lines.length, url: `${EXPLORER}/tx/${txHash}` };
  } catch (e) {
    lastErr = (e as Error).message?.slice(0, 160) ?? String(e);
    batch = lines.concat(batch);          // bir sonraki denemede tekrar
    if (batch.length > 500) batch = batch.slice(-500);
    return null;
  }
}
export function anchorStatus(): string { return disabled ? `kapalı (${lastErr || "anahtar yok"})` : `açık, bekleyen ${batch.length}, yazılan ${seq}`; }
