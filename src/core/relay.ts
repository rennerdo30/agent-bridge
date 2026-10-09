import { appendContextEvent } from "./context-journal.js";
import { JOBS_FILE } from "./constants.js";
import { readStore } from "../mcp/jobs.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "./logger.js";
import { tokensEqual } from "./token.js";
import { pidAlive } from "./delegate.js";
import { archiveFile } from "./json-store.js";

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
  reason?: string;
  /** A terminal Codex auto-review refusal needs an explicit supervisor decision, not an allowlist. */
  automaticReview?: boolean;
  /** Set when `detail` had to be cut: its original length. Such a request is refused, never decided (AB-241). */
  detailLength?: number;
}

/**
 * The longest command, path or patch text an approval shows. A longer one is not cut silently: the request is
 * refused, because an owner must never allow a command whose tail they could not see (AB-241).
 */
export const MAX_PERMISSION_DETAIL_CHARS = 16_000;

/** `detail` within the reviewable limit, with `detailLength` recording the original length when it was cut. */
export function boundedDetail(detail: string): Pick<PermissionRequest, "detail" | "detailLength"> {
  return detail.length > MAX_PERMISSION_DETAIL_CHARS ? { detail: detail.slice(0, MAX_PERMISSION_DETAIL_CHARS), detailLength: detail.length } : { detail };
}

/** The refusal for a request whose text was cut, or null when the whole request can be reviewed. */
export function unreviewable(req: PermissionRequest): PermissionDecision | null {
  if (!(typeof req.detailLength === "number" && req.detailLength > req.detail.length) && req.detail.length <= MAX_PERMISSION_DETAIL_CHARS) return null;
  const length = Math.max(req.detailLength ?? 0, req.detail.length);
  return { allow: false, message: `agent-bridge: denied: this ${req.tool} request is too long to review (${length} characters, limit ${MAX_PERMISSION_DETAIL_CHARS}). Split it into smaller steps or write the script to a file first.` };
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
    const detail = boundedDetail(String(body.detail ?? ""));
    const request: PermissionRequest = {
      agent: String(body.agent ?? "subagent"),
      tool: String(body.tool ?? "unknown"),
      ...detail,
      ...(typeof body.detailLength === "number" && body.detailLength > (detail.detailLength ?? 0) ? { detailLength: body.detailLength } : {}),
      cwd: body.cwd ? String(body.cwd) : undefined,
      ...(typeof body.reason === "string" ? { reason: body.reason.slice(0, MAX_APPROVAL_REASON_CHARS) } : {}),
    };
    const refused = unreviewable(request);
    if (refused) {
      this.log.warn("permission request too long to review; denied", { agent: request.agent, tool: request.tool, length: request.detailLength });
      return refused;
    }
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

const APPROVALS_DIR = "approvals";
const APPROVAL_ID = /^[0-9a-f-]{36}$/;
const ANSWER_PATH = "/answer";
const ANSWER_TIMEOUT_MS = 5_000;
const MAX_PORT = 65_535;
export const MAX_APPROVAL_REASON_CHARS = 4_000;

/** Public dashboard data. Times are milliseconds since the Unix epoch; text is untrusted plain text. */
export interface PendingApproval {
  parentJob?: string;
  rootSession?: string;
  id: string;
  owner: string;
  job: string;
  agent: string;
  tool: string;
  command: string;
  reason: string;
  askedAt: number;
  deadline: number;
}

interface ApprovalRecord extends PendingApproval {
  pid: number;
  port: number;
  token: string;
}

export type ApprovalAnswer = { decision: "allow" | "deny"; reason?: string; source?: "dashboard" | "MCP decide" };
export type ApprovalAnswerResult = "answered" | "expired" | "unavailable";

/**
 * Publish the waiting callback from its owning process (a session or its detached runner). The private
 * capability stays in the home directory, never in dashboard JSON. Both callers settle the same callback.
 */
export async function publishApproval(home: string, approval: PendingApproval, answer: (body: string, by: string) => boolean | Promise<boolean>): Promise<() => void> {
  await appendContextEvent(home,{kind:"approval",agent:approval.agent,job:approval.job,payload:{event:"requested",...approval}});
  if (!APPROVAL_ID.test(approval.id)) throw new Error("invalid approval id");
  const token = randomBytes(SECRET_BYTES).toString("hex");
  const dir = join(home, APPROVALS_DIR);
  const file = join(dir, `${approval.id}.json`);
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    void (async () => {
      if (req.method !== "POST" || req.url !== ANSWER_PATH || !tokensEqual(String(req.headers.authorization ?? ""), `Bearer ${token}`)) return reply(403, { error: "forbidden" });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_REQUEST_BYTES) return reply(400, { error: "request too large" });
      }
      const body = JSON.parse(raw) as ApprovalAnswer;
      if (!body || (body.decision !== "allow" && body.decision !== "deny") || (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > MAX_APPROVAL_REASON_CHARS))) return reply(400, { error: "invalid answer" });
      if (body.source !== undefined && body.source !== "dashboard" && body.source !== "MCP decide") return reply(400, { error: "invalid source" });
      const accepted = Date.now() < approval.deadline && await answer(`${body.decision}${body.reason ? `: ${body.reason}` : ""}`, body.source ?? "dashboard");
      await appendContextEvent(home,{kind:"approval",agent:approval.agent,job:approval.job,payload:{event:"answered",approval:approval.id,...body,accepted}});
      reply(accepted ? 200 : 409, { outcome: accepted ? "answered" : "expired" });
    })().catch(() => reply(400, { error: "invalid answer" }));
  });
  server.requestTimeout = ANSWER_TIMEOUT_MS;
  server.headersTimeout = ANSWER_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, RELAY_HOST, resolve);
  });
  server.unref();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ ...approval, pid: process.pid, port: (server.address() as AddressInfo).port, token }), { mode: 0o600, flag: "wx" });
  } catch (err) {
    server.close();
    throw err;
  }
  return () => {
    try { archiveFile(file); }
    finally { server.close(); }
  };
}

