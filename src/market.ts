// Piyasa verisi: evren, mumlar, emir defteri, smart money, haber. MCP birincil, REST yedek (anahtarsız).
import { CFG } from "./config";
import type { Atk } from "./mcp";
import type { Bar } from "./signals";

const REST = "https://tr.okx.com";

export type Inst = { instId: string; lotSz: number; minSz: number; tickSz: number };
export type Ticker = { instId: string; last: number; volUsd: number };

function toBar(r: any[]): Bar {
  return { ts: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) };
}

async function rest<T = any>(path: string): Promise<T> {
  const res = await fetch(REST + path, { headers: { "User-Agent": "okx-agent/0.1" } });
  const j: any = await res.json();
  if (j.code !== "0") throw new Error(`REST ${path}: ${j.msg ?? j.code}`);
  return j.data as T;
}

export async function getTickers(atk: Atk): Promise<Ticker[]> {
  let rows: any[];
  try { rows = await atk.call("market_get_tickers", { instType: "SPOT" }); }
  catch { rows = await rest("/api/v5/market/tickers?instType=SPOT"); }
  return rows.map((t) => ({ instId: t.instId, last: Number(t.last), volUsd: Number(t.volCcy24h ?? 0) }));
}

/** Likit USDT evreni. */
export async function getUniverse(atk: Atk): Promise<Ticker[]> {
  const all = await getTickers(atk);
  const u = CFG.universe;
  return all
    .filter((t) => t.instId.endsWith("-" + u.quote))
    .filter((t) => !(u.exclude as readonly string[]).includes(t.instId.split("-")[0]!))
    .filter((t) => t.volUsd >= u.minVolUsd && t.last > 0)
    .sort((a, b) => b.volUsd - a.volUsd)
    .slice(0, u.max);
}

export async function getInstruments(atk: Atk): Promise<Map<string, Inst>> {
  let rows: any[];
  try { rows = await atk.call("market_get_instruments", { instType: "SPOT" }); }
  catch { rows = await rest("/api/v5/market/instruments?instType=SPOT"); }
  const m = new Map<string, Inst>();
  for (const r of rows) m.set(r.instId, { instId: r.instId, lotSz: Number(r.lotSz), minSz: Number(r.minSz), tickSz: Number(r.tickSz) });
  return m;
}

/** Kapanmış 15m mumlar, artan sıra. */
export async function getCandles(atk: Atk, instId: string, limit = 60): Promise<Bar[]> {
  let rows: any[];
  try { rows = await atk.call("market_get_candles", { instId, bar: "15m", limit }); }
  catch { rows = await rest(`/api/v5/market/candles?instId=${instId}&bar=15m&limit=${limit}`); }
  const confirmed = rows.filter((r) => r.length < 9 || String(r[8]) === "1");
  return confirmed.map(toBar).sort((a, b) => a.ts - b.ts);
}

export async function getLast(atk: Atk, instId: string): Promise<number> {
  try {
    const r: any = await atk.call("market_get_ticker", { instId });
    const row = Array.isArray(r) ? r[0] : r;
    return Number(row.last);
  } catch {
    const r: any[] = await rest(`/api/v5/market/ticker?instId=${instId}`);
    return Number(r[0].last);
  }
}

export async function getBook(atk: Atk, instId: string, sz = 20): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
  let r: any;
  try { r = await atk.call("market_get_orderbook", { instId, sz }); }
  catch { r = (await rest<any[]>(`/api/v5/market/books?instId=${instId}&sz=${sz}`))[0]; }
  const row = Array.isArray(r) ? r[0] : r;
  const conv = (a: any[]) => (a ?? []).map((x: any[]) => [Number(x[0]), Number(x[1])] as [number, number]);
  return { bids: conv(row.bids), asks: conv(row.asks) };
}

