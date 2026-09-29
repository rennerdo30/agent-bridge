import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { BridgeMessage } from "../core/protocol.js";
import { tokensEqual } from "../core/token.js";
import { formatMessages } from "./format.js";

/**
 * Wake an idle Claude Code session when something it is waiting for arrives: a background subagent's
 * result, a reply to a question it asked, or (with auto-wake) any peer message.
 *
 * Claude Code's `asyncRewake` Stop hook (`agent-bridge rewake-hook`) runs in the background after a turn
 * ends and long-polls this endpoint. When it returns messages, the hook prints them and exits 2, which
 * wakes the session with them. So the turn never has to stay open waiting.
 */
export const SESSIONS_DIR = "sessions";
const HOST = "127.0.0.1";
const SECRET_BYTES = 24;
/** One long poll; the hook polls again until its own timeout. */
export const REWAKE_POLL_MS = 4 * 60 * 1000; // below fetch's 5-minute response-headers timeout

export interface RewakeRegistration {
  port: number;
  secret: string;
  pid: number;
}

export function sessionFile(home: string, sessionId: string): string {
  return join(home, SESSIONS_DIR, `${sessionId.replace(/[^\w-]/g, "_")}.json`);
}

export class RewakeEndpoint {
  private server: Server | null = null;
  private readonly secret = randomBytes(SECRET_BYTES).toString("hex");
  private port = 0;
  private registered: string | null = null;
  /** Only the newest waiter gets messages; an older one (from an earlier turn) is released empty. */
  private waiter: AbortController | null = null;

  constructor(
    private readonly home: string,
    private readonly node: BridgeNode,
    /** Messages that should wake the session. */
    private readonly shouldWake: (m: BridgeMessage) => boolean,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${HOST}`);
      if (url.pathname !== "/wait" || !tokensEqual(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), this.secret)) {
        res.writeHead(403).end();
        return;
      }
      this.waiter?.abort("superseded");
      const ac = new AbortController();
      this.waiter = ac;
      res.on("close", () => ac.abort("closed"));
      void this.node.waitForMessage(REWAKE_POLL_MS, this.shouldWake, ac.signal).then((first) => {
        if (this.waiter === ac) this.waiter = null;
        let text = "";
        if (first && !res.destroyed) {
          const msgs = this.node.unread().filter(this.shouldWake);
          this.node.markRead(msgs.map((m) => m.id));
          text = formatMessages(msgs, { header: "[agent-bridge] Something you were waiting for arrived:" });
          this.log.info("waking the session", { count: msgs.length });
        }
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        // superseded: a newer turn's hook waits now, so this one should end quietly.
        res.end(JSON.stringify({ text, superseded: ac.signal.reason === "superseded" }));
      });
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, HOST, () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** Publish the endpoint for this Claude session id so the hook can find it. */
  register(sessionId: string): void {
    if (!this.server || this.registered === sessionId) return;
    const file = sessionFile(this.home, sessionId);
    mkdirSync(join(this.home, SESSIONS_DIR), { recursive: true });
    const reg: RewakeRegistration = { port: this.port, secret: this.secret, pid: process.pid };
    writeFileSync(file, JSON.stringify(reg), { mode: 0o600 });
    if (this.registered) rmSync(sessionFile(this.home, this.registered), { force: true });
    this.registered = sessionId;
    this.log.debug("rewake endpoint registered", { sessionId });
  }

  async stop(): Promise<void> {
    this.waiter?.abort("superseded");
    if (this.registered) rmSync(sessionFile(this.home, this.registered), { force: true });
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}
