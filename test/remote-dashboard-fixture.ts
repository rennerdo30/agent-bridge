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
import { until } from "./helpers.js";
import { NetworkService } from "../src/network/link.js";
import { RemoteDashboard } from "../src/network/remote-dashboard.js";
import { DASHBOARD_CAPABILITY, DASHBOARD_FRAME, DASHBOARD_RATE_LIMIT, DASHBOARD_TIMEOUT_MS, dashboardRequestSchema } from "../src/network/dashboard-protocol.js";
import { CODEX_SESSION, CODEX_CHILD, installTranscriptFixtures } from "./transcript-fixtures.js";

export let root: string, aHome: string, bHome: string;
export let cleanup: (() => Promise<unknown> | void)[];
export const cfg = (name: string) => ({ ...DEFAULT_NETWORK_CONFIG, enabled: true, name, bind: "127.0.0.1", port: 0, discovery: false });
export const peer = (name = "session"): PeerInfo => ({ id: name, name, agent: "codex", cwd: "/project/example", pid: process.pid, agentPid: null, sessionId: CODEX_SESSION, startedAt: 1, autoWake: false });
export const RUN = "2026-10-06-09-00-00-codex-abcd";
export const JOB = "codex-job-abcd";
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
export function seed() {
  const fixtures = installTranscriptFixtures(bHome);
  mkdirSync(join(bHome, "runs"));
  writeFileSync(join(bHome, "runs", `${RUN}.log`), "09:00:00 codex\n09:00:01 finished after 1s · done\n");
  writeFileSync(join(bHome, "runs", `${RUN}.json`), JSON.stringify({ by: "session", job: JOB, session: CODEX_SESSION, workdir: "/project/example" }));
  writeFileSync(join(bHome, JOBS_FILE), JSON.stringify({ jobs: [{ id: "abcd", name: JOB, owner: "session", agent: "codex", status: "done", startedAt: 1, sessionId: CODEX_SESSION, rootName: "session", rootSession: CODEX_SESSION, args: { model: "sample" } }] }));
  return fixtures;
}
export async function links(mode: "current" | "legacy" | "silent" = "current") {
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

export async function node(home: string, name: string, runner = false, config = cfg(home === aHome ? "alpha" : "beta"), identify = true) {
  const bridge = new BridgeNode({ pipePath: resolvePipePath(home, {}), token: loadOrCreateToken(home), dbPath: resolveDbPath(home), agent: runner ? "other" : "codex", name, cwd: "/project/example", autoWake: false, log: nullLogger,
    ...(runner ? { jobAgent: "codex", jobOwner: CODEX_SESSION, jobParent: "session", rootName: "session", rootSession: CODEX_SESSION, jobTitle: "Worker" } : {}),
    network: { home, config } });
  await bridge.start(); cleanup.push(() => bridge.stop()); if (identify) await bridge.setSessionId(CODEX_SESSION); return bridge;
}
export async function admin(home: string) {
  const client = await BridgeClient.connect(resolvePipePath(home, {}), nullLogger);
  cleanup.push(() => client.close()); await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) }); return client;
}