/** Smart money konsensüsü: ccy → {longRatio, traders}. Hata olursa boş. */
export async function getSmartMoney(atk: Atk): Promise<Map<string, { longRatio: number; traders: number; vs24h: number }>> {
  const m = new Map<string, { longRatio: number; traders: number; vs24h: number }>();
  try {
    const rows: any[] = await atk.call("smartmoney_get_signal_overview_by_filter", {});
    for (const r of rows ?? []) m.set(String(r.ccy), { longRatio: Number(r.longRatio), traders: Number(r.tradersWithPosition), vs24h: Number(r.longRatioVs24h ?? 0) });
  } catch { /* opsiyonel veri */ }
  return m;
}

/** OKX news yanıtları {details:[...]} zarfında gelir; diziye indirger. */
function newsRows(r: any): any[] {
  const o = Array.isArray(r) ? (r[0]?.details ? r[0] : { details: r }) : r;
  return Array.isArray(o?.details) ? o.details : Array.isArray(o) ? o : [];
}

/** Son 6 saatin yüksek önemli haber başlıkları. Hata olursa boş. */
export async function getNews(atk: Atk, coin: string): Promise<string[]> {
  try {
    const rows: any[] = await atk.call("news_get_by_coin", {
      coins: coin, importance: "low", language: "en-US", limit: 5, begin: Date.now() - 6 * 3600_000,   // low = tümü (son 6 saat)
    });
    return newsRows(rows).map((r) => String(r.title ?? r.summary ?? "")).filter(Boolean);
  } catch { return []; }
}

/** Coin duygu skoru (OKX news). Hata olursa null. */
export async function getSentiment(atk: Atk, coin: string): Promise<{ score: number; label: string } | null> {
  try {
    const rows: any = await atk.call("news_get_coin_sentiment", { coins: coin, period: "24h" });
    const d = newsRows(rows)[0];
    if (!d?.sentiment) return null;
    const bull = Number(d.sentiment.bullishRatio ?? 0), bear = Number(d.sentiment.bearishRatio ?? 0);
    return { score: Number((bull - bear).toFixed(2)), label: `${d.sentiment.label} (bull ${bull}, bear ${bear}, ${d.mentionCnt ?? "?"} mention)` };
  } catch { return null; }
}

/** Son N dakikada çıkmış, coin etiketi olan yüksek önemli haberler (haber adayı için). */
export async function getFreshCoinNews(atk: Atk, withinMin = 45): Promise<{ id: string; title: string; coins: string[]; ts: number }[]> {
  try {
    // "high" önemli haberlerde coin etiketi neredeyse hiç yok; tüm akışı alıp somut olay kelimeleriyle ön eleme yapıyoruz, son kararı Karar katmanı verir.
    const rows: any = await atk.call("news_get_latest", { limit: 50, language: "en-US", importance: "low" });
    const since = Date.now() - withinMin * 60_000;
    const material = /\b(list(ing|ed|s)?|partner|integrat|mainnet|upgrade|launch|buyback|burn|etf|approv|adopt|acqui|airdrop|grant|treasury|staking|tokeniz)/i;
    const noise = /\b(analysis|opinion|sentiment|indicator|whale|unstake|address|transfer|rises|falls|surge|drop|dump|pump|profit|yield|market cap|price)\b/i;
    return newsRows(rows)
      .map((r) => ({ id: String(r.id ?? ""), title: String(r.title ?? r.summary ?? ""), coins: (r.ccyList ?? []).map((c: any) => String(c).toUpperCase()), ts: Number(r.cTime ?? 0) }))
      .filter((n) => n.title && n.coins.length && n.ts >= since && material.test(n.title) && !noise.test(n.title));
  } catch { return []; }
}

/** Son 3 saatin yüksek önemli piyasa haberleri (saat başı rejim notu için). */
export async function getImportantNews(atk: Atk, limit = 5): Promise<string[]> {
  try {
    const rows: any[] = await atk.call("news_get_latest", { limit, language: "en-US", importance: "high" });
    return newsRows(rows).map((r) => String(r.title ?? r.summary ?? "")).filter(Boolean);
  } catch { return []; }
}
