import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "./logger.js";
import { tokensEqual } from "./token.js";

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
/** Child side: a hook must never hang on the parent. */
const CHILD_REQUEST_TIMEOUT_MS = 5_000;

export interface LinkMessage {
  id: string;
  body: string;
}

export class ParentLink {
  private server: Server | null = null;
  private readonly secret = randomBytes(SECRET_BYTES).toString("hex");
  private url = "";
  private pending: LinkMessage[] = [];

  constructor(
    private readonly parentName: string,
    /** A message from the subagent to its parent. */
    private readonly onMessage: (body: string, replyTo: string | null) => void,
    private readonly log: Logger,
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
  post(body: string): LinkMessage {
    const m = { id: randomUUID(), body };
    this.pending.push(m);
    return m;
  }

  /** Stop the link; returns the messages the subagent never picked up (they become a follow-up). */
  async close(): Promise<string[]> {
    const left = this.pending.splice(0).map((m) => m.body);
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
      if (messages.length) this.log.info("subagent picked up messages", { count: messages.length });
      return { messages };
    }
    if (req.method === "POST" && req.url === "/message") {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_REQUEST_BYTES) throw new Error("request too large");
      }
      const body = JSON.parse(raw) as { body?: unknown; reply_to?: unknown };
      const text = String(body.body ?? "").trim();
      if (!text) throw new Error("empty message");
      this.onMessage(text, typeof body.reply_to === "string" ? body.reply_to : null);
      return { ok: true };
    }
    throw new Error("not found");
  }
}

/** Child side: the link to the session that runs this subagent, if there is one. */
export interface ParentClient {
  name: string;
  inbox(): Promise<LinkMessage[]>;
  send(body: string, replyTo?: string): Promise<void>;
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
  };
}
