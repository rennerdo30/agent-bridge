import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "./logger.js";
import { tokensEqual } from "./token.js";
import type { BridgeMessage, SendResult, SiblingPeer } from "./protocol.js";
import { MAX_BODY_CHARS } from "./constants.js";
import type { JobMessagingPolicy } from "./job-messaging.js";

/**
 * Live link between a session and a subagent it runs, like a native subagent's: the session's messages
 * reach the subagent while it works (its agent-bridge server picks them up at the next hook: after a
 * tool call, before a model step, or before it ends its turn), and the subagent can answer at once.
 * Local HTTP on 127.0.0.1 with a random port and secret per run; only the child that got them in its
 * environment can use it.
 */
export const PARENT_URL_ENV = "AGENT_BRIDGE_PARENT_URL";
export const PARENT_TOKEN_ENV = "AGENT_BRIDGE_PARENT_TOKEN";
/** Peer name of the session that runs the subagent, so the subagent knows whom it talks to. */
export const PARENT_NAME_ENV = "AGENT_BRIDGE_PARENT_NAME";
const HOST = "127.0.0.1";
const SECRET_BYTES = 24;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_NOTE_CHARS = 200;
/** Child side: a hook must never hang on the parent. */
const CHILD_REQUEST_TIMEOUT_MS = 5_000;

export interface LinkMessage {
  id: string;
  body: string;
  sibling?: BridgeMessage;
}

export interface SiblingClient {
  peers(): Promise<SiblingPeer[]>;
  send(to: string, body: string, replyTo?: string): Promise<SendResult>;
  policy?(): Promise<JobMessagingPolicy>;
  consumed?(ids: string[]): void;
}

export class ParentLink {
  private server: Server | null = null;
  private readonly secret = randomBytes(SECRET_BYTES).toString("hex");
  private url = "";
  private pending: LinkMessage[] = [];
  /** Picked up by the subagent but not answered yet (it may have seen them only as it finished). */
  private unanswered: LinkMessage[] = [];

