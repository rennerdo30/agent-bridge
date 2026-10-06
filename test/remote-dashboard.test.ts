import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUi, classifyPeers } from "../src/cli/ui.js";
import { readDashboard } from "../src/core/dashboard-read.js";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeClient } from "../src/core/client.js";
import { JOBS_FILE, PROTOCOL_VERSION } from "../src/core/constants.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { NetworkService } from "../src/network/link.js";
import { RemoteDashboard } from "../src/network/remote-dashboard.js";
import { DASHBOARD_CAPABILITY, DASHBOARD_FRAME, DASHBOARD_RATE_LIMIT, DASHBOARD_TIMEOUT_MS, dashboardRequestSchema } from "../src/network/dashboard-protocol.js";
import { CODEX_SESSION, CODEX_CHILD, installTranscriptFixtures } from "./transcript-fixtures.js";

let root: string, aHome: string, bHome: string;
let cleanup: (() => Promise<unknown> | void)[];
const cfg = (name: string) => ({ ...DEFAULT_NETWORK_CONFIG, enabled: true, name, bind: "127.0.0.1", port: 0, discovery: false });
const peer = (name = "session"): PeerInfo => ({ id: name, name, agent: "codex", cwd: "/project/example", pid: process.pid, agentPid: null, sessionId: CODEX_SESSION, startedAt: 1, autoWake: false });
const RUN = "2026-10-06-09-00-00-codex-abcd";
const JOB = "codex-job-abcd";
beforeEach(() => {
  // Short native temp paths: macOS sockets cap paths at 104 bytes; Windows may use aliases.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "abd-")));
  aHome = join(root, "a"); bHome = join(root, "b");
  mkdirSync(aHome); mkdirSync(bHome); cleanup = [];
});
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  vi.useRealTimers(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
function seed() {
  const fixtures = installTranscriptFixtures(bHome);
  mkdirSync(join(bHome, "runs"));
  writeFileSync(join(bHome, "runs", `${RUN}.log`), "09:00:00 codex\n09:00:01 finished after 1s · done\n");
  writeFileSync(join(bHome, "runs", `${RUN}.json`), JSON.stringify({ by: "session", job: JOB, session: CODEX_SESSION, workdir: "/project/example" }));
  writeFileSync(join(bHome, JOBS_FILE), JSON.stringify({ jobs: [{ id: "abcd", name: JOB, owner: "session", agent: "codex", status: "done", startedAt: 1, sessionId: CODEX_SESSION, rootName: "session", rootSession: CODEX_SESSION, args: { model: "sample" } }] }));
  return fixtures;
}
async function links(mode: "current" | "legacy" | "silent" = "current") {
  const fixtures = seed();
  const peers = [peer(), { ...peer(JOB), id: "job:abcd", jobAgent: "codex" as const, jobParent: "session", rootName: "session", rootSession: CODEX_SESSION, parentJob: "codex-job-parent", subagent: true, title: "Nested worker" }];
  const a = new NetworkService(aHome, cfg("alpha"), { peers: () => [], receive: () => ({ delivered: true }) }, nullLogger);
  const b = new NetworkService(bHome, cfg("beta"), { peers: () => peers, receive: () => ({ delivered: true }) }, nullLogger);
  const context = { home: bHome, log: nullLogger, peers: () => peers, transcripts: fixtures.paths };
  const remote = new RemoteDashboard(a, { home: aHome, log: nullLogger, peers: () => [] });
  if (mode === "current") { const service = new RemoteDashboard(b, context); cleanup.push(() => service.close()); }
  if (mode === "silent") b.registerExtension(DASHBOARD_FRAME, DASHBOARD_CAPABILITY, () => {});
  cleanup.push(() => remote.close(), () => a.close(), () => b.close());
  await a.start(); await b.start(); await a.link(b.keys.invite(), "127.0.0.1", b.port);
  return { a, b, remote, context };
}

describe("paired dashboard read protocol", () => {
  it("serves identical local run, log, transcript, native child and outcome shapes", async () => {
    const { remote, context } = await links();
    for (const path of ["/api/state", "/api/runs", `/api/runs/${RUN}`, `/api/runs/${RUN}/chat`, "/api/sessions/session/chat", "/api/sessions/session/subagents", `/api/sessions/session/subagents/${CODEX_CHILD}`, `/api/jobs/${JOB}/subagents`, `/api/jobs/${JOB}/subagents/${CODEX_CHILD}`, "/api/job-outcomes"]) {
      const local = await readDashboard(context, { path });
      const result = await remote.request("beta", { path });
      expect(result.status, path).toBe(200);
      const normalize = (value: unknown) => JSON.parse(JSON.stringify(value), (key, field) => key === "checkedAt" ? 0 : field);
      expect(normalize(result), path).toEqual(normalize(local));
    }
    const page: any = (await remote.request("beta", { path: "/api/sessions/session/chat" })).body;
    expect((await remote.request("beta", { path: "/api/sessions/session/chat", query: { from: page.next } })).body).toMatchObject({ items: [] });
    expect((await remote.request("beta", { path: `/api/sessions/session/subagents/${CODEX_SESSION}` })).status).toBe(404);
  });
  it("paginates, bounds UTF-8 log reads and rejects invalid cursors and paths", async () => {
    const { remote } = await links();
    writeFileSync(join(bHome, "runs", "2026-10-07-09-00-00-codex-efgh.log"), "newer\n");
    const first: any = (await remote.request("beta", { path: "/api/runs", query: { limit: "1" } })).body;
    expect(first.runs).toHaveLength(1); expect(first.next).toBeTypeOf("string");
    const second: any = (await remote.request("beta", { path: "/api/runs", query: { limit: "1", before: first.next } })).body;
    expect(second.runs[0].name).toBe(RUN);
    for (const query of [{ limit: "501" }, { before: "../../secret" }]) expect((await remote.request("beta", { path: "/api/runs", query })).status).toBe(400);
    for (const path of ["/api/storage", "/api/send", "/api/runs/../secret", "/api/sessions/alpha%2Fsession/chat"]) expect(dashboardRequestSchema.safeParse({ path }).success).toBe(false);
    expect((await remote.request("beta", { path: `/api/runs/${RUN}`, query: { from: "-1" } })).status).toBe(400);
    const outcomes: any = (await remote.request("beta", { path: "/api/job-outcomes", query: { limit: "1" } })).body;
    expect(Object.keys(outcomes.jobs).length + Object.keys(outcomes.runs).length).toBe(1);
    expect(outcomes.next).toBeTypeOf("string");
    const more: any = (await remote.request("beta", { path: "/api/job-outcomes", query: { limit: "1", before: outcomes.next } })).body;
    expect(Object.keys(more.jobs).length + Object.keys(more.runs).length).toBe(1);
    const bytes = Buffer.from("\u754c".repeat(100_000)); writeFileSync(join(bHome, "runs", `${RUN}.log`), bytes);
    const chunk: any = (await remote.request("beta", { path: `/api/runs/${RUN}` })).body;
    expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(128 * 1024);
    expect(chunk.text).not.toContain("\ufffd"); expect(chunk.size).toBe(bytes.length);
    const next: any = (await remote.request("beta", { path: `/api/runs/${RUN}`, query: { from: String(chunk.next) } })).body;
    expect(next.text).not.toContain("\ufffd");
  });
  it("returns update-needed for an older peer and offline after disconnect", async () => {
    const { a, b, remote } = await links("legacy");
    expect(await remote.request("beta", { path: "/api/runs" })).toMatchObject({ status: 409, body: { code: "remote_update_needed" } });
    a.unlink(b.keys.identity.id);
    expect(await remote.request("beta", { path: "/api/runs" })).toMatchObject({ status: 503, body: { code: "remote_offline" } });
  });
  it("times out silent peers", async () => {
    const { remote } = await links("silent");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = remote.request("beta", { path: "/api/runs" });
    await vi.advanceTimersByTimeAsync(DASHBOARD_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ status: 504, body: { code: "remote_timeout" } });
  });
  it("rate limits requests per authenticated pair", async () => {
    const { remote } = await links();
    for (let i = 0; i < DASHBOARD_RATE_LIMIT; i++) expect((await remote.request("beta", { path: "/api/runs" })).status).toBe(200);
    expect(await remote.request("beta", { path: "/api/runs" })).toMatchObject({ status: 429, body: { code: "remote_rate_limited" } });
  });
  it("retains advertisements and prefixes runner parent and root identities", async () => {
    const { a, b } = await links();
    const runner = classifyPeers(a.peers(), [], aHome).find((p) => p.jobAgent);
    expect(runner).toMatchObject({ name: `beta/${JOB}`, host: "beta", jobAgent: "codex", subagent: true, parent: "beta/codex-job-parent", rootName: "beta/session", rootSession: `${b.keys.identity.id}/${CODEX_SESSION}`, title: "Nested worker" });
    expect(classifyPeers([{ ...peer(JOB), jobAgent: "codex", jobParent: "session" }], [], aHome)[0]).toMatchObject({ subagent: true, parent: "session" });
  });
});

