import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { RemoteJobs } from "../src/network/remote-jobs.js";
import { remoteSpawnArgsSchema } from "../src/network/remote-job-protocol.js";
import type { NetworkService } from "../src/network/link.js";
import type { NetworkPair } from "../src/network/pairing.js";
import { makeEnv } from "./helpers.js";
import { changedJobArgs } from "../src/mcp/job-settings.js";
import { resumeArgs } from "../src/mcp/delegate-run.js";
import { fixtureRemotePeer } from "./owned-mail.js";
import * as worktree from "../src/core/worktree.js";
vi.mock("../src/core/usage.js", async original => ({ ...await original<typeof import("../src/core/usage.js")>(), checkUsagePreflight: async () => ({ type: "allow", reason: "fixture: provider probes outside remote options contract" }) }));

it("admits exact Antigravity options at the paired receiver and rejects them for other agents before runner startup", async () => {
  const env = makeEnv();
  vi.spyOn(worktree, "gitDirsOutside").mockResolvedValue([]);
  let receive!: (payload: Record<string, unknown>, pair: NetworkPair) => Promise<void>;
  const responses: Record<string, any>[] = [], control = vi.fn(async () => {});
  const pair = { id: randomUUID(), name: "paired", fingerprint: "a".repeat(64) } as NetworkPair;
  const advertised = fixtureRemotePeer(env.home, pair, { id: "requester-id", name: "owner", sessionId: "requester-id" });
  const network = {
    registerExtension: (_frame: string, _capability: string, handler: typeof receive) => { receive = handler; },
    peers: () => [advertised],
    peerSupports: () => true,
    sendExtension: async (_host: string, _frame: string, response: Record<string, unknown>) => { responses.push(response); },
  } as unknown as NetworkService;
  writeFileSync(join(env.home, "config.json"), JSON.stringify({ network: { remoteJobs: { enabled: true, agents: ["antigravity", "codex", "muse"], allowPeers: ["paired"], allowRoots: [env.home] } } }));
  const jobs = new RemoteJobs(network, env.home, nullLogger, control);
  const start = vi.fn(async () => ({ pid: 123 }));
  // Only runner launch is replaced; wire validation, peer authorization, policy,
  // target settings, path checks and durable job arguments use production code.
  Object.defineProperty(jobs, "runners", { value: { startAsync: start, alive: () => false } });
  const frame = (target: string, args: Record<string, unknown>, job = "deadbeef") => ({ kind: "request", rid: randomUUID(), peer: { id: "requester-id", name: "owner", supervisor: "requester-id" }, request: { op: "spawn", job, target, args: { title: "native AG options", prompt: "args", cwd: env.home, ...args } } });
  try {
    for (const target of ["codex", "muse"]) for (const setting of ["terminal_sandbox", "bypass_permissions"]) {
      await receive(frame(target, { [setting]: false }), pair);
      expect(responses.at(-1)?.error).toBe(`${setting} applies only to antigravity jobs.`);
    }
    expect(start).not.toHaveBeenCalled();
    expect(remoteSpawnArgsSchema.safeParse({ title: "invalid", prompt: "task", cwd: env.home, terminal_sandbox: "false" }).success).toBe(false);
    expect(remoteSpawnArgsSchema.safeParse({ title: "invalid", prompt: "task", cwd: env.home, bypass_permissions: "true" }).success).toBe(false);
    await receive(frame("antigravity", { terminal_sandbox: true, bypass_permissions: false, access: "read" }), pair);
    expect(responses.at(-1)?.error).toBeUndefined();
    expect(start).toHaveBeenCalledOnce();
    const [job, specification] = start.mock.calls[0]! as unknown as [{ name: string; args: Record<string, unknown> }, { args: Record<string, unknown> }];
    expect(specification.args).toMatchObject({ terminal_sandbox: true, bypass_permissions: false, access: "read" });
    await receive({ kind: "request", rid: randomUUID(), peer: { id: "requester-id", name: "owner", supervisor: "requester-id" }, request: { op: "control", job: "deadbeef", control: { type: "settings", settings: { terminal_sandbox: false, bypass_permissions: true } } } }, pair);
    expect(responses.at(-1)?.error).toBeUndefined();
    expect(control).toHaveBeenCalledWith(expect.objectContaining({ id: "deadbeef" }), { type: "settings", settings: { terminal_sandbox: false, bypass_permissions: true } },
      { kind: "remote-job-control", operation: "deadbeef", owner: `native:${advertised.nativeOwner}`, source: { kind: "remote", hostId: pair.id, hostFingerprint: pair.fingerprint } });
    expect(job.args).toMatchObject({ terminal_sandbox: false, bypass_permissions: true });
    expect(job.args.access).toBeUndefined();
    const saved = changedJobArgs(job.args, { bypass_permissions: false });
    const next = resumeArgs({ prompt: "queued turn", title: "continue", bypass_permissions: true, terminal_sandbox: true }, job.name, "queued turn", "native-session", env.home, null, saved);
    expect(next).toMatchObject({ bypass_permissions: false, terminal_sandbox: false, session_id: "native-session" });
    expect(next.access).toBeUndefined();
  } finally { jobs.close(); await env.cleanup(); vi.restoreAllMocks(); }
});
