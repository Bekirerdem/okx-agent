// Canlı emir yolu dumanı testi: ~1.5 USDT ile alış (ekli SL) → algo kontrol → satış (algo iptal). Sonra uzak limit + iptal.
import { Atk } from "../src/mcp";
import { getInstruments, getLast, getBook } from "../src/market";
import { getBalance, placeLimitBuy, getOrder, cancelOrder, sellMarket } from "../src/exchange";
import { roundPrice, roundSize } from "../src/risk";

const atk = new Atk(); await atk.connect();
const inst = await getInstruments(atk);
const cand = ["XRP-USDT", "DOGE-USDT", "ADA-USDT", "TRX-USDT"];
let pick = "";
for (const id of cand) { const i = inst.get(id)!; const px = await getLast(atk, id); if (i && i.minSz * px <= 1.2) { pick = id; break; } }
if (!pick) throw new Error("uygun parite yok");
const i = inst.get(pick)!;
const b0 = await getBalance(atk);
console.log("parite", pick, "lot", i, "| USDT avail", b0.usdtAvail, "| eq", b0.totalEq);

// 1) alış: en iyi satış fiyatının biraz üstüne limit (hemen dolsun), ekli SL %4
const bk = await getBook(atk, pick, 5);
const ask = bk.asks[0]![0];
const px = roundPrice(ask * 1.002, i.tickSz);
const sz = roundSize(1.5 / px, i.lotSz, i.minSz);
const sl = roundPrice(px * 0.96, i.tickSz);
console.log("ALIŞ limit", sz, "@", px, "SL", sl, "≈", (sz * px).toFixed(3), "USDT");
const ordId = await placeLimitBuy(atk, { instId: pick, px: String(px), sz: String(sz), slPx: String(sl), clOrdId: "smoke" + Date.now().toString(36) });
console.log("ordId", ordId);
let o = await getOrder(atk, pick, ordId);
for (let k = 0; k < 10 && o.state !== "filled"; k++) { await new Promise((r) => setTimeout(r, 1500)); o = await getOrder(atk, pick, ordId); }
console.log("emir durumu", o);
if (o.state !== "filled") { await cancelOrder(atk, pick, ordId); console.log("dolmadı, iptal edildi"); await atk.close(); process.exit(1); }

// 2) ekli SL algo görünüyor mu
const algos: any[] = await atk.call("spot_get_algo_orders", { status: "pending", instId: pick });
console.log("bekleyen algo", (algos ?? []).map((a) => ({ algoId: a.algoId, slTriggerPx: a.slTriggerPx, sz: a.sz, state: a.state })));

// 3) satış (algo iptal + piyasa satış)
const b1 = await getBalance(atk);
const ccy = pick.split("-")[0]!;
console.log("elde toplam", b1.coins[ccy], "| kullanılabilir (stop donduruyor)", b1.avail[ccy]);
const sellId = await sellMarket(atk, pick, String(b1.coins[ccy] ?? 0), i.lotSz);
await new Promise((r) => setTimeout(r, 2000));
const so = await getOrder(atk, pick, sellId);
console.log("satış", so);
const algos2: any[] = await atk.call("spot_get_algo_orders", { status: "pending", instId: pick });
console.log("satış sonrası bekleyen algo", (algos2 ?? []).length);

// 4) uzak limit + iptal (zaman aşımı yolu)
const far = roundPrice(ask * 0.7, i.tickSz);
const farId = await placeLimitBuy(atk, { instId: pick, px: String(far), sz: String(sz), slPx: String(roundPrice(far * 0.96, i.tickSz)), clOrdId: "far" + Date.now().toString(36) });
await new Promise((r) => setTimeout(r, 1000));
await cancelOrder(atk, pick, farId);
const fo = await getOrder(atk, pick, farId);
console.log("uzak limit iptal sonrası durum:", fo.state);
const b2 = await getBalance(atk);
console.log("SON: USDT avail", b2.usdtAvail, "| eq", b2.totalEq, "| fark", (b2.totalEq - b0.totalEq).toFixed(4), "USDT (komisyon+spread)");
await atk.close();
