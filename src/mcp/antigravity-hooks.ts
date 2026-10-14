import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { antigravityAncestor, lookup } from "../core/procinfo.js";
import { tokensEqual } from "../core/token.js";
import { object, TRANSCRIPT_ID } from "../core/transcripts/common.js";
import { antigravityHookOutput } from "../cli/antigravity-hook.js";
import { antigravityRootSession, readAntigravityPrivateJson } from "../core/antigravity-plugin.js";
import { assertUnlinked } from "../core/plugin-runtime.js";
import { processIdentity } from "../core/process-identity.js";
import { buildHookResponse } from "./hooks.js";
import type { ServerContext } from "./server.js";

/** Mail at active model boundaries; idle TUI wake is unavailable in agy 1.2.0. */
export class AntigravityHooks {
  private server: Server | null = null;
  private retired = false;
  private conversationId: string | null = null;
  private file: string | null = null;
  private readonly secret = randomBytes(24).toString("hex");
  private readonly requests = new Set<AbortController>();
  private register: (() => void) | null = null;
  private readonly replaced = () => { this.retired = true; for (const request of this.requests) request.abort(); };
  private readonly reclaimed = () => { if (!this.server?.listening) return; this.retired = false; this.register?.(); };
  constructor(private readonly ctx: ServerContext) {}
  async start(): Promise<void> {
    if (this.server) return;
    // Infrastructure probes have neither a peer nor a parent inbox to deliver.
    // Do not launch process inspection children that can outlive the short-lived probe.
    if (!this.ctx.node && !this.ctx.parent) return;
    const pid = await antigravityAncestor();
    if (!pid) return;
    const hostIdentity = processIdentity(pid), identity = processIdentity(process.pid);
    if (!hostIdentity || !identity) return;
    // A shared native child can fire the first hook. Never bind an unknown root
    // from its payload. A resumed CLI's explicit --conversation is host evidence.
    const tokens = (await lookup(pid))?.cmdline.match(/"[^"]*"|'[^']*'|\S+/g)?.map(token => token.replace(/^["']|["']$/g, "")) ?? [];
    const conversations = tokens.flatMap((token, index) => token === "--conversation" ? [tokens[index + 1] ?? ""] : token.startsWith("--conversation=") ? [token.slice("--conversation=".length)] : []);
    const resumed = conversations.length === 1 && TRANSCRIPT_ID.test(conversations[0]!) ? conversations[0]! : null;
    this.file = join(this.ctx.home, "antigravity-hooks", `${pid}.json`);
    assertUnlinked(join(this.ctx.home, "antigravity-hooks"));
    mkdirSync(join(this.ctx.home, "antigravity-hooks"), { recursive: true, mode: 0o700 });
    assertUnlinked(this.file);
    let restored: string | null = null;
    try {
      const previous = readAntigravityPrivateJson(this.file);
      if (previous.hostIdentity === hostIdentity && typeof previous.conversationId === "string" && TRANSCRIPT_ID.test(previous.conversationId)) restored = previous.conversationId;
    } catch { /* No proven predecessor root. */ }
    this.conversationId = resumed ?? antigravityRootSession(this.ctx.home, pid, hostIdentity) ?? restored ?? this.ctx.node?.currentSessionId ?? null;
    this.retired = false;
    const secret = this.secret;
    this.server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/hook" || !tokensEqual(String(req.headers.authorization ?? ""), `Bearer ${secret}`) || this.retired) { res.writeHead(403).end(); return; }
      const controller = new AbortController();
      this.requests.add(controller);
      const abort = () => controller.abort();
      req.once("aborted", abort);
      res.once("close", abort);
      void (async () => {
        let raw = "";
        for await (const part of req) { raw += part; if (raw.length > 256 * 1024) throw new Error("hook input too large"); }
        const body = object(JSON.parse(raw)), input = object(body.input);
        if (!["PreInvocation", "Stop"].includes(body.event)) throw new Error("unknown event");
        const id = typeof input.conversationId === "string" && TRANSCRIPT_ID.test(input.conversationId) ? input.conversationId : null;
        // Native children can share agy's OS process; they must never consume their parent's inbox.
        if (!this.conversationId) {
          this.conversationId = antigravityRootSession(this.ctx.home, pid, hostIdentity) ?? this.ctx.node?.currentSessionId ?? null;
          if (this.conversationId) this.register?.();
        }
        if (!id || !this.conversationId || id !== this.conversationId || this.retired || controller.signal.aborted) { res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
        const output = await buildHookResponse(this.ctx, { event: body.event === "Stop" ? "Stop" : "UserPromptSubmit", sessionId: id, cwd: Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === "string" ? input.workspacePaths[0] : null, stopHookActive: false, signal: controller.signal });
        const text = "reason" in output ? String(output.reason) : "hookSpecificOutput" in output ? output.hookSpecificOutput.additionalContext : "";
        if (!res.destroyed) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(controller.signal.aborted || this.retired ? {} : antigravityHookOutput(body.event, text)));
      })().catch(() => { if (!res.writableEnded && !res.destroyed) res.writeHead(500).end("{}"); }).finally(() => { this.requests.delete(controller); req.removeListener("aborted", abort); res.removeListener("close", abort); });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", resolve); });
    this.register = () => {
      if (!this.server?.listening) return;
      const temporary = `${this.file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ port: (this.server.address() as AddressInfo).port, secret, pid: process.pid, identity, hostIdentity, conversationId: this.conversationId }), { mode: 0o600, flag: "wx" });
        renameSync(temporary, this.file!);
      } finally { try { unlinkSync(temporary); } catch { /* Renamed or already removed. */ } }
    };
    try { this.register(); } catch (error) { await this.stop(); throw error; }
    this.ctx.node?.on("replaced", this.replaced);
    this.ctx.node?.on("reclaimed", this.reclaimed);
  }
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.replaced();
    this.register = null;
    this.ctx.node?.removeListener("replaced", this.replaced);
    this.ctx.node?.removeListener("reclaimed", this.reclaimed);
    if (this.file) {
      try { const reg = readAntigravityPrivateJson(this.file); if (reg.secret === this.secret && reg.pid === process.pid) unlinkSync(this.file); } catch { /* Already removed or replaced. */ }
      this.file = null;
    }
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
}
