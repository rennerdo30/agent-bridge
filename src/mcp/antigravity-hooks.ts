import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { antigravityAncestor } from "../core/procinfo.js";
import { tokensEqual } from "../core/token.js";
import { object } from "../core/transcripts/common.js";
import { antigravityHookOutput } from "../cli/antigravity-hook.js";
import { buildHookResponse, confirmAntigravityStopDelivery } from "./hooks.js";
import type { ServerContext } from "./server.js";

/** Mail at active model boundaries; idle TUI wake is unavailable in agy 1.2.0. */
export class AntigravityHooks {
  private server: Server | null = null;
  private registerFn: (() => void) | null = null;
  private retired = false;
  private conversationId: string | null = null;
  private learnedCwd: string | null = null;
  private stopPending = false;
  private lastStopExecutionNum: number | null = null;
  private lastInvocationNum: number | null = null;
  private lastStopInvocationNum: number | null = null;
  constructor(private readonly ctx: ServerContext) {}
  async start(): Promise<void> {
    // Infrastructure probes have neither a peer nor a parent inbox to deliver.
    // Do not launch process inspection children that can outlive the short-lived probe.
    if (!this.ctx.node && !this.ctx.parent) return;
    const pid = await antigravityAncestor();
    if (!pid) return;
    const secret = randomBytes(24).toString("hex");
    mkdirSync(join(this.ctx.home, "antigravity-hooks"), { recursive: true });
    const register = () => {
      if (!this.server?.listening) return;
      const rawCwd = this.learnedCwd ?? (typeof this.ctx.cwd === "function" ? this.ctx.cwd() : this.ctx.cwd ?? null);
      writeFileSync(
        join(this.ctx.home, "antigravity-hooks", `${pid}.json`),
        JSON.stringify({
          port: (this.server.address() as AddressInfo).port,
          secret,
          pid: process.pid,
          ancestorPid: pid,
          retired: this.retired,
          connected: Boolean(this.ctx.node ? this.ctx.node.isConnected !== false : this.ctx.parent),
          conversationId: this.conversationId ?? this.ctx.node?.currentSessionId ?? null,
          cwd: typeof rawCwd === "string" && rawCwd.trim() ? rawCwd : null,
          stopPending: this.stopPending,
        }),
        { mode: 0o600 },
      );
    };
    this.registerFn = register;
    this.server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/hook" || !tokensEqual(String(req.headers.authorization ?? ""), `Bearer ${secret}`) || this.retired) { res.writeHead(403).end(); return; }
      void (async () => {
        let raw = "";
        for await (const part of req) { raw += part; if (raw.length > 256 * 1024) throw new Error("hook input too large"); }
        const body = object(JSON.parse(raw)), input = object(body.input);
        if (!["PreInvocation", "PreToolUse", "Stop"].includes(body.event)) throw new Error("unknown event");
        const id = typeof input.conversationId === "string" ? input.conversationId : null;
        const cwd = Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === "string" ? input.workspacePaths[0] : null;
        // Native children can share agy's OS process; they must never consume their parent's inbox.
        this.conversationId ??= this.ctx.node?.currentSessionId ?? id;
        if (id && this.conversationId && id !== this.conversationId) { res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
        if (cwd) this.learnedCwd = cwd;
        if (body.event === "PreToolUse") {
          this.stopPending = false;
          this.lastStopExecutionNum = null;
          this.lastStopInvocationNum = null;
          await (this.ctx.launchKnown ?? Promise.resolve());
          if (!this.ctx.headless && this.ctx.node) {
            if (id) {
              await this.ctx.node.setSessionId(id).catch(() => {});
              this.ctx.onSessionId?.(id);
            }
            if (cwd && this.ctx.learnCwd) await this.ctx.learnCwd(cwd);
            await this.ctx.node.ensureConnected().catch(() => {});
            confirmAntigravityStopDelivery(this.ctx);
          }
          register();
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
          return;
        }
        if (body.event === "PreInvocation") {
          const invocationNum = typeof input.invocationNum === "number" && Number.isFinite(input.invocationNum) ? input.invocationNum : null;
          const continued = this.stopPending && invocationNum !== null && (this.lastStopInvocationNum !== null ? invocationNum > this.lastStopInvocationNum : invocationNum > 0);
          this.lastInvocationNum = invocationNum;
          this.stopPending = false;
          this.lastStopExecutionNum = null;
          this.lastStopInvocationNum = null;
          const output = await buildHookResponse(this.ctx, { event: "UserPromptSubmit", sessionId: id, cwd, stopHookActive: continued });
          register();
          const text = "reason" in output ? String(output.reason) : "hookSpecificOutput" in output ? output.hookSpecificOutput.additionalContext : "";
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(antigravityHookOutput(body.event, text)));
          return;
        }
        const reason = typeof input.terminationReason === "string" ? input.terminationReason.trim() : "";
        const hasError = typeof input.error === "string" && input.error.trim().length > 0;
        const executionNum = typeof input.executionNum === "number" && Number.isFinite(input.executionNum) ? input.executionNum : null;
        const capReached = this.stopPending && executionNum !== null && this.lastStopExecutionNum !== null && executionNum <= this.lastStopExecutionNum;
        const canContinue = !hasError && (!reason || ["model_stop", "NO_TOOL_CALL", "STOP"].includes(reason)) && !capReached;
        const continued = this.stopPending && executionNum !== null && this.lastStopExecutionNum !== null && executionNum > this.lastStopExecutionNum;
        this.stopPending = false;
        this.lastStopExecutionNum = null;
        this.lastStopInvocationNum = null;
        if (!canContinue) {
          await buildHookResponse(this.ctx, { event: "StopFailure", sessionId: id, cwd, stopHookActive: false });
          register();
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
          return;
        }
        const output = await buildHookResponse(this.ctx, { event: "Stop", sessionId: id, cwd, stopHookActive: continued });
        const text = "reason" in output ? String(output.reason) : "hookSpecificOutput" in output ? output.hookSpecificOutput.additionalContext : "";
        if (text) {
          this.stopPending = true;
          this.lastStopExecutionNum = executionNum;
          this.lastStopInvocationNum = this.lastInvocationNum;
        }
        register();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(antigravityHookOutput(body.event, text)));
      })().catch(() => { if (!res.writableEnded) res.writeHead(500).end("{}"); });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", resolve); });
    register();
    this.ctx.node?.on("connected", () => register());
    this.ctx.node?.on("replaced", () => { this.retired = true; this.stopPending = false; this.lastStopExecutionNum = null; this.lastInvocationNum = null; this.lastStopInvocationNum = null; register(); });
    this.ctx.node?.on("reclaimed", () => { this.retired = false; register(); });
  }
  async stop(): Promise<void> {
    const server = this.server;
    this.retired = true;
    this.stopPending = false;
    this.lastStopExecutionNum = null;
    this.lastStopInvocationNum = null;
    this.lastInvocationNum = null;
    try { this.registerFn?.(); } catch {}
    this.registerFn = null;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
