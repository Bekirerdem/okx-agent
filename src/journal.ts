// Karar günlüğü: JSONL (makine) + Markdown (insan) + Telegram (jüri canlı izler).
import { appendFileSync, mkdirSync } from "node:fs";
import { CFG } from "./config";
import { queue as anchorQueue } from "./anchor";

export type Kind = "boot" | "gate" | "scan" | "reject" | "llm" | "entry" | "fill" | "cancel" | "exit" | "stop" | "halt" | "flat" | "error" | "snapshot" | "info";
export type Entry = { ts: string; kind: Kind; role: string; msg: string; data?: Record<string, unknown> };

// Roller: jüri her satırda hangi ajanın konuştuğunu görür.
export const ROLE: Record<Kind, string> = {
  boot: "Kâtip", gate: "Gözcü", scan: "Gözcü", reject: "Hakem", llm: "Seçici", entry: "İcracı", fill: "İcracı", cancel: "İcracı",
  exit: "İcracı", stop: "Hakem", halt: "Hakem", flat: "İcracı", error: "Kâtip", snapshot: "Kâtip", info: "Kâtip",
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

export function log(kind: Kind, msg: string, data?: Record<string, unknown>): void {
  const e: Entry = { ts: new Date().toISOString(), kind, role: ROLE[kind], msg, ...(data ? { data } : {}) };
  const line = `${ICON[kind]} ${trTime()} ${ROLE[kind]}·${kind} │ ${msg}`;
  console.log(line);
  try {
    appendFileSync(CFG.paths.journal, JSON.stringify(e) + "\n");
    appendFileSync(CFG.paths.md, `- ${line}${data ? "  \n  `" + JSON.stringify(data).slice(0, 400) + "`" : ""}\n`);
  } catch (err) { console.error("günlük yazılamadı", err); }
  if (TG_KINDS.has(kind)) void telegram(line + (data?.reason ? `\n${data.reason}` : ""));
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
