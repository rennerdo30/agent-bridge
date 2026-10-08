import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as delegate from "../src/core/delegate.js";
import * as identity from "../src/core/process-identity.js";
import * as json from "../src/core/json-store.js";
import * as runfeed from "../src/core/runfeed.js";
import { nullLogger } from "../src/core/logger.js";
import { RemoteJobs, type RemoteJobSnapshot } from "../src/network/remote-jobs.js";
import type { RunFeed } from "../src/core/runfeed.js";
import { until } from "./helpers.js";

let home: string, remote: RemoteJobs, sends: ReturnType<typeof vi.fn>;
let snapshot: RemoteJobSnapshot;
const peer = { id: "sender-id", name: "sender" };
const spawn = { op: "spawn", job: "12345678", target: "codex", args: { prompt: "complete first prompt\nsecond context line", title: "Original", cwd: "synthetic-remote-folder", model: "original-model", effort: "high", access: "read" } } as const;
const stateRequest = { op: "state", job: spawn.job } as const;
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const feed = (): RunFeed => ({ logPath: "synthetic-owned-feed", meta: vi.fn(), report: vi.fn(), end: vi.fn() });
beforeEach(() => {
  const root = join(process.cwd(), ".agent-bridge-test"); mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "remote-mirror-ready-"));
  vi.spyOn(delegate, "bundledCli").mockReturnValue(null);
  snapshot = { state: { pid: 123, peer: "codex-job-12345678", status: "running", updatedAt: Date.now(), sessionId: "original-session", workdir: "remote-workdir", model: "current-model" }, alive: true, approvals: [] };
  sends = vi.fn(async (_host, _type, frame) => {
    await (remote as any).receive({ kind: "response", rid: frame.rid, value: snapshot }, { id: "paired-id", name: "paired" });
  });
  remote = new RemoteJobs({ registerExtension() {}, peerSupports: () => true, sendExtension: sends } as any, home, nullLogger, async () => {});
});
afterEach(() => { remote.close(); vi.useRealTimers(); vi.restoreAllMocks(); }); // Retain every isolated fixture.

it("returns the authoritative remote snapshot while cold mirror metadata waits, then retains full context", async () => {
  let ready!: () => void;
  vi.spyOn(identity, "readProcessIdentities").mockImplementation(() => new Promise(resolve => { ready = () => resolve(new Map()); }));
  // A published foreign reader forces the real asynchronous discovery path.
  mkdirSync(join(home, "storage-capabilities"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(home, "storage-capabilities", "2147483000.json"), JSON.stringify({ schemaVersion: 1, pid: 2147483000, json: 4, sqlite: 8, version: "0.29.17", processIdentity: "synthetic" }));
  const result = await remote.request("paired", peer, spawn);
  expect(result).toEqual(snapshot); expect(ready).toBeTypeOf("function");
  expect(existsSync(join(home, "runs"))).toBe(false);
  ready(); await until(() => Boolean((remote as any).feeds.size));
  const log = readdirSync(join(home, "runs")).find(name => name.endsWith(".log"))!;
  expect(readFileSync(join(home, "runs", log), "utf8").replace(/^ {9}/gm, "")).toContain(spawn.args.prompt);
  const meta = JSON.parse(readFileSync(join(home, "runs", log.replace(/\.log$/, ".json")), "utf8"));
  expect(meta).toMatchObject({ version: 4, title: "Original", session: "original-session", remoteSpawnArgs: spawn.args });
  expect(sends).toHaveBeenCalledTimes(1);
});

it("retries a raced metadata deferral before creating any log, without another remote spawn or lease leak", async () => {
  const write = json.writeJsonStore;
  let deferred = false;
  vi.spyOn(json, "writeJsonStore").mockImplementation((...args) => {
    if (!deferred && args[0].includes(`${sep}runs${sep}`)) { deferred = true; throw Object.assign(new Error("synthetic raced reader"), { code: "STORE_UPGRADE_DEFERRED" }); }
    return write(...args);
  });
  await remote.request("paired", peer, spawn);
  await until(() => deferred);
  expect(readdirSync(join(home, "runs"))).toEqual([]);
  expect(readdirSync(join(home, ".storage-users"))).toEqual([]);
  await until(() => Boolean((remote as any).feeds.size));
  remote.close(); expect(readdirSync(join(home, ".storage-users"))).toEqual([]);
  expect(sends).toHaveBeenCalledTimes(1);
});

it("deduplicates pending state polls and preserves first spawn options/latest facts across the 2s deadline", async () => {
  vi.useFakeTimers();
  const owned = feed();
  let signal!: AbortSignal;
  const ready = vi.spyOn(runfeed, "startRunFeedReady").mockImplementationOnce((_options, admission) => {
    signal = admission;
    return new Promise((_resolve, reject) => admission.addEventListener("abort", () => reject(admission.reason), { once: true }));
  }).mockResolvedValue(owned);
  await remote.request("paired", peer, spawn);
  snapshot = { ...snapshot, state: { ...snapshot.state!, sessionId: "latest-session", progress: "latest progress", status: "done", report: "retained final report" }, alive: false };
  await remote.request("paired", peer, stateRequest);
  expect(ready).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_000); expect(signal.aborted).toBe(true);
  expect((remote as any).mirrorIntents.get("paired/12345678").options.header).toContain(spawn.args.prompt);
  await remote.request("paired", peer, stateRequest); await tick();
  expect(ready).toHaveBeenCalledTimes(2);
  expect(ready.mock.calls[1]![0].meta).toMatchObject({ title: "Original", remoteSpawnArgs: spawn.args });
  expect(owned.meta).toHaveBeenCalledWith(expect.objectContaining({ session: "latest-session" }));
  expect(owned.end).toHaveBeenCalledWith("done", "retained final report");
  expect(sends.mock.calls.filter(call => call[2].request.op === "spawn")).toHaveLength(1);
});

