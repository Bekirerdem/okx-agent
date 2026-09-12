// X Layer denetim izi: karar günlüğü toplu hash'lenir, 0 değerli işlemle zincire yazılır.
// Günlük sonradan değiştirilemez: jüri zincirdeki hash ile dosyadaki batch'i karşılaştırabilir (scripts/verify.ts).
// Anahtar/gaz yoksa modül kendini kapatır; ajan etkilenmez.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createWalletClient, createPublicClient, http, defineChain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.ANCHOR_RPC ?? "https://testrpc.xlayer.tech";
const CHAIN_ID = Number(process.env.ANCHOR_CHAIN_ID ?? 1952);
const EXPLORER = process.env.ANCHOR_EXPLORER ?? "https://www.oklink.com/xlayer-test";
const PK = (process.env.ANCHOR_PK ?? "") as Hex;
const LF = String.fromCharCode(10);

const chain = defineChain({
  id: CHAIN_ID, name: "X Layer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } }, blockExplorers: { default: { name: "OKLink", url: EXPLORER } },
});

function existingCount(): number {
  try {
    if (!existsSync("state/anchors.jsonl")) return 0;
    return readFileSync("state/anchors.jsonl", "utf-8").split(LF).filter((l) => l.trim()).length;
  } catch { return 0; }
}

// Kuyruk DİSKTE tutulur (state/anchor-queue.jsonl): yeniden başlatma ve kesinti batch'i kaybettirmez.
const QUEUE = "state/anchor-queue.jsonl";
function readQueue(): string[] {
  try { return existsSync(QUEUE) ? readFileSync(QUEUE, "utf-8").split(LF).filter((l) => l.trim()) : []; } catch { return []; }
}
let seq = existingCount();          // sıra numarası kaldığı yerden devam eder
let disabled = !PK;
let lastErr = "";
export let lastFlushTs = 0;   // açılışta bekleyen kuyruk varsa ilk tick'te yazılır

export function anchorEnabled(): boolean { return !disabled; }
export function anchorAddress(): string { return PK ? privateKeyToAccount(PK).address : ""; }
export function pendingCount(): number { return readQueue().length; }

/** Batch'e satır ekle (JSON string) — diske. */
export function queue(line: string): void {
  if (disabled) return;
  try { mkdirSync("state", { recursive: true }); appendFileSync(QUEUE, line.replace(/[\r\n]+/g, " ") + LF); } catch { /* */ }
}

/** Batch'i hash'le, zincire yaz, yerel kanıt dosyasına ekle. Döner: {txHash, root, n, url} ya da null. */
export async function flush(): Promise<{ txHash: string; root: string; n: number; url: string } | null> {
  if (disabled) return null;
  const lines = readQueue();
  if (!lines.length) return null;
  const root = "0x" + createHash("sha256").update(lines.join(LF)).digest("hex");
  try {
    const account = privateKeyToAccount(PK);
    const wallet = createWalletClient({ account, chain, transport: http(RPC, { timeout: 20_000 }) });
    const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 20_000 }) });
    const bal = await pub.getBalance({ address: account.address });
    if (bal === 0n) { disabled = true; lastErr = "gaz yok"; return null; }
    const txHash = await wallet.sendTransaction({ to: account.address, value: 0n, data: root as Hex });
    seq++;
    mkdirSync("state", { recursive: true });
    appendFileSync("state/anchors.jsonl", JSON.stringify({ seq, ts: new Date().toISOString(), n: lines.length, root, txHash, chainId: CHAIN_ID }) + LF);
    writeFileSync(`state/anchor-batch-${seq}.jsonl`, lines.join(LF) + LF);
    // yazılan satırlar kuyruktan düşer; bu arada eklenenler kalır
    const now = readQueue(); writeFileSync(QUEUE, now.slice(lines.length).join(LF) + (now.length > lines.length ? LF : ""));
    lastFlushTs = Date.now(); lastErr = "";
    return { txHash, root, n: lines.length, url: `${EXPLORER}/tx/${txHash}` };
  } catch (e) {
    lastErr = (e as Error).message?.slice(0, 160) ?? String(e);   // kuyruk diskte durur, bir sonraki denemede tekrar
    return null;
  }
}
export function anchorStatus(): string { return disabled ? `kapalı (${lastErr || "anahtar yok"})` : `açık, bekleyen ${pendingCount()}, yazılan ${seq}${lastErr ? ", son hata: " + lastErr.slice(0, 60) : ""}`; }
