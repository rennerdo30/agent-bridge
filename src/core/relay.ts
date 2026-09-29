import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "./logger.js";
import { tokensEqual } from "./token.js";

/**
 * Permission relay: a delegated subagent that needs a permission asks the process that started it
 * (the parent agent-bridge MCP server), which asks the user. Local HTTP on 127.0.0.1 with a random port
 * and a random secret per run; only the child that got the secret in its environment can use it.
 */
export const RELAY_URL_ENV = "AGENT_BRIDGE_RELAY_URL";
export const RELAY_TOKEN_ENV = "AGENT_BRIDGE_RELAY_TOKEN";
const RELAY_HOST = "127.0.0.1";
const RELAY_PATH = "/permission";
const MAX_REQUEST_BYTES = 256 * 1024;
const SECRET_BYTES = 24;
const KEEP_ALIVE_MS = 60_000;

export interface PermissionRequest {
  /** Which agent asks, e.g. "codex". */
  agent: string;
  /** Tool or permission kind, e.g. "Bash", "apply_patch", "edit". */
  tool: string;
  /** What exactly: the command, file path or patch summary. */
  detail: string;
  cwd?: string;
}

export type PermissionDecision = { allow: true } | { allow: false; message: string };

export type PermissionHandler = (req: PermissionRequest) => Promise<PermissionDecision>;

export class PermissionRelay {
  private server: Server | null = null;
  private readonly secret = randomBytes(SECRET_BYTES).toString("hex");
  private url = "";

  constructor(
    private readonly handler: PermissionHandler,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      // The user may take longer than fetch's 5-minute header and body timeouts: answer the headers at once
      // and keep the body alive with whitespace (valid before JSON) until the decision is in.
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      const keepAlive = setInterval(() => res.write(" "), KEEP_ALIVE_MS);
      void this.handle(req)
        .catch((err): PermissionDecision => {
          this.log.warn("permission relay request failed", { err: (err as Error).message });
          return { allow: false, message: "agent-bridge relay error" };
        })
        .then((body) => {
          clearInterval(keepAlive);
          res.end(JSON.stringify(body));
        });
    });
    // Answers can take as long as the user needs.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, RELAY_HOST, () => resolve());
    });
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://${RELAY_HOST}:${port}${RELAY_PATH}`;
    this.log.debug("permission relay listening", { url: this.url });
  }

  /** Environment variables that let a child process reach this relay. */
  childEnv(): Record<string, string> {
    return { [RELAY_URL_ENV]: this.url, [RELAY_TOKEN_ENV]: this.secret };
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private async handle(req: IncomingMessage): Promise<PermissionDecision> {
    if (req.method !== "POST" || req.url !== RELAY_PATH) throw new Error("not found");
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokensEqual(auth, this.secret)) throw new Error("unauthorized");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_REQUEST_BYTES) throw new Error("request too large");
    }
    const body = JSON.parse(raw) as Partial<PermissionRequest>;
    const request: PermissionRequest = {
      agent: String(body.agent ?? "subagent"),
      tool: String(body.tool ?? "unknown"),
      detail: String(body.detail ?? "").slice(0, 4_000),
      cwd: body.cwd ? String(body.cwd) : undefined,
    };
    this.log.info("permission requested by subagent", { agent: request.agent, tool: request.tool });
    const decision = await this.handler(request);
    this.log.info("permission decided", { tool: request.tool, allow: decision.allow });
    return decision;
  }
}

/** Child side: ask the parent. Any failure means "deny", never "allow". */
export async function askRelay(req: PermissionRequest, env: NodeJS.ProcessEnv = process.env): Promise<PermissionDecision> {
  const url = env[RELAY_URL_ENV];
  const token = env[RELAY_TOKEN_ENV];
  if (!url || !token) return { allow: false, message: "agent-bridge: no permission relay for this run" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(req),
    });
    const body = (await res.json()) as PermissionDecision;
    return body.allow === true ? { allow: true } : { allow: false, message: (body as { message?: string }).message ?? "denied" };
  } catch (err) {
    return { allow: false, message: `agent-bridge: permission relay unreachable (${(err as Error).message})` };
  }
}
