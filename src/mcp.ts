// OKX Agent Trade Kit MCP istemcisi. Tek araç katmanı: emir ve hesap sadece buradan.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CFG } from "./config";

export class Atk {
  private client: Client | null = null;
  calls = 0;
  errors = 0;
  byTool: Record<string, number> = {};

  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: "okx-trade-mcp",
      args: ["--profile", CFG.profile, "--modules", CFG.modules, "--log-level", "warn"],
      stderr: "ignore",
    });
    const client = new Client({ name: "okx-agent", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  /** Aracı çağır, ATK zarfını aç, {ok:false} ise hata fırlat. 3 deneme. */
  async call<T = any>(name: string, args: Record<string, unknown> = {}, tries = 3): Promise<T> {
    if (!this.client) throw new Error("MCP bağlı değil");
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        this.calls++; this.byTool[name] = (this.byTool[name] ?? 0) + 1;
        const res: any = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 25_000 });
        const text = res?.content?.find((c: any) => c.type === "text")?.text ?? "";
        let obj: any;
        try { obj = JSON.parse(text); } catch { throw new Error(`ATK yanıtı JSON değil (${name}): ${text.slice(0, 200)}`); }
        if (obj.ok === false || res.isError) {
          const msg = obj.error?.message ?? obj.error ?? obj.message ?? text.slice(0, 200);
          const code = obj.error?.code ?? obj.code ?? "";
          const e = new Error(`${name}: ${msg} ${code ? "(" + code + ")" : ""}`);
          (e as any).code = code;
          throw e;
        }
        const d = obj.data;
        return (d && typeof d === "object" && "data" in d ? d.data : d) as T;
      } catch (e) {
        lastErr = e;
        this.errors++;
        // İş kuralı hataları (bakiye, lot, yetki) tekrarla düzelmez.
        const msg = String((e as Error).message ?? e);
        if (/5100[0-9]|5101[0-9]|51020|51121|51400|50101|50102|50111/.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
    throw lastErr;
  }
}
