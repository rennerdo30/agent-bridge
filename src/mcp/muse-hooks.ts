import { randomBytes } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MUSE_ACCESS_ENV, museHookFile, museHostPid, readMusePrivateJson } from "../core/muse-context.js";
import { processIdentity } from "../core/process-identity.js";
import { tokensEqual } from "../core/token.js";
import { object } from "../core/transcripts/common.js";
import { museReadingTool, museHookOutput } from "../cli/muse-hook.js";
import { buildHookResponse, type HookEvent } from "./hooks.js";
import type { ServerContext } from "./server.js";

/** Active-turn mail and activity updates; a native child never consumes its root's inbox. */
export class MuseHooks {
  private server: Server | null = null;
  private file: string | null = null;
  private retired = false;
  private readonly secret = randomBytes(24).toString("hex");
  constructor(private readonly ctx: ServerContext, private readonly session = process.env.MUSE_SESSION_ID ?? "") {}
  async start(): Promise<void> {
    if (!this.session || (!this.ctx.node && !this.ctx.parent)) return;
    const host = await museHostPid(), hostIdentity = host ? processIdentity(host) : undefined;
    if (!host || !hostIdentity) return;
    const secret = this.secret;
    this.server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/hook" || !tokensEqual(String(req.headers.authorization ?? ""), `Bearer ${secret}`) || this.retired) { res.writeHead(403).end(); return; }
      void (async () => {
        let raw = "";
        for await (const part of req) { raw += part; if (raw.length > 256 * 1024) throw new Error("hook input too large"); }
        const body = object(JSON.parse(raw)), input = object(body.input);
        if (body.session !== this.session) return {};
        const event = String(body.event ?? "");
        if (event === "PreToolUse") {
          const access = process.env[MUSE_ACCESS_ENV];
          if (access === "read" && !museReadingTool(input)) return { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: "agent-bridge read access forbids this tool" } };
          // Ask always prompts for mutations, even if a native allow rule would have skipped approval.
          if (access === "ask" && !museReadingTool(input)) return { hookSpecificOutput: { hookEventName: event, permissionDecision: "ask" } };
        }
        if (body.thread && body.thread !== this.session) return {};
        const mapped = event === "PreLLMCall" || event === "PreToolUse" ? "PostToolUse" : event;
        if (!["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "StopFailure", "SessionEnd"].includes(mapped)) return {};
        const output = await buildHookResponse(this.ctx, { event: mapped as HookEvent, sessionId: this.session, cwd: typeof input.cwd === "string" ? input.cwd : null, stopHookActive: input.stop_hook_active === true, prompt: typeof input.prompt === "string" ? input.prompt : null, promptId: typeof input.turn_id === "string" ? input.turn_id : null });
        return museHookOutput(event, output);
      })().then(output => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(output)); }, () => { if (!res.writableEnded) res.writeHead(500).end("{}"); });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", resolve); });
    this.file = museHookFile(host, this.session);
    const temporary = `${this.file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(temporary, JSON.stringify({ port: (this.server.address() as AddressInfo).port, secret, hostIdentity, pid: process.pid, identity: processIdentity(process.pid), session: this.session }), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.file);
    this.ctx.node?.on("replaced", () => { this.retired = true; });
    this.ctx.node?.on("reclaimed", () => { this.retired = false; });
  }
  async stop(): Promise<void> {
    const server = this.server; this.server = null; this.retired = true;
    if (this.file) { try { const reg = readMusePrivateJson(this.file); if (reg.pid === process.pid && reg.secret === this.secret) unlinkSync(this.file); } catch { /* Already removed or replaced. */ } this.file = null; }
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
