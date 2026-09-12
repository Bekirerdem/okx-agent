// LLM seçici: kurallar içinde karar verir. Boyut, stop, BTC filtresi, fren erişimi YOK.
// Sağlayıcı: claude -p (abonelik) → Gemini API (yedek) → kural (derinliğe göre).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CFG } from "./config";

export type Candidate = {
  instId: string; close: number; depthPct: number; mid: number; rs4h: number; dayRangePct: number; volUsd: number;
  bookImb: number; smart?: { longRatio: number; traders: number; vs24h: number }; news: string[]; sentiment?: { score: number; label: string } | null;
  ta?: { rsi: number; trend: string; atrPct: number; vwapDist: number; volRatio: number };
};
export type Decision = { picks: { instId: string; reason: string }[]; rejects: { instId: string; reason: string }[]; note: string; provider: string };

function prompt(cands: Candidate[], freeSlots: number, ctx: { btcRetPct: number; equity: number; tr: string }): string {
  const rows = cands.map((c) => ({
    instId: c.instId, close: c.close, sweep_depth_pct: +c.depthPct.toFixed(2), target_mid: c.mid, rs_vs_btc_4h_pct: +c.rs4h.toFixed(2),
    day_range_pct: +c.dayRangePct.toFixed(2), vol24h_usd_m: +(c.volUsd / 1e6).toFixed(1), book_bid_ask_ratio_1pct: +c.bookImb.toFixed(2),
    smart_money: c.smart ? { long_ratio: +c.smart.longRatio.toFixed(2), traders: c.smart.traders, vs24h: +c.smart.vs24h.toFixed(2) } : null,
    news_6h_high: c.news.slice(0, 3),
    sentiment_24h: c.sentiment ? `${c.sentiment.label} (${c.sentiment.score})` : null,
    technical_15m: c.ta ? { rsi14: c.ta.rsi, ema20_vs_ema50: c.ta.trend, atr_pct: c.ta.atrPct, vwap_distance_pct: c.ta.vwapDist, volume_ratio_24: c.ta.volRatio } : null,
  }));
  return `Sen bir spot kripto trading ajanının KARAR katmanısın. Cumartesi, OKX TR, long-only, saat ${ctx.tr} (TR).
Tez: Cumartesi geri dönüş piyasası; stopları avlanmış (dip avı + içeri yeşil kapanış) coin alınır, 3 saatlik aralığın ortasına dönünce satılır.
BTC 4 saatlik getiri: ${ctx.btcRetPct.toFixed(2)}%. Kasa: ${ctx.equity.toFixed(2)} USDT. Boş slot: ${freeSlots}.
Yetkin: adaylar arasından en fazla ${freeSlots} tanesini SEÇMEK ya da hepsini reddetmek. Boyut, stop, BTC filtresi ve fren kod tarafındadır, onları tartışma.
Seçim ölçütleri: (1) haberde delist/hack/exploit/soruşturma varsa KESİN RED; (2) emir defteri alıcı ağır (>1) ise artı; (3) smart money long oranı çok yüksek (>0.9) ve 24h'de artmışsa kalabalık uyarısı, çok düşükse (<0.4) squeeze potansiyeli; (4) göreli güç +2'ye yakınsa kovalama riski; (5) dip avı derinliği ve gün aralığı yüksekse gerçek stop avı olasılığı yüksek; (6) teknik bağlam: RSI çok düşükse (<35) geri dönüş potansiyeli artı, EMA20<EMA50 (aşağı trend) ve VWAP'ın çok altındaysa "düşen bıçak" riski, hacim oranı >1.5 stop avının gerçek olduğunu destekler, ATR yüksekse hedefe ulaşma olasılığı artar ama stop riski de.
Kısa, Türkçe, somut gerekçe yaz. SADECE şu JSON'u döndür, başka metin yok:
{"picks":[{"instId":"...","reason":"..."}],"rejects":[{"instId":"...","reason":"..."}],"note":"tek cümle rejim yorumu"}
ADAYLAR:
${JSON.stringify(rows, null, 1)}`;
}

function parseJson(text: string): any {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSON bulunamadı");
  return JSON.parse(m[0]);
}

