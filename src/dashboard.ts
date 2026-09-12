// Canlı panel: state/ dosyalarını okur, http://localhost:8787. Ajandan bağımsız süreç, emir göndermez.
import { existsSync, readFileSync } from "node:fs";
import { ask } from "./llm";

const PORT = Number(process.env.DASH_PORT ?? 8787);
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf-8") : "");
const json = (p: string, d: any) => { try { return JSON.parse(read(p) || "null") ?? d; } catch { return d; } };
const jsonl = (p: string) => read(p).trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Açık pozisyonların anlık fiyatı: OKX TR herkese açık REST (anahtar yok, emir yok). 5 sn önbellek; ağ yoksa son bilinen değer.
const priceCache: Record<string, { px: number; ts: number }> = {};
async function prices(ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(ids.map(async (id) => {
    const c = priceCache[id];
    if (c && Date.now() - c.ts < 5_000) { out[id] = c.px; return; }
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4_000);
      const r: any = await (await fetch(`https://tr.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(id)}`, { signal: ctl.signal, headers: { "User-Agent": "okx-agent-panel/0.1" } })).json();
      clearTimeout(t);
      const px = Number(r?.data?.[0]?.last ?? 0);
      if (px > 0) { priceCache[id] = { px, ts: Date.now() }; out[id] = px; } else if (c) out[id] = c.px;
    } catch { if (c) out[id] = c.px; }
  }));
  return out;
}

async function api() {
  const state = json("state/state.json", null);
  const metrics = json("state/metrics.json", null);
  const journal = jsonl("state/journal.jsonl");
  const anchors = jsonl("state/anchors.jsonl");
  const snaps = journal.filter((e) => e.kind === "snapshot").map((e) => ({ ts: e.ts, eq: Number((e.msg.match(/(?:özkaynak|kasa) ([\d.]+)/) ?? [])[1]) })).filter((s) => s.eq > 0);
  const px = await prices([...Object.keys(state?.positions ?? {}), ...Object.keys(state?.pending ?? {})]);
  return { now: Date.now(), state, metrics, prices: px, journal: journal.slice(-150).reverse(), anchors: anchors.slice(-8).reverse(), snaps, counts: Object.fromEntries(["scan", "gate", "reject", "llm", "entry", "fill", "cancel", "exit", "stop", "halt", "error"].map((k) => [k, journal.filter((e) => e.kind === k).length])) };
}

const HTML_PATH = `${import.meta.dir}/dashboard.html`;

function askContext(): string {
  const st = json("state/state.json", {}); const m = json("state/metrics.json", {});
  const recent = jsonl("state/journal.jsonl").slice(-40).map((e) => `${String(e.ts).slice(11, 19)}Z ${e.role}·${e.kind}: ${e.msg}${e.data?.reason ? " → " + e.data.reason : ""}`).join(String.fromCharCode(10));
  return [
    `DURUM: kasa ${Number(st.equity ?? 0).toFixed(2)} USDT, gün başı ${Number(st.dayStartEquity ?? 0).toFixed(2)}, açık ${Object.keys(st.positions ?? {}).length}, bekleyen ${Object.keys(st.pending ?? {}).length}, işlem ${st.tradesToday ?? 0}, fren ${st.halted ? "aktif" : "yok"}.`,
    String(m.lastGate ?? ""), `SON TARAMA: ${m.lastScan ?? ""}`, `KARAR: ${m.lastLlm ?? ""}`, `KOVALAYAN BOT: ${m.shadow?.summary ?? ""}`, "SON GÜNLÜK:", recent,
  ].join(String.fromCharCode(10));
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",   // yalnız bu makine; mekân ağındaki başkaları paneli ve /api/ask'i göremez
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/api/state") return Response.json(await api(), { headers: { "cache-control": "no-store" } });
    if (u.pathname === "/api/ask" && req.method === "POST") {
      try {
        const { q } = (await req.json()) as { q?: string };
        if (!q?.trim()) return Response.json({ error: "soru boş" }, { status: 400 });
        const answer = await ask(q.trim().slice(0, 300), askContext());
        return Response.json({ answer });
      } catch (e) { return Response.json({ error: (e as Error).message?.slice(0, 200) }, { status: 500 }); }
    }
    return new Response(read(HTML_PATH), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`panel: http://localhost:${PORT}`);