  constructor(
    private readonly parentName: string,
    /** A message from the subagent to its parent. */
    private readonly onMessage: (body: string, replyTo: string | null) => void,
    private readonly log: Logger,
    /** The subagent's own estimate of how far it is (report_progress). */
    private readonly onProgress: (percent: number, note: string, eta?: { etaAt: number; etaReportedAt: number }) => void = () => {},
    private readonly siblings?: SiblingClient,
    private readonly onEscalate?: (body: string) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        (body) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        },
        (err) => {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, HOST, () => resolve());
    });
    this.url = `http://${HOST}:${(this.server.address() as AddressInfo).port}`;
  }

  childEnv(): Record<string, string> {
    return { [PARENT_URL_ENV]: this.url, [PARENT_TOKEN_ENV]: this.secret, [PARENT_NAME_ENV]: this.parentName };
  }

  /** Queue a message for the subagent; it gets it at its next step. */
  post(body: string, sibling?: BridgeMessage): LinkMessage {
    const m = { id: sibling?.id ?? randomUUID(), body, ...(sibling ? { sibling } : {}) };
    this.pending.push(m);
    return m;
  }

  /** A task report answers instructions already consumed in that turn; no separate ack is needed. */
  reportCompleted(): void {
    this.unanswered = this.unanswered.filter((m) => m.sibling);
  }

  /**
   * Stop the link; returns the messages the subagent never picked up or never answered (they become a
   * follow-up, so a message that arrived as it finished is not lost).
   */
  async close(): Promise<string[]> {
    // Only supervisor instructions can start a continuation. Sibling mail remains in broker history
    // (unconsumed mail stays in its inbox) and must never replace a completed task's report.
    const left = [...this.unanswered.splice(0), ...this.pending.splice(0)].filter((m) => !m.sibling).map((m) => m.body);
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
    return left;
  }

  private async handle(req: IncomingMessage): Promise<unknown> {
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokensEqual(auth, this.secret)) throw new Error("unauthorized");
    if (req.method === "POST" && req.url === "/inbox") {
      const messages = this.pending.splice(0);
      this.unanswered.push(...messages);
      this.siblings?.consumed?.(messages.filter((m) => m.sibling).map((m) => m.id));
      if (messages.length) this.log.info("subagent picked up messages", { count: messages.length });
      return { messages };
    }
    if (req.method === "POST" && req.url === "/progress") {
      const body = JSON.parse(await readBody(req)) as { percent?: unknown; note?: unknown; eta_minutes?: unknown };
      const percent = Math.round(Number(body.percent));
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("percent must be 0-100");
      let eta: { etaAt: number; etaReportedAt: number } | undefined;
      if (body.eta_minutes !== undefined) {
        if (typeof body.eta_minutes !== "number" || !Number.isFinite(body.eta_minutes) || body.eta_minutes < 0 || body.eta_minutes > 1440) throw new Error("eta_minutes must be 0-1440");
        const etaReportedAt = Date.now();
        eta = { etaAt: etaReportedAt + body.eta_minutes * 60_000, etaReportedAt };
      }
      this.onProgress(percent, String(body.note ?? "").trim().slice(0, MAX_NOTE_CHARS), eta);
      return { ok: true };
    }
    if (req.method === "POST" && req.url === "/siblings") {
      return { peers: this.siblings ? await this.siblings.peers() : [] };
    }
    if (req.method === "POST" && req.url === "/messaging-policy") {
      return this.siblings?.policy ? this.siblings.policy() : { maxHops: 0, sendTo: [] };
    }
    if (req.method === "POST" && req.url === "/sibling-message") {
      if (!this.siblings) throw new Error("sibling messaging unavailable");
      const body = JSON.parse(await readBody(req)) as { to?: unknown; body?: unknown; reply_to?: unknown };
      if (typeof body.to !== "string" || typeof body.body !== "string" || !body.body.trim()) throw new Error("invalid sibling message");
      if (body.body.length > MAX_BODY_CHARS) throw new Error("message too large");
      const replyTo = typeof body.reply_to === "string" ? body.reply_to : undefined;
      const result = await this.siblings.send(body.to, body.body, replyTo);
      // Sibling replies acknowledge only their own conversation, never a pending parent request.
      if (replyTo) this.unanswered = this.unanswered.filter((m) => m.sibling?.conversationId !== result.messages[0]?.conversationId);
      return result;
    }
    if (req.method === "POST" && req.url === "/message") {
      const body = JSON.parse(await readBody(req)) as { body?: unknown; reply_to?: unknown };
      const text = String(body.body ?? "").trim();
      if (!text) throw new Error("empty message");
      // Any parent answer counts for its requests; sibling chat remains separate.
      this.unanswered = this.unanswered.filter((m) => m.sibling);
      this.onMessage(text, typeof body.reply_to === "string" ? body.reply_to : null);
      return { ok: true };
    }
    if (req.method === "POST" && req.url === "/escalate") {
      if (!this.onEscalate) throw new Error("approval escalation unavailable");
      const body = JSON.parse(await readBody(req)) as { body?: unknown };
      if (typeof body.body !== "string" || !body.body.trim() || body.body.length > MAX_BODY_CHARS) throw new Error("invalid escalation");
      await this.onEscalate(body.body);
      return { ok: true };
    }
    throw new Error("not found");
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_REQUEST_BYTES) throw new Error("request too large");
  }
  return raw;
}

/** Child side: the link to the session that runs this subagent, if there is one. */
export interface ParentClient {
  escalate?: (body: string) => Promise<void>;
  name: string;
  inbox(): Promise<LinkMessage[]>;
  send(body: string, replyTo?: string): Promise<void>;
  progress(percent: number, note: string, etaMinutes?: number): Promise<void>;
  siblings: SiblingClient;
}

export function parentFromEnv(env: NodeJS.ProcessEnv = process.env): ParentClient | null {
  const url = env[PARENT_URL_ENV];
  const token = env[PARENT_TOKEN_ENV];
  if (!url || !token) return null;
  const call = async (path: string, payload: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CHILD_REQUEST_TIMEOUT_MS),
    });
    const out = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(out.error ?? `HTTP ${res.status}`));
    return out;
  };
  return {
    name: env[PARENT_NAME_ENV] || "parent",
    inbox: async () => ((await call("/inbox", {})).messages as LinkMessage[]) ?? [],
    send: async (body, replyTo) => void (await call("/message", { body, reply_to: replyTo ?? null })),
    escalate: async (body) => void (await call("/escalate", { body })),
    progress: async (percent, note, etaMinutes) => void (await call("/progress", { percent, note, eta_minutes: etaMinutes })),
    siblings: {
      peers: async () => ((await call("/siblings", {})).peers as SiblingPeer[]) ?? [],
      send: async (to, body, replyTo) => (await call("/sibling-message", { to, body, reply_to: replyTo })) as unknown as SendResult,
      policy: async () => await call("/messaging-policy", {}) as unknown as JobMessagingPolicy,
    },
  };
}
