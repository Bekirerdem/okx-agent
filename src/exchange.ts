// Emir katmanı. Sadece ATK MCP üzerinden. dry-run'da hiçbir emir gitmez.
import { CFG } from "./config";
import type { Atk } from "./mcp";

export type Balance = { totalEq: number; usdtAvail: number; coins: Record<string, number> };
export type OrderInfo = { state: string; avgPx: number; accFillSz: number; fee: number };

let dryId = 1000;

export async function getBalance(atk: Atk): Promise<Balance> {
  const rows: any[] = await atk.call("account_get_balance", {});
  const b = rows?.[0] ?? {};
  const coins: Record<string, number> = {};
  let usdtAvail = 0;
  for (const d of b.details ?? []) {
    coins[d.ccy] = Number(d.availBal ?? d.availEq ?? 0);
    if (d.ccy === "USDT") usdtAvail = Number(d.availBal ?? 0);
  }
  return { totalEq: Number(b.totalEq ?? 0), usdtAvail, coins };
}

/** Limit alış + borsa tarafında ekli stop (piyasa). */
export async function placeLimitBuy(atk: Atk, p: { instId: string; px: string; sz: string; slPx: string; clOrdId: string }): Promise<string> {
  if (CFG.dryRun) return `dry-${dryId++}`;
  const rows: any[] = await atk.call("spot_place_order", {
    instId: p.instId, tdMode: "cash", side: "buy", ordType: "limit", px: p.px, sz: p.sz, tgtCcy: "base_ccy",
    clOrdId: p.clOrdId, slTriggerPx: p.slPx, slOrdPx: "-1", slTriggerPxType: "last",
  });
  const r = rows?.[0] ?? rows;
  if (r?.sCode && r.sCode !== "0") throw new Error(`emir reddi ${r.sCode}: ${r.sMsg}`);
  return String(r.ordId);
}

export async function getOrder(atk: Atk, instId: string, ordId: string, dryPx?: number, drySz?: number): Promise<OrderInfo> {
  if (CFG.dryRun) return { state: "filled", avgPx: dryPx ?? 0, accFillSz: drySz ?? 0, fee: 0 };
  const rows: any[] = await atk.call("spot_get_order", { instId, ordId });
  const r = rows?.[0] ?? rows;
  return { state: String(r.state), avgPx: Number(r.avgPx || r.fillPx || 0), accFillSz: Number(r.accFillSz || 0), fee: Number(r.fee || 0) };
}

export async function cancelOrder(atk: Atk, instId: string, ordId: string): Promise<void> {
  if (CFG.dryRun) return;
  await atk.call("spot_cancel_order", { instId, ordId });
}

/** Bekleyen algo (ekli SL) emirlerini iptal et, sonra piyasa sat. */
export async function sellMarket(atk: Atk, instId: string, sz: string): Promise<string> {
  if (CFG.dryRun) return `dry-sell-${dryId++}`;
  try {
    const algos: any[] = await atk.call("spot_get_algo_orders", { status: "pending", instId });
    for (const a of algos ?? []) {
      try { await atk.call("spot_cancel_algo_order", { instId, algoId: String(a.algoId) }); } catch { /* zaten tetiklenmiş olabilir */ }
    }
  } catch { /* algo listesi alınamadı; satışa devam */ }
  const rows: any[] = await atk.call("spot_place_order", { instId, tdMode: "cash", side: "sell", ordType: "market", sz, tgtCcy: "base_ccy" });
  const r = rows?.[0] ?? rows;
  if (r?.sCode && r.sCode !== "0") throw new Error(`satış reddi ${r.sCode}: ${r.sMsg}`);
  return String(r.ordId);
}

export async function fillsSince(atk: Atk, beginMs: number): Promise<any[]> {
  if (CFG.dryRun) return [];
  try { return (await atk.call("spot_get_fills", { begin: String(beginMs), limit: 100 })) ?? []; }
  catch { return []; }
}