async function node(home: string, name: string, runner = false) {
  const bridge = new BridgeNode({ pipePath: resolvePipePath(home, {}), token: loadOrCreateToken(home), dbPath: resolveDbPath(home), agent: runner ? "other" : "codex", name, cwd: "/project/example", autoWake: false, log: nullLogger,
    ...(runner ? { jobAgent: "codex", jobOwner: CODEX_SESSION, jobParent: "session", rootName: "session", rootSession: CODEX_SESSION, jobTitle: "Worker" } : {}),
    network: { home, config: cfg(home === aHome ? "alpha" : "beta") } });
  await bridge.start(); cleanup.push(() => bridge.stop()); await bridge.setSessionId(CODEX_SESSION); return bridge;
}
async function admin(home: string) {
  const client = await BridgeClient.connect(resolvePipePath(home, {}), nullLogger);
  cleanup.push(() => client.close()); await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) }); return client;
}
describe("paired dashboard HTTP", () => {
  it("keeps token auth, accepts encoded host/name and marks runs, jobs and children with host", async () => {
    const fixture = seed(); vi.stubEnv("CODEX_HOME", fixture.paths.codex);
    await node(aHome, "local"); await node(bHome, "session"); await node(bHome, JOB, true);
    const a = await admin(aHome), b = await admin(bHome);
    const status = await b.request("networkStatus", {});
    const invitation = await b.request("networkPair", {});
    await a.request("networkLink", { code: invitation.code, host: "127.0.0.1", port: status.port! });
    const ui = await startUi({ home: aHome, pipe: resolvePipePath(aHome, {}), port: 0, log: nullLogger }); cleanup.push(() => ui.close());
    const base = ui.url.replace(/\/\?t=.*$/, "");
    const cookie = String((await fetch(ui.url, { redirect: "manual" })).headers.get("set-cookie")).split(";")[0]!;
    const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie } });
    const route = "/api/sessions/beta%2Fsession";
    expect((await fetch(`${base}${route}/chat`)).status).toBe(403);
    for (const path of [`${route}/chat`, `${route}/subagents`, `${route}/subagents/${CODEX_CHILD}`, `/api/runs/beta%2F${RUN}/chat`, `/api/runs/beta%2F${JOB}/chat`, `/api/runs/beta%2F${RUN}`, `/api/jobs/beta%2F${JOB}/subagents`, `/api/jobs/beta%2F${JOB}/subagents/${CODEX_CHILD}`, "/api/runs?host=beta", "/api/job-outcomes?host=beta"]) {
      const response = await get(path); expect(response.status, path).toBe(200);
      const body: any = await response.json(); expect(body.host).toBe("beta");
      for (const row of body.items ?? body.subagents ?? []) expect(row.host).toBe("beta");
    }
    const state: any = await (await get("/api/state")).json();
    expect(state.runs).toMatchObject([{ name: `beta/${RUN}`, by: "beta/session", job: `beta/${JOB}`, host: "beta" }]);
    expect(state.jobs[`beta/${JOB}`]).toMatchObject({ next: { model: "sample" }, host: "beta" });
    expect(state.peers.find((p: any) => p.name === `beta/${JOB}`)).toMatchObject({ jobAgent: "codex", subagent: true, parent: "beta/session", rootName: "beta/session" });
    expect((await fetch(`${base}${route}/chat`, { method: "POST", headers: { cookie } })).status).toBe(404);
    expect((await get(`${route}/chat?path=/etc/passwd`)).status).toBe(400);
    expect(readFileSync(join(bHome, JOBS_FILE), "utf8")).toContain('"owner":"session"');
    await a.request("networkUnlink", { id: status.identity!.id });
    expect(await (await get(`${route}/chat`)).json()).toMatchObject({ code: "remote_offline" });
  });
});
