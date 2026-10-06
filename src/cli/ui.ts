import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BridgeClient } from "../core/client.js";
import { APP_VERSION, JOBS_FILE, MAX_BODY_CHARS, PROTOCOL_VERSION } from "../core/constants.js";
import type { Logger } from "../core/logger.js";
import { BridgeNode } from "../core/node.js";
import { resolveDbPath } from "../core/paths.js";
import { BridgeError, CODING_AGENTS, type PeerInfo } from "../core/protocol.js";
import { readModels, type ModelReport } from "../core/models.js";
import { RUNS_DIR_NAME, runMetaPath, type RunMeta } from "../core/runfeed.js";
import { loadOrCreateToken, tokensEqual } from "../core/token.js";
import { loadConfig } from "../core/config.js";
import { readUsage, type UsageReport } from "../core/usage.js";
import { controlDashboardJob, JobControlError, type DashboardJobCommand } from "../core/job-control.js";
import { JOB_SETTING_KEYS } from "../mcp/job-settings.js";
import { UI_PAGE } from "./ui-page.js";
import { networkConfigSchema } from "../network/config.js";
import { planFirewall, detectFirewall, applyWindowsFirewall } from "../network/firewall.js";
import { parseNetworkAddress } from "../network/address.js";
import type { Op, RequestMap } from "../core/protocol.js";
import { readJsonStore } from "../core/json-store.js";
import { listNativeSubagents, readTranscript, TRANSCRIPT_ID, validTranscriptCursor, type TranscriptPaths } from "../core/transcripts/index.js";
import { readDecisions, decisionScopeSchema, MAX_DECISION_TEXT_CHARS, MAX_DECISION_TOPIC_CHARS, type DecisionsArgs } from "../core/decisions.js";

/**
 * `agent-bridge ui`: a local dashboard for sessions, delegated runs and messages.
 * Bound to 127.0.0.1; every request needs a per-launch secret (given once in the URL, then a cookie).
 */
const UI_HOST = "127.0.0.1";
const COOKIE = "ab_ui";
const SECRET_BYTES = 24;
const MAX_RUNS = 50;
const TASK_PREVIEW_CHARS = 300;
const MAX_MESSAGES = 200;
const MAX_LOG_CHUNK = 512 * 1024;
const MAX_POST_BYTES = 256 * 1024;
/** A run whose log has not been written for this long (heartbeats come every minute) was interrupted. */
const STALE_RUN_MS = 150_000;
const UI_PEER_NAME = "you";
const ALLOWED_HOSTS = new Set([UI_HOST, "localhost"]);
const RUN_NAME = /^[\w.-]+\.log$/;

export interface RunSummary extends RunMeta {
  name: string;
  agent: string;
  header: string;
  startedAt: number;
  updatedAt: number;
  status: "running" | "done" | "failed" | "interrupted";
  last: string;
  /** Start of the prompt, for lists. */
  task: string;
}

/** Parse the head and tail of a run log written by runfeed.ts, plus its metadata (older runs: from the header). */
export function summarizeRun(file: string, text: string, mtimeMs: number, now: number, meta: RunMeta = {}): RunSummary {
  const lines = text.split("\n").filter(Boolean);
  const finished = [...lines].reverse().find((l) => / finished after \d+s · /.test(l));
  const last = (finished ?? lines.at(-1) ?? "").replace(/^\d\d:\d\d:\d\d /, "");
  const status: RunSummary["status"] = finished
    ? / · done$/.test(finished)
      ? "done"
      : "failed"
    : now - mtimeMs > STALE_RUN_MS
      ? "interrupted"
      : "running";
  const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-([a-z]+)-/.exec(file);
  const startedAt = m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : mtimeMs;
  const header = (lines[0] ?? "").replace(/^\d\d:\d\d:\d\d /, "");
  const end = lines.findIndex((l) => l.trim() === "---");
  const task = lines
    .slice(1, end > 0 ? end : 1)
    .map((l) => l.trim())
    .join(" ")
    .slice(0, TASK_PREVIEW_CHARS);
  return {
    by: / by ([\w.-]+)/.exec(header)?.[1],
    workdir: / in (.+?), access /.exec(header)?.[1],
    continues: /, continues (\S+)/.exec(header)?.[1] ?? null,
    ...meta,
    name: file.replace(/\.log$/, ""),
    agent: m?.[7] ?? "agent",
    header,
    startedAt,
    updatedAt: mtimeMs,
    status,
    last,
    task,
  };
}

