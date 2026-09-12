// Canlı panel: state/ dosyalarını okur, http://localhost:8787. Ajandan bağımsız süreç, emir göndermez.
import { ask } from "./llm";
import { api, askContext, read } from "./panel_data";

const PORT = Number(process.env.DASH_PORT ?? 8787);
const HTML_PATH = `${import.meta.dir}/dashboard.html`;

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",   // yalnız bu makine; dışarıya açmak için tunel.bat (Cloudflare quick tunnel)
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
