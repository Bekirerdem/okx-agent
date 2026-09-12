// Karar günlüğü: JSONL (makine) + Markdown (insan) + Telegram (jüri canlı izler).
import { appendFileSync, mkdirSync } from "node:fs";
import { CFG } from "./config";
import { queue as anchorQueue } from "./anchor";

export type Kind = "boot" | "gate" | "scan" | "reject" | "llm" | "entry" | "fill" | "cancel" | "exit" | "stop" | "halt" | "flat" | "error" | "snapshot" | "info";
export type Entry = { ts: string; kind: Kind; role: string; msg: string; data?: Record<string, unknown> };

// Roller: jüri her satırda hangi ajanın konuştuğunu görür.
export const ROLE: Record<Kind, string> = {
  boot: "Günlük", gate: "Tarayıcı", scan: "Tarayıcı", reject: "Risk", llm: "Karar", entry: "Emir", fill: "Emir", cancel: "Emir",
  exit: "Emir", stop: "Risk", halt: "Risk", flat: "Emir", error: "Günlük", snapshot: "Günlük", info: "Günlük",
};
const ICON: Record<Kind, string> = {
  boot: "🟢", gate: "🚧", scan: "🔍", reject: "⛔", llm: "🧠", entry: "🟩", fill: "✅", cancel: "↩️", exit: "🎯",
  stop: "🛑", halt: "⏸️", flat: "🏁", error: "⚠️", snapshot: "📊", info: "ℹ️",
};

const TG = { token: process.env.TG_BOT_TOKEN ?? "", chat: process.env.TG_CHAT_ID ?? "" };
const TG_KINDS = new Set<Kind>(["boot", "gate", "llm", "entry", "fill", "cancel", "exit", "stop", "halt", "flat", "error", "snapshot"]);
const ANCHOR_KINDS = new Set<Kind>(["gate", "llm", "reject", "entry", "fill", "cancel", "exit", "stop", "halt", "flat", "snapshot"]);

mkdirSync("state", { recursive: true });

export function trTime(d = new Date()): string {
  return d.toLocaleTimeString("tr-TR", { timeZone: CFG.tz, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

let lastErr = { text: "", n: 0 };
const H = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** data.tg varsa Telegram'a o HTML metin gider (günlüğe yazılmaz); yoksa sade satır. Aynı hata art arda gelirse Telegram'a seyrek düşer. */
export function log(kind: Kind, msg: string, data?: Record<string, unknown>): void {
  const { tg, ...rest } = (data ?? {}) as Record<string, unknown> & { tg?: string };
  const clean = Object.keys(rest).length ? rest : undefined;
  const e: Entry = { ts: new Date().toISOString(), kind, role: ROLE[kind], msg, ...(clean ? { data: clean } : {}) };
  const line = `${ICON[kind]} ${trTime()} ${ROLE[kind]}·${kind} │ ${msg}`;
  console.log(line);
  try {
    appendFileSync(CFG.paths.journal, JSON.stringify(e) + "\n");
    appendFileSync(CFG.paths.md, `- ${line}${clean ? "  \n  `" + JSON.stringify(clean).slice(0, 400) + "`" : ""}\n`);
  } catch (err) { console.error("günlük yazılamadı", err); }
  if (CFG.dryRun) return;                       // dry-run Telegram'a yazmaz; canlı akışla karışmasın
  if (!TG_KINDS.has(kind) && !tg) return;       // açıkça tg metni verilen info satırları (piyasa notu, haber adayı) da gider
  if (kind === "error") {
    if (msg === lastErr.text) { lastErr.n++; if (lastErr.n % 5 !== 0) return; } else lastErr = { text: msg, n: 1 };
    void telegram(`⚠️ <b>Hata</b> · ${trTime().slice(0, 5)}${lastErr.n > 1 ? ` (${lastErr.n}. kez)` : ""}${String.fromCharCode(10)}${H(msg)}`, true);
    return;
  }
  if (tg) void telegram(`${ICON[kind]} ${tg}`, true);
  else void telegram(line + (clean?.reason ? `${String.fromCharCode(10)}${clean.reason}` : ""));
}

let tgChain: Promise<void> = Promise.resolve();
export function telegram(text: string, html = false): Promise<void> {
  if (!TG.token || !TG.chat) return Promise.resolve();
  tgChain = tgChain.then(async () => {
    try {
      await fetch(`https://api.telegram.org/bot${TG.token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TG.chat, text: text.slice(0, 3900), disable_web_page_preview: true, ...(html ? { parse_mode: "HTML" } : {}) }),
      });
    } catch { /* Telegram düşerse ajan durmaz */ }
    await new Promise((r) => setTimeout(r, 350));
  });
  return tgChain;
}