export function listRuns(home: string, now = Date.now()): RunSummary[] {
  const dir = join(home, RUNS_DIR_NAME);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => RUN_NAME.test(f))
    .map((f) => ({ f, st: statSync(join(dir, f)) }))
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    .slice(0, MAX_RUNS)
    .map(({ f, st }) => summarizeRun(f, readFileSync(join(dir, f), "utf8"), st.mtimeMs, now, readMeta(join(dir, runMetaPath(f)))));
}

function readMeta(file: string): RunMeta {
  try {
    return (readJsonStore(file) ?? {}) as RunMeta;
  } catch {
    return {};
  }
}

/** What the dashboard reads of a stored job: its owner and the settings its next turn uses. */
export interface StoredJobView {
  owner: string | null;
  next: Record<string, unknown>;
}

/** Jobs from the sessions' store (`{ jobs: [...] }`; before 0.26 a bare array). Read-only and best effort. */
export function readStoredJobs(home: string): Map<string, StoredJobView> {
  const out = new Map<string, StoredJobView>();
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(join(home, JOBS_FILE), "utf8"));
  } catch {
    return out;
  }
  const list: unknown[] = Array.isArray(stored) ? stored : Array.isArray((stored as { jobs?: unknown })?.jobs) ? (stored as { jobs: unknown[] }).jobs : [];
  for (const j of list) {
    if (!j || typeof j !== "object") continue;
    const { name, owner, args } = j as { name?: unknown; owner?: unknown; args?: unknown };
    if (typeof name !== "string") continue;
    const saved = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    out.set(name, {
      owner: typeof owner === "string" && owner ? owner : null,
      next: Object.fromEntries(JOB_SETTING_KEYS.filter((key) => saved[key] !== undefined).map((key) => [key, saved[key]])),
    });
  }
  return out;
}

/** A server may have adopted a job from an earlier stand-in name since its log was written. */
function jobOwner(home: string, job: string, original: string): string {
  return readStoredJobs(home).get(job)?.owner ?? original;
}

export type DashboardPeer = PeerInfo & { subagent: boolean; parent: string | null };

/**
 * Sessions in a subagent worktree are subagents, not sessions of their own (older versions let them join):
 * show them under the session whose run used that folder.
 */
export function classifyPeers(peers: PeerInfo[], runs: RunSummary[], home: string): DashboardPeer[] {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const worktrees = `${norm(join(home, "worktrees"))}/`;
  return peers.map((p) => {
    const cwd = norm(p.cwd ?? "");
    const subagent = cwd.startsWith(worktrees);
    const run = subagent ? runs.find((r) => r.workdir && norm(r.workdir) === cwd) : undefined;
    return { ...p, subagent, parent: run?.by ?? null };
  });
}

interface MessageRow {
  id: string;
  from_name: string;
  from_agent: string;
  to_target: string;
  recipients: string;
  body: string;
  created_at: number;
  hop: number;
  reply_to: string | null;
}

/** Recent messages (one row per message, recipients joined), newest first; not the control messages to job runners. Read-only access. */
export function recentMessages(dbPath: string): MessageRow[] {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare(
      `SELECT id, from_name, from_agent, to_target, group_concat(recipient, ', ') AS recipients, body, created_at, hop, reply_to
       FROM messages WHERE conversation_id NOT LIKE 'jobctl-%' GROUP BY id ORDER BY created_at DESC LIMIT ?`,
    );
    return stmt.all(MAX_MESSAGES) as unknown as MessageRow[];
  } finally {
    db.close();
  }
}

