import { handoffSchema } from "../core/job-handoff.js";
import { DatabaseSync } from "node:sqlite";
import { conversationPageSchema, readConversation } from "../core/conversations.js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { BridgeClient } from "../core/client.js";
import { DEFAULT_CODEX_SUBAGENTS, MAX_CODEX_SUBAGENTS, APP_VERSION, MAX_BODY_CHARS, PROTOCOL_VERSION } from "../core/constants.js";
import type { Logger } from "../core/logger.js";
import { BridgeNode } from "../core/node.js";
import { resolveDbPath } from "../core/paths.js";
import { BridgeError, CODING_AGENTS, type PeerInfo } from "../core/protocol.js";
import { readModels, type ModelReport } from "../core/models.js";
import { RUNS_DIR_NAME } from "../core/runfeed.js";
import { loadOrCreateToken, tokensEqual } from "../core/token.js";
import { loadConfig, saveConfigValue } from "../core/config.js";
import { readUsage, type UsageReport } from "../core/usage.js";
import { controlDashboardJob, JobControlError, type DashboardJobCommand } from "../core/job-control.js";
import { UI_PAGE } from "./ui-page.js";
import { networkConfigSchema } from "../network/config.js";
import { planFirewall, detectFirewall, applyWindowsFirewall } from "../network/firewall.js";
import { networkProfileStatus } from "../network/profiles.js";
import { parseNetworkAddress } from "../network/address.js";
import type { Op, RequestMap } from "../core/protocol.js";
import { isRecord } from "../core/json-store.js";
import { doctor } from "../core/doctor.js";
import { MAX_HISTORY_LIMIT, searchMessages } from "../core/message-history.js";
import { DEFAULT_RUN_PAGE_SIZE, pageRuns } from "../core/run-history.js";
import { type TranscriptPaths } from "../core/transcripts/index.js";
import { HISTORY_MAX_QUERY_CHARS, historySearchSchema, readHistory, readHistorySource } from "../core/history.js";
import { answerHistory, type HistoryAnswerDependencies } from "../core/history-answer.js";
import { readDecisions, decisionScopeSchema, MAX_DECISION_TEXT_CHARS, MAX_DECISION_TOPIC_CHARS, type DecisionsArgs } from "../core/decisions.js";
import { answerPendingApproval, listPendingApprovals, MAX_APPROVAL_REASON_CHARS } from "../core/relay.js";
import { classifyPeers, listRuns, readStoredJobs, readDashboard, readMeta } from "../core/dashboard-read.js";
export { classifyPeers, listRuns, readStoredJobs, summarizeRun, finishedRunOutcomes } from "../core/dashboard-read.js";
export type { RunSummary, DashboardPeer, StoredJobView } from "../core/dashboard-read.js";
import { dashboardError } from "../network/remote-dashboard.js";
import { markRemoteDashboard } from "../network/dashboard-projection.js";
import { dashboardRequestSchema, isDashboardReadPath, DASHBOARD_TIMEOUT_MS, type DashboardReadRequest, type DashboardReadResult } from "../network/dashboard-protocol.js";

/**
 * `agent-bridge ui`: a local dashboard for sessions, delegated runs and messages.
 * Bound to 127.0.0.1; every request needs a per-launch secret (given once in the URL, then a cookie).
 */
const UI_HOST = "127.0.0.1";
const COOKIE = "ab_ui";
const SECRET_BYTES = 24;
const MAX_MESSAGES = 200;
const MAX_POST_BYTES = 256 * 1024;
const UI_PEER_NAME = "you";
const ALLOWED_HOSTS = new Set([UI_HOST, "localhost"]);
const RUN_NAME = /^[\w.-]+\.log$/;

/** A server may have adopted a job from an earlier stand-in name since its log was written. */
function jobOwner(home: string, job: string, original: string): string {
  return readStoredJobs(home).get(job)?.owner ?? original;
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
  return searchMessages(dbPath, { limit: MAX_MESSAGES });
}

