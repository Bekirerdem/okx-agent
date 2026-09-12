// Panelin statik anlık görüntüsü: state/ → dist/index.html (veri sayfaya gömülü, sunucu gerekmez).
// Kullanım: bun run scripts/export_panel.ts  → sonra `wrangler pages deploy dist` (yayinla.bat bunu 5 dakikada bir yapar)
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { api } from "../src/panel_data";

const d = await api();
const html = readFileSync("src/dashboard.html", "utf-8");
const payload = JSON.stringify(d).replace(/</g, "\\u003c");   // "</script>" kaçışı
const out = html.replace("<script>", `<script>window.__STATIC__=true;window.__STATE__=${payload};</script>\n<script>`);
mkdirSync("dist/sunum", { recursive: true });
writeFileSync("dist/index.html", out);
copyFileSync("docs/sunum/index.html", "dist/sunum/index.html");          // slaytlar: /sunum
if (existsSync("docs/panel.png")) copyFileSync("docs/panel.png", "dist/sunum/panel.png");
console.log(`dist/index.html yazıldı · ${new Date().toLocaleTimeString("tr-TR", { timeZone: "Europe/Istanbul" })} · kasa ${Number(d.state?.equity ?? 0).toFixed(2)} · ${d.journal.length} günlük satırı`);
