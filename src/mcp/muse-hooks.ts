import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { museEnvSessionId } from "../core/muse.js";
import { tokensEqual } from "../core/token.js";
import { object } from "../core/transcripts/common.js";
import { museHookOutput, museHookRegistration } from "../cli/muse-hook.js";
import { buildHookResponse, type HookEvent } from "./hooks.js";
import type { ServerContext } from "./server.js";

const EVENTS: readonly string[] = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];

/**
 * Mail and session binding for a live Muse session, through its native lifecycle
 * hooks. Hooks inject unread mail at turn boundaries (prompt submit, tool use) and
 * Stop can continue the turn with waiting mail. There is no idle wake: a session
 * that never starts a turn does not run hooks.
 */
export class MuseHooks {
  private server: Server | null = null;
  private retired = false;
  constructor(private readonly ctx: ServerContext) {}
  async start(): Promise<void> {
    if (!this.ctx.node && !this.ctx.parent) return;
    const sessionId = museEnvSessionId();
    if (!sessionId) return;
    const secret = randomBytes(24).toString("hex");
    this.server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/hook" || !tokensEqual(String(req.headers.authorization ?? ""), `Bearer ${secret}`) || this.retired) { res.writeHead(403).end(); return; }
      void (async () => {
        let raw = "";
        for await (const part of req) { raw += part; if (raw.length > 256 * 1024) throw new Error("hook input too large"); }
        const body = object(JSON.parse(raw)), input = object(body.input);
        if (!EVENTS.includes(body.event)) throw new Error("unknown event");
        const event = body.event as HookEvent;
        const id = typeof input.session_id === "string" ? input.session_id : sessionId;
        if (id !== sessionId) { res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
        await this.ctx.node?.setSessionId(id).catch(() => {});
        if (typeof input.cwd === "string" && input.cwd) await this.ctx.learnCwd?.(input.cwd).catch(() => {});
        if (event === "UserPromptSubmit") this.ctx.activity?.("busy");
        const output = await buildHookResponse(this.ctx, {
          event,
          sessionId: id,
          cwd: typeof input.cwd === "string" ? input.cwd : null,
          prompt: typeof input.prompt === "string" ? input.prompt : null,
          stopHookActive: input.stop_hook_active === true,
        });
        if (event === "Stop") this.ctx.activity?.("idle");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(museHookOutput(event, output)));
      })().catch(() => { if (!res.writableEnded) res.writeHead(500).end("{}"); });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", resolve); });
    mkdirSync(join(this.ctx.home, "muse-hooks"), { recursive: true });
    const register = () => {
      if (!this.server?.listening) return;
      writeFileSync(museHookRegistration(this.ctx.home, sessionId), JSON.stringify({ port: (this.server.address() as AddressInfo).port, secret, pid: process.pid }), { mode: 0o600 });
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