async function brokerPeers(pipe: string, token: string, log: Logger): Promise<{ brokerPid: number | null; peers: PeerInfo[] }> {
  let client: BridgeClient | null = null;
  try {
    client = await BridgeClient.connect(pipe, log);
    const { brokerPid } = await client.request("auth", { protocol: PROTOCOL_VERSION, token });
    return { brokerPid, peers: await client.request("dashboardPeers", {}).catch(() => client!.request("peers", {})) };
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
  historyAnswer?: HistoryAnswerDependencies;
}

/** The paired PCs' runs in /api/state are re-fetched in the background at most this often. */
const REMOTE_STATE_REFRESH_MS = 5_000;
/** The very first /api/state waits this long for the paired PCs before answering without them. */
const REMOTE_STATE_FIRST_WAIT_MS = 1_500;
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
    readUsage("antigravity", cfg.antigravityBin, home, log, cfg.antigravityModel),
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
      return await client.request(op, args, op === "dashboardRead" ? DASHBOARD_TIMEOUT_MS + 2_000 : undefined);
    } finally { client.close(); }
  };

  const remoteRead = async (host: string, request: DashboardReadRequest): Promise<DashboardReadResult> => {
    try {
      const paired = (await networkRequest("networkStatus", {})).paired.find((p) => p.name === host || p.id === host);
      if (!paired) return dashboardError("remote_offline", "No such paired PC.", 404);
      const result = await networkRequest("dashboardRead", { host: paired.id, request });
      return { ...result, body: markRemoteDashboard(result.body, host) };
    } catch (error) {
      if (error instanceof BridgeError && error.code === "bad_request") return dashboardError("remote_update_needed", "Restart local hosting sessions to load dashboard-read-v1.", 409);
      return dashboardError("remote_offline", "The paired broker is unavailable.");
    }
  };
  const pairedReads = async (path: string): Promise<Record<string, DashboardReadResult>> => {
    let hosts: string[] = [];
    try { hosts = (await networkRequest("networkStatus", {})).paired.map((p) => p.name); } catch { return {}; }
    return Object.fromEntries(await Promise.all(hosts.map(async (host) => [host, await remoteRead(host, { path })])));
  };

  /**
   * The paired PCs' state is fetched in the background and the last answer is served at once, so a slow or
   * distant PC never holds up the page's frequent /api/state polls. The first poll waits a short moment for it.
   */
  let remoteState: { at: number; value: Record<string, DashboardReadResult> } | null = null;
  let remoteStateLoad: Promise<Record<string, DashboardReadResult>> | null = null;
  const remoteStateNow = async (): Promise<Record<string, DashboardReadResult>> => {
    if (!remoteStateLoad && (!remoteState || Date.now() - remoteState.at > REMOTE_STATE_REFRESH_MS)) {
      remoteStateLoad = pairedReads("/api/state")
        .then((value) => { remoteState = { at: Date.now(), value }; return value; })
        .finally(() => { remoteStateLoad = null; });
    }
    if (remoteState) return remoteState.value;
    const waited = await Promise.race([remoteStateLoad!, new Promise<null>((resolve) => setTimeout(() => resolve(null), REMOTE_STATE_FIRST_WAIT_MS))]);
    return waited ?? {};
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
    const nativeDefaults = () => ({ codexSubagents: loadConfig(opts.home, "other", opts.log).codexSubagents, defaultCodexSubagents: DEFAULT_CODEX_SUBAGENTS, maxCodexSubagents: MAX_CODEX_SUBAGENTS });
    if (req.method === "GET" && url.pathname === "/api/config/codex-subagents") return send(res, 200, nativeDefaults());
    if (req.method === "POST" && url.pathname === "/api/config/codex-subagents") {
      if (req.headers["x-agent-bridge"] !== "1") return send(res, 403, { error: "missing header" });
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: "Expected a JSON object." }); }
      if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.codexSubagents !== "number" || !Number.isInteger(body.codexSubagents) || body.codexSubagents < 0 || body.codexSubagents > MAX_CODEX_SUBAGENTS) return send(res, 400, { error: `codexSubagents must be an integer from 0 to ${MAX_CODEX_SUBAGENTS}` });
      saveConfigValue(opts.home, "codexSubagents", body.codexSubagents);
      return send(res, 200, nativeDefaults());
    }
    if (req.method === "GET" && url.pathname === "/api/storage") return send(res, 200, doctor(opts.home));
    if (req.method === "GET" && url.pathname === "/api/archive/messages") {
      const limit = url.searchParams.get("limit");
      const before = url.searchParams.get("before");
      if (limit !== null && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_HISTORY_LIMIT) || before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))) return send(res, 400, { error: "invalid limit or before" });
      return send(res, 200, { messages: searchMessages(dbPath, { query: url.searchParams.get("query") ?? "", limit: limit === null ? undefined : Number(limit), before: before === null ? undefined : Number(before) }) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/conversations/")) {
      let id: string; try { id=decodeURIComponent(url.pathname.slice("/api/conversations/".length)); } catch { return send(res,400,{error:"Invalid conversation id."}); }
      const args=conversationPageSchema.safeParse({id,...(url.searchParams.has("after") ? {after:Number(url.searchParams.get("after"))} : {}),...(url.searchParams.has("limit") ? {limit:Number(url.searchParams.get("limit"))} : {})});
      if (!args.success) return send(res,400,{error:"Invalid conversation page."});
      const db=new DatabaseSync(dbPath,{readOnly:true,timeout:100});
      try { const page=readConversation(db,args.data); return send(res,page.conversation ? 200 : 404,page); } finally { db.close(); }
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/history/")) {
      let id: string;
      try { id = decodeURIComponent(url.pathname.slice("/api/history/".length)); }
      catch { return send(res, 400, { error: "Invalid history source id." }); }
      if (!id || id.length > HISTORY_MAX_QUERY_CHARS) return send(res, 400, { error: "Invalid history source id." });
      const source = readHistorySource(dbPath, id);
      return source ? send(res, 200, source) : send(res, 404, { error: "No such indexed history source." });
    }
    if (req.method === "GET" && url.pathname === "/api/search") {
      const allowed = new Set(["q", "project", "session", "job", "agent", "kind", "since", "until", "limit", "answer"]);
      if ([...url.searchParams.keys()].some((key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) return send(res, 400, { error: "Unknown or duplicate search parameter." });
      const filters = Object.fromEntries(["project", "session", "job", "agent", "kind", "since", "until"].flatMap((key) => {
        const value = url.searchParams.get(key);
        return value === null ? [] : [[key, (key === "since" || key === "until") && /^\d+$/.test(value) ? Number(value) : value]];
      }));
      const args = historySearchSchema.safeParse({ query: url.searchParams.get("q"), filters, ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}) });
      const answer = url.searchParams.get("answer");
      if (!args.success || (answer !== null && !["true", "false"].includes(answer))) return send(res, 400, { error: "Invalid history query, filters, limit or answer flag." });
      const result = readHistory(dbPath, args.data);
      return send(res, 200, answer === "true" ? { ...result, answer: await answerHistory(args.data.query, result, loadConfig(opts.home, "other", opts.log), opts.home, opts.log, opts.historyAnswer) } : result);
    }
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
    if (req.method === "GET" && url.pathname === "/api/approvals") return send(res, 200, { approvals: listPendingApprovals(opts.home) });
    const approvalMatch = /^\/api\/approvals\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === "POST" && approvalMatch) {
      if (req.headers["x-agent-bridge"] !== "1") return send(res, 403, { error: "missing header" });
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: "Expected a JSON object." }); }
      if (!body || Array.isArray(body) || (body.decision !== "allow" && body.decision !== "deny") || (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > MAX_APPROVAL_REASON_CHARS))) return send(res, 400, { error: "A decision of allow or deny and an optional reason are required." });
      const outcome = await answerPendingApproval(opts.home, approvalMatch[1]!, { decision: body.decision, ...(typeof body.reason === "string" ? { reason: body.reason } : {}) });
      if (outcome === "expired") return send(res, 409, { outcome, error: "This approval was already answered, expired or cancelled." });
      if (outcome === "unavailable") return send(res, 504, { outcome, error: "The approval's owning process is unavailable. Refresh before answering again." });
      return send(res, 200, { outcome, id: approvalMatch[1], answeredBy: "dashboard", decision: body.decision });
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const { brokerPid, peers } = await brokerPeers(opts.pipe, token, opts.log);
      const runs = listRuns(opts.home);
      const page = pageRuns(runs, null, DEFAULT_RUN_PAGE_SIZE);
      const remote = await remoteStateNow();
      const remoteStates = Object.values(remote).filter((r) => r.status === 200).map((r) => r.body as { runs: unknown[]; jobs: Record<string, unknown> });
      const remoteErrors = Object.fromEntries(Object.entries(remote).filter(([, r]) => r.status !== 200).map(([host, r]) => [host, r.body]));
      return send(res, 200, {
        version: APP_VERSION,
        brokerPid,
        peers: classifyPeers(peers, runs, opts.home),
        runs: [...page.runs, ...remoteStates.flatMap((r) => r.runs)],
        runsNext: page.next,
        runsTotal: page.total,
        remoteRuns: Object.fromEntries(Object.entries(remote).filter(([, r]) => r.status === 200).map(([host, r]) => [host, r.body])),
        remoteErrors,
        messages: recentMessages(dbPath),
        // Saved next-turn settings per job (message_subagent or the dashboard may have changed them).
        jobs: { ...Object.fromEntries([...readStoredJobs(opts.home)].map(([name, j]) => [name, { next: j.next, ...(j.remote ? { remote: j.remote } : {}) }])), ...Object.assign({}, ...remoteStates.map((r) => r.jobs)) },
      });
    }
    if (req.method === "GET" && url.pathname === "/api/network") {
      const status = await networkRequest("networkStatus", {});
      const config = status.config ?? loadConfig(opts.home, "other", opts.log).network;
      return send(res, 200, { ...status, config, addresses: lanAddresses(), ...await networkProfileStatus() });
    }
    if (req.method === "GET" && url.pathname === "/api/transfers") {
      try { return send(res, 200, await networkRequest("transfers", {})); }
      catch (error) { return send(res, 503, { error: (error as Error).message }); }
    }
    const transferCancel = /^\/api\/transfers\/([^/]+)\/cancel$/.exec(url.pathname);
    if (req.method === "POST" && transferCancel) {
      if (req.headers["x-agent-bridge"] !== "1") return send(res, 403, { error: "missing header" });
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(transferCancel[1]!)) return send(res, 400, { error: "Invalid transfer id." });
      try { return send(res, 200, await networkRequest("cancelTransfer", { id: transferCancel[1]! })); }
      catch (error) { return send(res, (error as Error).message === "unknown transfer" ? 404 : 503, { error: (error as Error).message }); }
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
    // Decode the route identity once: the page sends Host/name as one encoded segment.
    const remoteRoute = /^\/api\/(runs|sessions|jobs)\/(.+?)(\/chat|\/subagents(?:\/[^/]+)?)?$/.exec(url.pathname);
    if (req.method === "GET" && remoteRoute) {
      let identity: string;
      try { identity = decodeURIComponent(remoteRoute[2]!); } catch { return send(res, 400, { error: "invalid dashboard identity" }); }
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/([\w.-]{1,256})$/.exec(identity);
      const address = match ? { instance: match[1]!, target: match[2]! } : null;
      if (address) {
        const path = `/api/${remoteRoute[1]}/${encodeURIComponent(address.target)}${remoteRoute[3] ?? ""}`;
        const parsed = dashboardRequestSchema.safeParse({ path, query: Object.fromEntries(url.searchParams) });
        if (!parsed.success) return send(res, 400, { error: "invalid dashboard read request" });
        const result = await remoteRead(address.instance, parsed.data);
        return send(res, result.status, result.body);
      }
    }
    if (req.method === "GET" && (url.pathname === "/api/runs" || url.pathname === "/api/job-outcomes") && url.searchParams.has("host")) {
      const host = url.searchParams.get("host")!;
      const query = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "host"));
      const parsed = dashboardRequestSchema.safeParse({ path: url.pathname, query });
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(host) || !parsed.success) return send(res, 400, { error: "invalid remote dashboard request" });
      const result = await remoteRead(host, parsed.data);
      return send(res, result.status, result.body);
    }
    if (req.method === "GET" && isDashboardReadPath(url.pathname)) {
      const read = dashboardRequestSchema.safeParse({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
      if (!read.success) return send(res, 400, { error: "invalid dashboard read request" });
      const result = await readDashboard({ home: opts.home, log: opts.log, transcripts: opts.transcripts, peers: async () => (await brokerPeers(opts.pipe, token, opts.log)).peers }, read.data);
      return send(res, result.status, result.body);
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
    if (req.method === "POST" && url.pathname === "/api/subagents/handoff") {
      if (req.headers["x-agent-bridge"] !== "1") return send(res, 403, { error: "missing header" });
      const body = await readJson(req);
      const parsed = handoffSchema.safeParse({ to: body.to, jobs: body.jobs, note: body.note });
      if (!parsed.success || typeof body.from !== "string" || body.from.includes("/")) return send(res, 400, { error: "An exact local source and valid handoff arguments are required." });
      try {
        const result = await controlDashboardJob(await getSender(), body.from, "", { type: "handoff", ...parsed.data });
        return send(res, result.isError ? 409 : 200, result);
      } catch (err) {
        if (err instanceof JobControlError) return send(res, err.reason === "offline" ? 409 : 504, { error: err.message });
        throw err;
      }
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