async function brokerPeers(pipe: string, token: string, log: Logger): Promise<{ brokerPid: number | null; peers: PeerInfo[] }> {
  let client: BridgeClient | null = null;
  try {
    client = await BridgeClient.connect(pipe, log);
    const { brokerPid } = await client.request("auth", { protocol: PROTOCOL_VERSION, token });
    return { brokerPid, peers: await client.request("peers", {}) };
  } catch {
    return { brokerPid: null, peers: [] };
  } finally {
    client?.close();
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_POST_BYTES) throw new Error("request too large");
  }
  return JSON.parse(raw || "{}");
}

function cookieSecret(req: IncomingMessage): string {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]+)`).exec(String(req.headers.cookie ?? ""));
  return m?.[1] ?? "";
}

/** This PC's IPv4 addresses on its networks, so the other PC knows what to connect to. */
export function lanAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  return Object.values(interfaces)
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal && !a.address.startsWith(LINK_LOCAL_PREFIX))
    .map((a) => a.address);
}
const LINK_LOCAL_PREFIX = "169.254.";

const MAX_NETWORK_ERROR_CHARS = 240;
/** A run this long of code characters may be part of a pairing secret. */
const SECRET_LIKE = /[A-Za-z0-9_-]{24,}/;

/**
 * The broker's own refusal (e.g. "networking is disabled"), shown as is: those are fixed texts. Anything else,
 * or anything that could quote a pairing code, gets the generic message.
 */
export function safeNetworkError(err: unknown): string | null {
  if (!(err instanceof BridgeError)) return null;
  const message = err.message.trim();
  return message && message.length <= MAX_NETWORK_ERROR_CHARS && !SECRET_LIKE.test(message) ? message : null;
}

/** Subagent commands by path: the request body as a command for the owning session, or null when invalid. */
const JOB_COMMANDS: Record<string, (body: Record<string, unknown>) => DashboardJobCommand | null> = {
  "/api/subagents/message": (body) => {
    const text = typeof body.body === "string" ? body.body.trim() : "";
    return text && text.length <= MAX_BODY_CHARS ? { type: "message", body: text } : null;
  },
  // The owning session checks the values against the job's agent (job-settings.ts).
  "/api/subagents/settings": (body) =>
    body.settings && typeof body.settings === "object" && !Array.isArray(body.settings) && Object.keys(body.settings).length ? { type: "settings", settings: body.settings as Record<string, unknown> } : null,
};

export interface UiOptions {
  home: string;
  /** Per-launch secret; generated when omitted. */
  secret?: string;
  pipe: string;
  port: number;
  log: Logger;
  /** Reads the agents' usage limits (default: each CLI, see usage.ts); replaceable for tests. */
  usage?: () => Promise<UsageReport[]>;
  models?: () => Promise<ModelReport[]>;
  /** CLI storage roots; default to the current user's CLI homes. Replaceable for tests. */
  transcripts?: TranscriptPaths;
}

/** Usage is read by running each CLI briefly: keep it this long unless the page asks for a refresh. */
const USAGE_CACHE_MS = 5 * 60 * 1000;
/** A refresh click re-reads at most this often (each read starts the CLIs). */
const USAGE_REFRESH_MIN_MS = 15 * 1000;

function readAllUsage(home: string, log: Logger): Promise<UsageReport[]> {
  const cfg = loadConfig(home, "other", log);
  return Promise.all([
    readUsage("claude", cfg.claudeBin, home, log),
    readUsage("codex", cfg.codexBin, home, log),
    readUsage("opencode", cfg.opencodeBin, home, log, cfg.opencodeModel ?? null),
  ]);
}

export async function startUi(opts: UiOptions): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const secret = opts.secret ?? randomBytes(SECRET_BYTES).toString("hex");
  const token = loadOrCreateToken(opts.home);
  const dbPath = resolveDbPath(opts.home);
  /** The lazily started "you" peer; one shared start, so concurrent sends never start two. */
  let sender: Promise<BridgeNode> | null = null;
  const getSender = (): Promise<BridgeNode> => {
    sender ??= (async () => {
      const node = new BridgeNode({ pipePath: opts.pipe, token, dbPath, agent: "other", name: UI_PEER_NAME, cwd: opts.home, autoWake: false, log: opts.log, network: { home: opts.home, config: loadConfig(opts.home, "other", opts.log).network } });
      try {
        await node.start();
        return node;
      } catch (err) {
        // Let the next send start afresh instead of keeping a half-started node (and its retries).
        sender = null;
        await node.stop();
        throw err;
      }
    })();
    return sender;
  };

  const networkRequest = async <O extends Op>(op: O, args: RequestMap[O][0]): Promise<RequestMap[O][1]> => {
    const client = await BridgeClient.connect(opts.pipe, opts.log);
    try {
      await client.request("auth", { protocol: PROTOCOL_VERSION, token });
      return await client.request(op, args);
    } finally { client.close(); }
  };

  let usage: { at: number; reports: Promise<UsageReport[]> } | null = null;
  const getUsage = (refresh: boolean): Promise<UsageReport[]> => {
    if (!usage || (refresh && Date.now() - usage.at > USAGE_REFRESH_MIN_MS) || Date.now() - usage.at > USAGE_CACHE_MS) {
      const reports = (opts.usage ?? (() => readAllUsage(opts.home, opts.log)))();
      usage = { at: Date.now(), reports };
      // A failed read is not kept: the next request tries again.
      reports.catch(() => (usage = null));
    }
    return usage.reports;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
    if (!ALLOWED_HOSTS.has(host)) return send(res, 403, { error: "forbidden host" });
    const url = new URL(req.url ?? "/", `http://${UI_HOST}`);

    // First visit: the secret comes in the URL once, then lives in an HttpOnly cookie.
    const fromUrl = url.searchParams.get("t");
    if (url.pathname === "/" && fromUrl) {
      if (!tokensEqual(fromUrl, secret)) return send(res, 403, "Invalid or expired link. Restart `agent-bridge ui`.", "text/plain; charset=utf-8");
      res.writeHead(302, { location: "/", "set-cookie": `${COOKIE}=${secret}; HttpOnly; SameSite=Strict; Path=/` });
      return res.end();
    }
    if (!tokensEqual(cookieSecret(req), secret)) return send(res, 403, "Open the link printed by `agent-bridge ui`.", "text/plain; charset=utf-8");

    if (req.method === "GET" && url.pathname === "/") return send(res, 200, UI_PAGE, "text/html; charset=utf-8");
    if (req.method === "GET" && (url.pathname === "/api/decisions" || /^\/api\/decisions\/[^/]+\/history$/.test(url.pathname))) {
      let args: DecisionsArgs;
      let topic: string | undefined;
      try {
        const scopeText = url.searchParams.get("scope");
        const scope = scopeText ? decisionScopeSchema.parse(scopeText === "all" ? "all" : JSON.parse(scopeText)) : undefined;
        const query = url.searchParams.get("q") ?? undefined;
        if (query && query.length > MAX_DECISION_TEXT_CHARS) throw new Error("query too long");
        if (url.pathname !== "/api/decisions") {
          topic = decodeURIComponent(url.pathname.slice("/api/decisions/".length, -"/history".length)).trim().toLowerCase();
          if (!topic || topic.length > MAX_DECISION_TOPIC_CHARS) throw new Error("invalid topic");
        }
        args = { query, scope, ...(topic ? { topic, history: true } : {}) };
      } catch { return send(res, 400, { error: 'Invalid decisions query, topic or scope. Scope must be "all" or JSON {project: folder}/{sessions: [names or ids]}.' }); }
      const decisions = readDecisions(dbPath, args);
      return send(res, 200, topic ? { topic, decisions } : { decisions });
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const { brokerPid, peers } = await brokerPeers(opts.pipe, token, opts.log);
      const runs = listRuns(opts.home);
      return send(res, 200, {
        version: APP_VERSION,
        brokerPid,
        peers: classifyPeers(peers, runs, opts.home),
        runs,
        messages: recentMessages(dbPath),
        // Saved next-turn settings per job (message_subagent or the dashboard may have changed them).
        jobs: Object.fromEntries([...readStoredJobs(opts.home)].map(([name, j]) => [name, { next: j.next }])),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/network") {
      const status = await networkRequest("networkStatus", {});
      const config = status.config ?? loadConfig(opts.home, "other", opts.log).network;
      return send(res, 200, { ...status, config, addresses: lanAddresses() });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/network/")) {
      if (req.headers["x-agent-bridge"] !== "1") return send(res, 403, { error: "missing header" });
      // Never return or log parsing/validation errors containing a pairing secret.
      try {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { error: "Expected a JSON object." });
        switch (url.pathname) {
          case "/api/network/configure": {
            const current = await networkRequest("networkStatus", {});
            const config = current.config ?? loadConfig(opts.home, "other", opts.log).network;
            const parsed = networkConfigSchema.safeParse({ ...config, ...body });
            if (!parsed.success) return send(res, 400, { error: "Invalid network settings." });
            if (body.confirm !== true) return send(res, 400, { error: "Confirm saving network settings first." });
            return send(res, 200, await networkRequest("networkConfigure", parsed.data));
          }
          case "/api/network/pair": return send(res, 200, await networkRequest("networkPair", {}));
          case "/api/network/link": {
            if (typeof body.address !== "string" || typeof body.code !== "string") return send(res, 400, { error: "Address and code are required." });
            return send(res, 200, await networkRequest("networkLink", { ...parseNetworkAddress(body.address), code: body.code }));
          }
          case "/api/network/unlink": {
            if (typeof body.id !== "string") return send(res, 400, { error: "Instance id is required." });
            return send(res, 200, await networkRequest("networkUnlink", { id: body.id }));
          }
          case "/api/network/verify": {
            if (typeof body.id !== "string") return send(res, 400, { error: "Instance id is required." });
            return send(res, 200, await networkRequest("networkVerify", { id: body.id }));
          }
          case "/api/network/firewall": {
            const status = await networkRequest("networkStatus", {});
            const cfg = status.config ?? loadConfig(opts.home, "other", opts.log).network;
            const plan = planFirewall(process.platform, status.port || cfg.port, cfg.discovery);
            if (body.apply === true) {
              if (body.confirm !== true) return send(res, 400, { error: "Explicit firewall confirmation required." });
              await applyWindowsFirewall(plan, true);
            }
            return send(res, 200, { plan, status: await detectFirewall(plan) });
          }
          default: return send(res, 404, { error: "not found" });
        }
      } catch (err) {
        return send(res, 409, { error: safeNetworkError(err) ?? "Network action failed. Check settings, broker availability, the address and code, or restart all local agent-bridge hosting sessions if the broker is older. A failed listener reload leaves saved settings for the next broker start." });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/usage") {
      const reports = await getUsage(url.searchParams.get("refresh") === "1");
      return send(res, 200, { at: usage?.at ?? Date.now(), reports });
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      const cfg = loadConfig(opts.home, "other", opts.log);
      const reports = await (opts.models ?? (() => Promise.all(CODING_AGENTS.map((agent) => readModels(agent, cfg, opts.home, opts.log, opts.home)))))();
      return send(res, 200, { reports });
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)\/(chat|subagents)(?:\/([^/]+))?$/.exec(url.pathname);
    if (req.method === "GET" && sessionMatch) {
      let name: string, child: string | undefined;
      try { name = decodeURIComponent(sessionMatch[1]!); child = sessionMatch[3] === undefined ? undefined : decodeURIComponent(sessionMatch[3]); }
      catch { return send(res, 404, { error: "no such local session" }); }
      if (name.includes("/") || name.includes("\\") || (child !== undefined && !TRANSCRIPT_ID.test(child)) || (sessionMatch[2] === "chat" && child !== undefined)) return send(res, 404, { error: "no such local session or subagent" });
      const { peers } = await brokerPeers(opts.pipe, token, opts.log);
      const peer = peers.find((p) => p.name === name && !p.name.includes("/"));
      if (!peer) return send(res, 404, { error: "no such local session" });
      if (!peer.sessionId) return send(res, 409, { error: "This session has no sessionId yet." });
      if (!TRANSCRIPT_ID.test(peer.sessionId) || !CODING_AGENTS.includes(peer.agent as typeof CODING_AGENTS[number])) return send(res, 404, { error: "no transcript for this session" });
      if (sessionMatch[2] === "subagents" && child === undefined) return send(res, 200, { subagents: listNativeSubagents(peer, opts.transcripts) });
      const from = url.searchParams.get("from") ?? "0";
      if (!validTranscriptCursor(from)) return send(res, 400, { error: "invalid transcript cursor" });
      const page = readTranscript(peer, from, child, opts.transcripts);
      return page ? send(res, 200, page) : send(res, 404, { error: "no transcript for this session or subagent" });
    }
    const runMatch = /^\/api\/runs\/([\w.-]+)$/.exec(url.pathname);
    if (req.method === "GET" && runMatch) {
      const file = join(opts.home, RUNS_DIR_NAME, `${runMatch[1]}.log`);
      if (!existsSync(file)) return send(res, 404, { error: "no such run" });
      const from = Math.max(0, Number(url.searchParams.get("from")) || 0);
      const buf = readFileSync(file);
      let end = Math.min(buf.length, from + MAX_LOG_CHUNK);
      // Never cut a UTF-8 character in half: step back over continuation bytes (10xxxxxx).
      while (end < buf.length && end > from && (buf[end]! & 0xc0) === 0x80) end--;
      return send(res, 200, { text: buf.subarray(from, end).toString("utf8"), next: end, size: buf.length });
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      // Also guards against cross-site form posts: they cannot set this header.
      if (req.headers["x-agent-bridge"] !== "1") return send(res, 403, { error: "missing header" });
      const body = await readJson(req);
      const to = String(body.to ?? "").trim();
      const text = String(body.body ?? "").trim();
      if (!to || !text) return send(res, 400, { error: "to and body are required" });
      const r = await (await getSender()).send({ to, body: text });
      return send(res, 200, { id: r.messages[0]?.id, deliveredTo: r.deliveredTo, queuedFor: r.queuedFor });
    }
    const jobCommand = req.method === "POST" && Object.hasOwn(JOB_COMMANDS, url.pathname) ? JOB_COMMANDS[url.pathname] : undefined;
    if (jobCommand) {
      if (req.headers["x-agent-bridge"] !== "1") return send(res, 403, { error: "missing header" });
      const body = await readJson(req);
      const run = typeof body.run === "string" ? body.run : "";
      const command = jobCommand(body);
      if (!RUN_NAME.test(`${run}.log`) || !command) return send(res, 400, { error: "a valid run and request are required" });
      const file = join(opts.home, RUNS_DIR_NAME, `${run}.log`);
      if (!existsSync(file)) return send(res, 404, { error: "no such run" });
      const meta = readMeta(join(opts.home, RUNS_DIR_NAME, `${run}.json`));
      if (!meta.by || !meta.job) return send(res, 409, { error: "This run has no owning session or job recorded." });
      try {
        const result = await controlDashboardJob(await getSender(), jobOwner(opts.home, meta.job, meta.by), meta.job, command);
        return send(res, result.isError ? 409 : 200, result);
      } catch (err) {
        if (err instanceof JobControlError) return send(res, err.reason === "offline" ? 409 : 504, { error: err.message });
        throw err;
      }
    }
    return send(res, 404, { error: "not found" });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      opts.log.warn("ui request failed", { err: (err as Error).message });
      if (!res.headersSent) send(res, 500, { error: String((err as Error).message) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, UI_HOST, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${UI_HOST}:${port}/?t=${secret}`,
    port,
    close: async () => {
      await (await sender?.catch(() => null))?.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
