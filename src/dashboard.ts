// Canlı panel: state/ dosyalarını okur, http://localhost:8787. Ajandan bağımsız süreç, emir göndermez.
import { existsSync, readFileSync } from "node:fs";

const PORT = Number(process.env.DASH_PORT ?? 8787);
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf-8") : "");
const json = (p: string, d: any) => { try { return JSON.parse(read(p) || "null") ?? d; } catch { return d; } };
const jsonl = (p: string) => read(p).trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function api() {
  const state = json("state/state.json", null);
  const metrics = json("state/metrics.json", null);
  const journal = jsonl("state/journal.jsonl");
  const anchors = jsonl("state/anchors.jsonl");
  const snaps = journal.filter((e) => e.kind === "snapshot").map((e) => ({ ts: e.ts, eq: Number((e.msg.match(/özkaynak ([\d.]+)/) ?? [])[1]) })).filter((s) => s.eq > 0);
  return { now: Date.now(), state, metrics, journal: journal.slice(-120).reverse(), anchors: anchors.slice(-8).reverse(), snaps, counts: Object.fromEntries(["scan", "gate", "reject", "llm", "entry", "fill", "cancel", "exit", "stop", "halt", "error"].map((k) => [k, journal.filter((e) => e.kind === k).length])) };
}

const HTML_PATH = `${import.meta.dir}/dashboard.html`;

Bun.serve({
  port: PORT,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/api/state") return Response.json(api(), { headers: { "cache-control": "no-store" } });
    return new Response(read(HTML_PATH), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`panel: http://localhost:${PORT}`);