it.each(["close", "replacement"])("%s fences a late-created owned feed and releases it without reviving stale context", async action => {
  const stale = feed(), current = feed(); let resolve!: (value: RunFeed) => void;
  const ready = vi.spyOn(runfeed, "startRunFeedReady").mockImplementationOnce(() => new Promise(value => { resolve = value; })).mockResolvedValue(current);
  await remote.request("paired", peer, spawn);
  const oldSignal = ready.mock.calls[0]![1];
  if (action === "close") remote.close();
  else await remote.request("paired", peer, { ...spawn, args: { ...spawn.args, prompt: "new generation context" } });
  expect(oldSignal.aborted).toBe(true);
  resolve(stale); await tick();
  expect(stale.end).toHaveBeenCalledWith("interrupted");
  expect((remote as any).feeds.get("paired/12345678")).toBe(action === "close" ? undefined : current);
  if (action === "close") expect((remote as any).mirrorIntents.size).toBe(0);
});

it("does not apply an old poll's late response to a successfully replaced spawn generation", async () => {
  const first = feed(), replacement = feed();
  vi.spyOn(runfeed, "startRunFeedReady").mockResolvedValueOnce(first).mockResolvedValue(replacement);
  await remote.request("paired", peer, spawn); await tick();
  let oldFrame: any;
  sends.mockImplementation(async (_host, _type, frame) => {
    if (frame.request.op === "state") { oldFrame = frame; return; }
    await (remote as any).receive({ kind: "response", rid: frame.rid, value: snapshot }, { id: "paired-id", name: "paired" });
  });
  const oldPoll = remote.request("paired", peer, stateRequest); await tick();
  snapshot = { ...snapshot, state: { ...snapshot.state!, sessionId: "new-turn", updatedAt: 500 } };
  await remote.request("paired", peer, { ...spawn, args: { ...spawn.args, prompt: "new turn prompt" } }); await tick();
  const oldResult = { ...snapshot, state: { ...snapshot.state!, sessionId: "old-turn", updatedAt: 100, status: "done" }, alive: false };
  await (remote as any).receive({ kind: "response", rid: oldFrame.rid, value: oldResult }, { id: "paired-id", name: "paired" });
  expect(await oldPoll).toEqual(oldResult); await tick();
  expect(replacement.meta).not.toHaveBeenCalledWith(expect.objectContaining({ session: "old-turn" }));
  expect(replacement.end).not.toHaveBeenCalled(); expect((remote as any).feeds.get("paired/12345678")).toBe(replacement);
});

it("keeps the newest state while metadata is pending and never revives a finished mirror with older facts", async () => {
  const owned = feed(); let resolve!: (value: RunFeed) => void;
  const ready = vi.spyOn(runfeed, "startRunFeedReady").mockImplementation(() => new Promise(value => { resolve = value; }));
  snapshot = { ...snapshot, state: { ...snapshot.state!, updatedAt: 100 } };
  await remote.request("paired", peer, spawn);
  snapshot = { ...snapshot, state: { ...snapshot.state!, updatedAt: 300, sessionId: "newest-session" } };
  await remote.request("paired", peer, stateRequest);
  snapshot = { ...snapshot, state: { ...snapshot.state!, updatedAt: 200, sessionId: "stale-session", status: "done" }, alive: false };
  await remote.request("paired", peer, stateRequest);
  resolve(owned); await tick();
  expect(owned.meta).toHaveBeenCalledWith(expect.objectContaining({ session: "newest-session" }));
  expect(owned.end).not.toHaveBeenCalled();
  snapshot = { ...snapshot, state: { ...snapshot.state!, updatedAt: 400, sessionId: "finished-session", status: "done" } };
  await remote.request("paired", peer, stateRequest);
  snapshot = { ...snapshot, state: { ...snapshot.state!, updatedAt: 350, sessionId: "older-running", status: "running" }, alive: true };
  await remote.request("paired", peer, stateRequest);
  expect(ready).toHaveBeenCalledTimes(1); expect((remote as any).feeds.size).toBe(0);
});