function readApproval(home: string, id: string): ApprovalRecord | null {
  if (!APPROVAL_ID.test(id)) return null;
  try {
    const r = JSON.parse(readFileSync(join(home, APPROVALS_DIR, `${id}.json`), "utf8")) as ApprovalRecord;
    if (r.id !== id || !Number.isInteger(r.pid) || r.pid < 1 || !pidAlive(r.pid) || !Number.isSafeInteger(r.deadline) || r.deadline <= Date.now() || !Number.isSafeInteger(r.askedAt) || r.deadline <= r.askedAt || !Number.isInteger(r.port) || r.port < 1 || r.port > MAX_PORT || typeof r.token !== "string" || !r.token) return null;
    if (![r.owner, r.job, r.agent, r.tool, r.command, r.reason].every((value) => typeof value === "string")) return null;
    return r;
  } catch { return null; }
}

export function listPendingApprovals(home: string): PendingApproval[] {
  let files: string[];
  try { files = readdirSync(join(home, APPROVALS_DIR)); } catch { return []; }
  const jobs = readStore(join(home, JOBS_FILE));
  return files.flatMap((file) => {
    if (!file.endsWith(".json")) return [];
    const r = readApproval(home, file.slice(0, -5));
    const job = r && jobs.find((j) => j.name === r.job && j.ownershipHistory?.length);
    if (r && job) { r.owner = job.rootName ?? job.owner ?? r.owner; r.rootSession = job.rootSession; r.parentJob = job.parentJob; }
    return r ? [{ id: r.id, owner: r.owner, job: r.job, agent: r.agent, tool: r.tool, command: r.command, reason: r.reason, askedAt: r.askedAt, deadline: r.deadline,
      ...(typeof r.parentJob === "string" ? { parentJob: r.parentJob } : {}), ...(typeof r.rootSession === "string" ? { rootSession: r.rootSession } : {}) }] : [];
  }).sort((a, b) => a.askedAt - b.askedAt);
}

export function newApprovalId(): string { return randomUUID(); }

/** A missing, timed-out or previously answered id never becomes a follow-up to the job. */
export async function answerPendingApproval(home: string, id: string, body: ApprovalAnswer): Promise<ApprovalAnswerResult> {
  const r = readApproval(home, id);
  if (!r) return "expired";
  try {
    const res = await fetch(`http://${RELAY_HOST}:${r.port}${ANSWER_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${r.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    });
    return res.status === 200 ? "answered" : res.status === 409 ? "expired" : "unavailable";
  } catch { return readApproval(home, id) ? "unavailable" : "expired"; }
}