async function viaClaude(p: string): Promise<string> {
  const proc = Bun.spawn(["cmd", "/c", "claude", "-p", "--output-format", "json"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(p); proc.stdin.end();
  const killer = setTimeout(() => proc.kill(), CFG.llm.timeoutMs);
  const out = await new Response(proc.stdout).text();
  clearTimeout(killer);
  const j = JSON.parse(out);
  if (j.is_error) throw new Error(String(j.result ?? "claude hata"));
  return String(j.result ?? "");
}

function geminiKey(): { key: string; model: string } {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.claude.json`, "utf-8"));
  const env = cfg?.mcpServers?.gemini?.env ?? {};
  return { key: process.env.GEMINI_API_KEY ?? env.GEMINI_API_KEY ?? "", model: env.GEMINI_FLASH_MODEL ?? "gemini-2.5-flash" };
}

async function viaGemini(p: string): Promise<string> {
  const { key, model } = geminiKey();
  if (!key) throw new Error("Gemini anahtarı yok");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), CFG.llm.timeoutMs);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
    body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { temperature: 0.2, responseMimeType: "application/json" } }),
  });
  clearTimeout(t);
  const j: any = await res.json();
  return String(j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
}

function byRule(cands: Candidate[], freeSlots: number, why: string): Decision {
  const bad = (c: Candidate) => c.news.some((n) => /delist|hack|exploit|investigat|lawsuit|halt/i.test(n));
  const sorted = [...cands].filter((c) => !bad(c)).sort((a, b) => b.depthPct - a.depthPct);
  const picks = sorted.slice(0, freeSlots).map((c) => ({ instId: c.instId, reason: `kural: derinlik ${c.depthPct.toFixed(2)}% (${why})` }));
  const chosen = new Set(picks.map((p) => p.instId));
  const rejects = cands.filter((c) => !chosen.has(c.instId)).map((c) => ({ instId: c.instId, reason: bad(c) ? "haber vetosu" : "slot/derinlik sırası" }));
  return { picks, rejects, note: `LLM çevrimdışı, kural motoru seçti (${why})`, provider: "rule" };
}

export async function decide(cands: Candidate[], freeSlots: number, ctx: { btcRetPct: number; equity: number; tr: string }): Promise<Decision> {
  if (!cands.length || freeSlots <= 0) return { picks: [], rejects: cands.map((c) => ({ instId: c.instId, reason: "boş slot yok" })), note: "", provider: "none" };
  const p = prompt(cands, freeSlots, ctx);
  const order = CFG.llm.provider === "gemini" ? [["gemini", viaGemini], ["claude", viaClaude]] : [["claude", viaClaude], ["gemini", viaGemini]];
  for (const [name, fn] of order as [string, (s: string) => Promise<string>][]) {
    try {
      const raw = await fn(p);
      const j = parseJson(raw);
      const ids = new Set(cands.map((c) => c.instId));
      const picks = (j.picks ?? []).filter((x: any) => ids.has(x.instId)).slice(0, freeSlots).map((x: any) => ({ instId: String(x.instId), reason: String(x.reason ?? "") }));
      const chosen = new Set(picks.map((x: any) => x.instId));
      const rejects = cands.filter((c) => !chosen.has(c.instId)).map((c) => {
        const r = (j.rejects ?? []).find((x: any) => x.instId === c.instId);
        return { instId: c.instId, reason: String(r?.reason ?? "LLM seçmedi") };
      });
      return { picks, rejects, note: String(j.note ?? ""), provider: name };
    } catch (e) {
      console.error(`LLM ${name} başarısız:`, (e as Error).message?.slice(0, 160));
    }
  }
  return byRule(cands, freeSlots, "tüm sağlayıcılar düştü");
}

/** Serbest soru: sahibi Telegram'dan sorar, Karar günlük bağlamıyla kısa Türkçe cevap verir. */
export async function ask(question: string, context: string): Promise<string> {
  const p = `Sen "okx-agent" adlı spot trading ajanının Karar katmanısın. Sahibin Telegram'dan soru soruyor. Aşağıdaki durum ve günlük bağlamına dayanarak, en fazla 6 cümle, Türkçe, somut ve dürüst cevap ver. Bilmediğini uydurma; günlükte yoksa "günlükte yok" de. Boyut/stop/BTC filtresi/fren kuralları koddadır, onları değiştiremezsin; sorulursa bunu söyle.
${context}

SORU: ${question}`;
  const order = CFG.llm.provider === "gemini" ? [viaGemini, viaClaude] : [viaClaude, viaGemini];
  for (const fn of order) {
    try { const r = (await fn(p)).trim(); if (r) return r; } catch (e) { console.error("ask:", (e as Error).message?.slice(0, 120)); }
  }
  return "Şu an LLM'e ulaşamıyorum; /durum, /pozisyon ve /adaylar komutları kural motorundan cevap verir.";
}
