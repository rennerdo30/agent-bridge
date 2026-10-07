import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { antigravityAncestor } from "../core/procinfo.js";
import { tokensEqual } from "../core/token.js";
import { object } from "../core/transcripts/common.js";
import { antigravityHookOutput } from "../cli/antigravity-hook.js";
import { buildHookResponse } from "./hooks.js";
import type { ServerContext } from "./server.js";

/** Mail at active model boundaries; idle TUI wake is unavailable in agy 1.2.0. */
export class AntigravityHooks {
  private server: Server | null = null;
  private retired = false;
  private conversationId: string | null = null;
  constructor(private readonly ctx: ServerContext) {}
  async start(): Promise<void> {
    // Infrastructure probes have neither a peer nor a parent inbox to deliver.
    // Do not launch process inspection children that can outlive the short-lived probe.
    if (!this.ctx.node && !this.ctx.parent) return;
    const pid = await antigravityAncestor();
    if (!pid) return;
    const secret = randomBytes(24).toString("hex");
    this.server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/hook" || !tokensEqual(String(req.headers.authorization ?? ""), `Bearer ${secret}`) || this.retired) { res.writeHead(403).end(); return; }
      void (async () => {
        let raw = "";
        for await (const part of req) { raw += part; if (raw.length > 256 * 1024) throw new Error("hook input too large"); }
        const body = object(JSON.parse(raw)), input = object(body.input);
        if (!["PreInvocation", "Stop"].includes(body.event)) throw new Error("unknown event");
        const id = typeof input.conversationId === "string" ? input.conversationId : null;
        // Native children can share agy's OS process; they must never consume their parent's inbox.
        this.conversationId ??= this.ctx.node?.currentSessionId ?? id;
        if (id && this.conversationId && id !== this.conversationId) { res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
        const output = await buildHookResponse(this.ctx, { event: body.event === "Stop" ? "Stop" : "UserPromptSubmit", sessionId: typeof input.conversationId === "string" ? input.conversationId : null, cwd: Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === "string" ? input.workspacePaths[0] : null, stopHookActive: false });
        const text = "reason" in output ? String(output.reason) : "hookSpecificOutput" in output ? output.hookSpecificOutput.additionalContext : "";
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(antigravityHookOutput(body.event, text)));
      })().catch(() => { if (!res.writableEnded) res.writeHead(500).end("{}"); });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", resolve); });
    mkdirSync(join(this.ctx.home, "antigravity-hooks"), { recursive: true });
    const register = () => {
      if (!this.server?.listening) return;
      writeFileSync(join(this.ctx.home, "antigravity-hooks", `${pid}.json`), JSON.stringify({ port: (this.server.address() as AddressInfo).port, secret, pid: process.pid }), { mode: 0o600 });
    };
    register();
    this.ctx.node?.on("replaced", () => { this.retired = true; });
    this.ctx.node?.on("reclaimed", () => { this.retired = false; register(); });
  }
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.retired = true;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
