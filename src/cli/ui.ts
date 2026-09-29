import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BridgeClient } from "../core/client.js";
import { APP_VERSION, PROTOCOL_VERSION } from "../core/constants.js";
import type { Logger } from "../core/logger.js";
import { BridgeNode } from "../core/node.js";
import { resolveDbPath } from "../core/paths.js";
import type { PeerInfo } from "../core/protocol.js";
import { RUNS_DIR_NAME } from "../core/runfeed.js";
import { loadOrCreateToken, tokensEqual } from "../core/token.js";
import { UI_PAGE } from "./ui-page.js";

/**
 * `agent-bridge ui`: a local dashboard for sessions, delegated runs and messages.
 * Bound to 127.0.0.1; every request needs a per-launch secret (given once in the URL, then a cookie).
 */
const UI_HOST = "127.0.0.1";
const COOKIE = "ab_ui";
const SECRET_BYTES = 24;
const MAX_RUNS = 40;
const MAX_MESSAGES = 200;
const MAX_LOG_CHUNK = 512 * 1024;
const MAX_POST_BYTES = 256 * 1024;
/** A run whose log has not been written for this long (heartbeats come every minute) was interrupted. */
const STALE_RUN_MS = 150_000;
const UI_PEER_NAME = "you";
const ALLOWED_HOSTS = new Set([UI_HOST, "localhost"]);
const RUN_NAME = /^[\w.-]+\.log$/;

export interface RunSummary {
  name: string;
  agent: string;
  header: string;
  startedAt: number;
  updatedAt: number;
  status: "running" | "done" | "failed" | "interrupted";
  last: string;
}

/** Parse the head and tail of a run log written by runfeed.ts. */
export function summarizeRun(file: string, text: string, mtimeMs: number, now: number): RunSummary {
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
  return {
    name: file.replace(/\.log$/, ""),
    agent: m?.[7] ?? "agent",
    header: (lines[0] ?? "").replace(/^\d\d:\d\d:\d\d /, ""),
    startedAt,
    updatedAt: mtimeMs,
    status,
    last,
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
    .map(({ f, st }) => summarizeRun(f, readFileSync(join(dir, f), "utf8"), st.mtimeMs, now));
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

/** Recent messages (one row per message, recipients joined), newest first. Read-only access. */
export function recentMessages(dbPath: string): MessageRow[] {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare(
      `SELECT id, from_name, from_agent, to_target, group_concat(recipient, ', ') AS recipients, body, created_at, hop, reply_to
       FROM messages GROUP BY id ORDER BY created_at DESC LIMIT ?`,
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

export interface UiOptions {
  home: string;
  /** Per-launch secret; generated when omitted. */
  secret?: string;
  pipe: string;
  port: number;
  log: Logger;
}

export async function startUi(opts: UiOptions): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const secret = opts.secret ?? randomBytes(SECRET_BYTES).toString("hex");
  const token = loadOrCreateToken(opts.home);
  const dbPath = resolveDbPath(opts.home);
  let sender: BridgeNode | null = null;

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
    if (req.method === "GET" && url.pathname === "/api/state") {
      const { brokerPid, peers } = await brokerPeers(opts.pipe, token, opts.log);
      return send(res, 200, {
        version: APP_VERSION,
        brokerPid,
        peers,
        runs: listRuns(opts.home),
        messages: recentMessages(dbPath),
      });
    }
    const runMatch = /^\/api\/runs\/([\w.-]+)$/.exec(url.pathname);
    if (req.method === "GET" && runMatch) {
      const file = join(opts.home, RUNS_DIR_NAME, `${runMatch[1]}.log`);
      if (!existsSync(file)) return send(res, 404, { error: "no such run" });
      const from = Math.max(0, Number(url.searchParams.get("from")) || 0);
      const buf = readFileSync(file);
      const end = Math.min(buf.length, from + MAX_LOG_CHUNK);
      return send(res, 200, { text: buf.subarray(from, end).toString("utf8"), next: end, size: buf.length });
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      // Also guards against cross-site form posts: they cannot set this header.
      if (req.headers["x-agent-bridge"] !== "1") return send(res, 403, { error: "missing header" });
      const body = await readJson(req);
      const to = String(body.to ?? "").trim();
      const text = String(body.body ?? "").trim();
      if (!to || !text) return send(res, 400, { error: "to and body are required" });
      if (!sender) {
        sender = new BridgeNode({ pipePath: opts.pipe, token, dbPath, agent: "other", name: UI_PEER_NAME, cwd: opts.home, autoWake: false, log: opts.log });
        await sender.start();
      }
      const r = await sender.send({ to, body: text });
      return send(res, 200, { id: r.messages[0]?.id, deliveredTo: r.deliveredTo, queuedFor: r.queuedFor });
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
      await sender?.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
