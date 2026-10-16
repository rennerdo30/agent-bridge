import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hookRequest } from "../src/cli/permission-hook.js";
import { commandIdentity, innerCommand } from "../src/core/codex-appserver.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { commitHandoff } from "../src/core/job-handoff.js";
import { JSON_STORE_VERSION } from "../src/core/json-store.js";
import { nullLogger } from "../src/core/logger.js";
import { opencodePermissionRequest } from "../src/core/opencode-served.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { answerPendingApproval, listPendingApprovals, requestIdentity, type PermissionDecision, type PermissionRequest } from "../src/core/relay.js";
import { approvalIdentity, jobCanSpawn, mcpCallEffect, readOnlyJob } from "../src/mcp/approval-reuse.js";
import { DELEGATE_DEPTH_ENV } from "../src/core/delegate.js";
import * as worktree from "../src/core/worktree.js";
import { runDelegate, type DelegateArgs, type RunContext } from "../src/mcp/delegate-run.js";
import { tagApprovalOrigin, waitForApproval, type Job } from "../src/mcp/jobs.js";
import { until } from "./helpers.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { closeMetadataDb } from "../src/core/metadata-db.js";

// Delegate bookkeeping may probe ancestors/identities in the background while approvals await answers.
// Keep those OS queries outside this fixture so the process guard measures the real approval path.
vi.mock("../src/core/procinfo.js", async (original) => {
  const real = await original<typeof import("../src/core/procinfo.js")>();
  return {
    ...real,
    lookup: vi.fn(async () => null),
    antigravityAncestor: vi.fn(async () => null),
    inspectClaudeLaunch: vi.fn(async () => ({ channel: false, print: false, interactive: false })),
  };
});
vi.mock("../src/core/process-identity.js", async (original) => {
  const real = await original<typeof import("../src/core/process-identity.js")>();
  const identity = (pid: number) => pid === process.pid ? "fixture-own-identity" : undefined;
  return {
    ...real,
    // Seed the synchronous own-identity path too: a cold/failed OS query starts an internal async refresh.
    processIdentity: vi.fn(identity),
    ownProcessIdentity: vi.fn(async () => identity(process.pid)),
    parentProcessIdentity: vi.fn(async () => null),
    readProcessIdentity: vi.fn(async (pid: number) => identity(pid) ?? null),
    readProcessIdentities: vi.fn(async (pids: number[]) => new Map(
      pids.filter(pid => pid === process.pid).map(pid => [pid, identity(pid)!]),
    )),
  };
});

// Every process start and Git call is counted: the approval path must run none (AB-402).
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  return { ...real, spawn: vi.fn(real.spawn), spawnSync: vi.fn(real.spawnSync), execFile: vi.fn(real.execFile), execFileSync: vi.fn(real.execFileSync), exec: vi.fn(real.exec), execSync: vi.fn(real.execSync), fork: vi.fn(real.fork) };
});
vi.mock("../src/core/worktree.js", async (original) => {
  const real = await original<typeof import("../src/core/worktree.js")>();
  return { ...real, git: vi.fn(real.git) };
});

/** AB-402: an approval identical to one the supervisor already granted in the same job is reused, never widened. */
let home: string;
/** The job's working folder (not a Git repository: the approval path never looks at Git). */
let repo: string;
beforeEach(() => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!;
  mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "reuse-"));
  repo = join(home, "repo");
  mkdirSync(repo);
  // This process runs at delegate depth 0, whatever session started the test run.
  vi.stubEnv(DELEGATE_DEPTH_ENV, "0");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); closeMetadataDb(home); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

type Answer = { allow: boolean; reason: string };
let answerCount = 0;
const approvalId = () => `00000000-0000-4000-8000-${String(++answerCount).padStart(12, "0")}`;
/** Stand-ins for answers of waitForApproval, tagged with the approval they settled and who decided it. */
const allowed = (by = "MCP decide"): Answer & { approvalId: string } => {
  const id = approvalId();
  return tagApprovalOrigin({ allow: true, reason: "allow", approvalId: id }, { approvalId: id, by });
};
const denied = (): Answer => tagApprovalOrigin({ allow: false, reason: "deny: not now" }, { approvalId: approvalId(), by: "MCP decide" });

/**
 * Command grants are reused only in read-only jobs, and a job that can start subagents is never read-only (its child
 * jobs may change files): the default context sets maxDelegateDepth to 1, so a job started here (depth 1) has no
 * spawn tools, and the Codex approvals reviewer to "user" (auto_review is not read-only either). The tests of those
 * rules change them.
 */
const context = (answers: Answer[]): RunContext => ({
  agent: "claude", cfg: { ...DEFAULT_CONFIG, maxDelegateDepth: 1, codexApprovalsReviewer: "user" }, home, log: nullLogger, me: () => "parent", cwd: () => repo,
  jobs: { askParent: vi.fn(async () => answers.shift() ?? denied()), fromSubagent: vi.fn(), note: vi.fn() },
});
const job = (id = "test"): Job => ({ id, name: `codex-job-${id}`, agent: "codex", model: null, prompt: "task", startedAt: Date.now(), controller: new AbortController(), progress: null, status: "running", sessionId: null, workdir: null, worktree: null, queue: [] });
let item = 0;
/** A Codex app-server command approval, built as codex-appserver.ts builds it (fresh per-request ids each time). */
const codexCommand = (params: Record<string, unknown>): PermissionRequest => {
  const exact = commandIdentity({ itemId: `item-${++item}`, threadId: "thread", turnId: "turn", startedAtMs: Date.now(), ...params }, repo)!;
  return { agent: "codex", tool: "command", detail: innerCommand(String(params.command)), cwd: exact.cwd, identity: exact.identity };
};
const command = (line: string): PermissionRequest => codexCommand({ command: line });
/** A Claude or Codex PermissionRequest hook request, built by the real hook. */
const hook = (agent: "claude" | "codex", tool: string, input: Record<string, unknown>): PermissionRequest =>
  hookRequest(agent, { tool_name: tool, tool_input: input, cwd: repo });

/** One turn of the job in which the subagent asks for each request in order; returns the decisions. Command grants
 * are reused only in read-only jobs, so the default is a Codex job with read access (its sandbox is read-only). */
async function turn(rc: RunContext, j: Job, requests: PermissionRequest[], args: Partial<DelegateArgs> = {}): Promise<boolean[]> {
  const decisions: boolean[] = [];
  vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
    for (const request of requests) decisions.push((await req.approve!(request)).allow);
    return { sessionId: "saved", text: "done", isError: false, details: {} };
  });
  await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "read", ...args }, j.controller.signal, undefined, true, j);
  return decisions;
}

describe("identical approval reuse within a job (AB-402)", () => {
  it("reuses an identical grant in the same job, logs it with the original id and asks no second question", async () => {
    const first = allowed();
    const rc = context([first]);
    const j = job();
    expect(await turn(rc, j, [command("npm test"), command("npm test"), command("npm test")])).toEqual([true, true, true]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
    const notes = vi.mocked(rc.jobs!.fromSubagent).mock.calls.filter(([, body]) => body.includes("reused"));
    expect(notes).toHaveLength(2);
    expect(notes[0]![1]).toContain(first.approvalId);
    // The first reuse of a grant reaches the supervisor like a question (not quiet); later reuses are quiet notes.
    expect([notes[0]![3], notes[0]![4]]).toEqual([true, false]);
    expect([notes[1]![3], notes[1]![4]]).toEqual([false, true]);
  });

  it("reuses an allow answered through decide, with its real approval id, and never one answered by timeout", async () => {
    const rc = context([]);
    rc.jobs!.askParent = vi.fn((j: Job, question: string, timeoutMs: number, request?: PermissionRequest) => waitForApproval(j, question, timeoutMs, () => {}, nullLogger, home, request));
    const j = job();
    let approval = "";
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      const first = req.approve!(command("npm test"));
      await until(() => listPendingApprovals(home).length === 1);
      approval = listPendingApprovals(home)[0]!.id;
      expect(await answerPendingApproval(home, approval, { decision: "allow", source: "MCP decide" })).toBe("answered");
      expect(await first).toEqual({ allow: true });
      expect(await req.approve!(command("npm test"))).toEqual({ allow: true });
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    const result = await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
    expect(listPendingApprovals(home)).toEqual([]);
    expect(vi.mocked(rc.jobs!.fromSubagent).mock.calls.some(([, body]) => body.includes(`reused`) && body.includes(approval))).toBe(true);
    expect(result.text).toContain(`allowed (reused approval ${approval})`);
  });

  it("never reuses an answer from a paired PC's supervisor (L3: remote answers carry their real source)", async () => {
    const rc = context([]);
    rc.jobs!.askParent = vi.fn((j: Job, question: string, timeoutMs: number, request?: PermissionRequest) => waitForApproval(j, question, timeoutMs, () => {}, nullLogger, home, request));
    const j = job();
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      for (let i = 0; i < 2; i++) {
        const decision = req.approve!(command("npm test"));
        await until(() => listPendingApprovals(home).length === 1);
        // remote-jobs.ts answers a remote job's approval this way.
        expect(await answerPendingApproval(home, listPendingApprovals(home)[0]!.id, { decision: "allow", source: "remote supervisor" })).toBe("answered");
        expect(await decision).toEqual({ allow: true });
        await until(() => listPendingApprovals(home).length === 0);
      }
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
  });

  it("ends the grants when the job's turn finishes: a continuation asks again", async () => {
    const rc = context([allowed(), allowed()]);
    const j = job();
    expect(await turn(rc, j, [command("npm test")])).toEqual([true]);
    expect(j.approvalGrants).toBeUndefined();
    expect(await turn(rc, j, [command("npm test")])).toEqual([true]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
  });

  it("asks again in the same job when the arguments differ", async () => {
    const rc = context([allowed(), allowed()]);
    const j = job();
    expect(await turn(rc, j, [command("npm test"), command("npm test -- --watch")])).toEqual([true, true]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
  });

  it("asks again in the same job when the tool or folder differs", async () => {
    const rc = context([allowed(), allowed(), allowed()]);
    const j = job();
    await turn(rc, j, [command("npm test"), { ...command("npm test"), tool: "shell" }, { ...command("npm test"), cwd: "E:/other" }]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(3);
  });

  it("asks in a different job", async () => {
    const rc = context([allowed(), allowed()]);
    await turn(rc, job("one"), [command("npm test")]);
    await turn(rc, job("two"), [command("npm test")]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
  });

  it("never reuses a deny: an identical request after a deny is asked again", async () => {
    const rc = context([denied(), allowed()]);
    const j = job();
    expect(await turn(rc, j, [command("npm test"), command("npm test")])).toEqual([false, true]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
  });

  it("revokes a grant when a concurrent identical request is denied after it was allowed", async () => {
    const rc = context([]);
    const pending: ((answer: Answer) => void)[] = [];
    rc.jobs!.askParent = vi.fn(() => new Promise<Answer>((resolve) => pending.push(resolve)));
    const j = job();
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      const first = req.approve!(command("npm test"));
      const second = req.approve!(command("npm test"));
      await until(() => pending.length === 2);
      pending[0]!(allowed());
      expect(await first).toEqual({ allow: true });
      pending[1]!(denied());
      expect((await second).allow).toBe(false);
      // The deny revoked the grant: the next identical request is asked.
      const third = req.approve!(command("npm test"));
      await until(() => pending.length === 3);
      pending[2]!(denied());
      expect((await third).allow).toBe(false);
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(3);
  });

  it("asks again after the job's access changes", async () => {
    const rc = context([allowed(), allowed(), allowed()]);
    const j = job();
    await turn(rc, j, [command("npm test")], { access: "edit" });
    await turn(rc, j, [command("npm test")], { access: "read" });
    await turn(rc, j, [command("npm test")], { access: "edit" });
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(3);
  });

  it("asks again after the job's sandbox changes", async () => {
    const rc = context([allowed(), allowed()]);
    const j = job();
    await turn(rc, j, [command("npm test")], { sandbox: "workspace-write" });
    await turn(rc, j, [command("npm test")], { sandbox: "danger-full-access" });
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
  });

  it("asks again after the job's supervisor changes in memory", async () => {
    const rc = context([allowed(), allowed()]);
    const j = job();
    j.owner = "parent";
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      await req.approve!(command("npm test"));
      j.supervisor = "other-main";
      await req.approve!(command("npm test"));
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
  });

  describe("handoff_subagents through the durable job store", () => {
    const peer = (name: string): PeerInfo => ({ id: name, name, agent: "claude", cwd: home, pid: process.pid, agentPid: null, sessionId: null, startedAt: 1, autoWake: false });
    const stored = (j: Job) => writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: JSON_STORE_VERSION, jobs: [
      { id: j.id, name: j.name, agent: "codex", model: null, prompt: "task", owner: "parent", status: "running", startedAt: j.startedAt, sessionId: null, workdir: null, worktree: null, args: { title: "reuse" } },
    ] }));
    async function handoffTurn(rc: RunContext, j: Job, handoff: boolean): Promise<void> {
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        expect((await req.approve!(command("npm test"))).allow).toBe(true);
        // Another process hands the job over: only the durable store changes, this runner's job stays as it was.
        if (handoff) commitHandoff(join(home, "jobs.json"), peer("parent"), peer("other-main"), { to: "other-main", jobs: [j.name] });
        expect((await req.approve!(command("npm test"))).allow).toBe(true);
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
    }

    it("keeps reusing while the store names the same supervisor", async () => {
      const rc = context([allowed(), allowed()]);
      const j = { ...job(), owner: "parent" };
      stored(j);
      await handoffTurn(rc, j, false);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
    });

    it("asks again after a handoff that only the store records", async () => {
      const rc = context([allowed(), allowed()]);
      const j = { ...job(), owner: "parent" };
      stored(j);
      await handoffTurn(rc, j, true);
      expect(j.owner).toBe("parent");
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
    });

    it("asks when the store exists but cannot be read, and never falls back to the supervisor in memory (L2)", async () => {
      const rc = context([allowed(), allowed(), allowed()]);
      const j = { ...job(), owner: "parent" };
      stored(j);
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        expect((await req.approve!(command("npm test"))).allow).toBe(true);
        // A read failure right after a store-only handoff must not reuse the old supervisor's grant.
        writeFileSync(join(home, "jobs.json"), "{ not json");
        expect((await req.approve!(command("npm test"))).allow).toBe(true);
        expect((await req.approve!(command("npm test"))).allow).toBe(true);
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(3);
    });

    it("asks when the store does not have the job (L2)", async () => {
      const rc = context([allowed(), allowed()]);
      const j = { ...job(), owner: "parent" };
      stored({ ...job("someone-else"), owner: "parent" });
      await turn(rc, j, [command("npm test"), command("npm test")]);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
    });
  });

  it("asks every time when jobs.reuseIdenticalApprovals is off", async () => {
    const rc = context([allowed(), allowed()]);
    rc.cfg.jobs = { ...rc.cfg.jobs, reuseIdenticalApprovals: false };
    const j = job();
    expect(await turn(rc, j, [command("npm test"), command("npm test")])).toEqual([true, true]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an allow without an explicit supervisor or owner decision behind it", async () => {
    const rc = context([{ allow: true, reason: "allow" }, allowed("timeout"), allowed()]);
    const j = job();
    await turn(rc, j, [command("npm test"), command("npm test"), command("npm test")]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(3);
  });

  it("does not reuse requests without a reliable identity", async () => {
    const rc = context([allowed(), allowed(), allowed(), allowed(), allowed(), allowed()]);
    const j = job();
    const review: PermissionRequest = { ...command("npm publish"), automaticReview: true };
    const summary: PermissionRequest = { ...command("file changes"), tool: "edit", inexact: true };
    const { identity: _identity, ...anonymous } = command("npm test");
    await turn(rc, j, [review, review, summary, summary, anonymous, anonymous]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(6);
  });

  it("shows a reuse in the run report of the native dialog path", async () => {
    const rc = context([]);
    rc.askUser = vi.fn(async (): Promise<PermissionDecision> => ({ allow: true }));
    const j = { ...job(), owner: "parent", foreground: true };
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      expect(await req.approve!(command("npm test"))).toEqual({ allow: true });
      expect(await req.approve!(command("npm test"))).toEqual({ allow: true });
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    const result = await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "read" }, j.controller.signal, undefined, false, j);
    expect(rc.askUser).toHaveBeenCalledOnce();
    expect(rc.jobs!.askParent).not.toHaveBeenCalled();
    expect(result.text).toMatch(/allowed \(reused approval [0-9a-f-]{36}\): command npm test/);
  });

  describe("hidden request fields (H1)", () => {
    // The variants are denied: an allowed other command would end the grant (read-only rule), a denied one does not,
    // so the final request shows the grant survived every variant (a variant taken as identical would have been
    // reused, or its deny would have revoked the grant).
    it("asks again when a Claude Bash request differs only in a field the question does not show", async () => {
      const rc = context([allowed(), ...Array.from({ length: 3 }, () => denied())]);
      const j = job();
      const bash = (input: Record<string, unknown>) => hook("claude", "Bash", { command: "npm test", ...input });
      await turn(rc, j, [bash({}), bash({ dangerouslyDisableSandbox: true }), bash({ run_in_background: true }), bash({ timeout: 600_000 }), bash({})]);
      // All five show "npm test"; only the last is the same request as the first.
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(4);
    });

    it("asks again when a Codex hook request differs in its folder or escalation fields", async () => {
      const rc = context([allowed(), ...Array.from({ length: 3 }, () => denied())]);
      const j = job();
      const shell = (input: Record<string, unknown>) => hook("codex", "Bash", { command: "npm test", ...input });
      await turn(rc, j, [shell({ workdir: "a" }), shell({ workdir: "b" }), shell({ workdir: "a", sandbox_permissions: "require_escalated", justification: "network" }),
        shell({ workdir: "a", with_escalated_permissions: true }), shell({ workdir: "a" })]);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(4);
    });

    it("asks again when a Codex command runs in another folder, through another shell, or with other approval context (M1)", async () => {
      const other = join(home, "other");
      mkdirSync(other);
      const rc = context([allowed(), ...Array.from({ length: 4 }, () => denied())]);
      const j = job();
      await turn(rc, j, [
        codexCommand({ command: "bash -lc 'npm test'", cwd: repo }),
        codexCommand({ command: "bash -lc 'npm test'", cwd: other }),
        codexCommand({ command: "zsh -lc 'npm test'", cwd: repo }),
        codexCommand({ command: "bash -lc 'npm test'", cwd: repo, networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" } }),
        codexCommand({ command: "bash -lc 'npm test'", cwd: repo, proposedExecpolicyAmendment: ["npm", "test"] }),
        codexCommand({ command: "bash -lc 'npm test'", cwd: repo }),
      ]);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(5);
    });
  });

  describe("file changes (H2, M2)", () => {
    it("always asks for Claude file edits, also for identical ones", async () => {
      const rc = context(Array.from({ length: 4 }, () => allowed()));
      const j = job();
      const write = hook("claude", "Write", { file_path: join(repo, "a.ts"), content: "one" });
      const edit = hook("claude", "Edit", { file_path: join(repo, "a.ts"), old_string: "one", new_string: "two" });
      await turn(rc, j, [write, write, edit, edit]);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(4);
    });

    it("always asks for opencode edits at the same path, whatever their content, and reuses only an identical command", async () => {
      const rc = context(Array.from({ length: 5 }, () => allowed()));
      const j = job();
      const edit = (diff: string) => opencodePermissionRequest({ id: `per-${diff}`, sessionID: "s", permission: "edit", patterns: ["a.ts"], metadata: { filepath: "a.ts", diff } }, [], repo);
      const bash = (metadata: Record<string, unknown>, id: string) => opencodePermissionRequest({ id, sessionID: "s", permission: "bash", patterns: ["npm test"], metadata: { command: "npm test", ...metadata } }, [], repo);
      expect(edit("one").detail).toBe("a.ts");
      await turn(rc, j, [edit("one"), edit("one"), edit("two"), bash({}, "p1"), bash({}, "p2"), bash({ timeout: 1 }, "p3")]);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(5);
    });

    it("drops the command grants after an allowed file change request or another allowed command", async () => {
      const rc = context(Array.from({ length: 6 }, () => allowed()));
      const j = job();
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        const ask = async (r: PermissionRequest) => expect((await req.approve!(r)).allow).toBe(true);
        await ask(command("./deploy.sh"));
        await ask(command("./deploy.sh"));
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
        // A file change request ends command grants even before anything is written.
        await ask(hook("claude", "Edit", { file_path: join(repo, "deploy.sh"), old_string: "two", new_string: "three" }));
        await ask(command("./deploy.sh"));
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(3);
        await ask(command("./deploy.sh"));
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(3);
        // Another allowed command may have written files: it ends the earlier command grants.
        await ask(command("cp other.sh deploy.sh"));
        await ask(command("./deploy.sh"));
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(5);
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(5);
    });
  });

  describe("command grants only in read-only jobs", () => {
    it("reuses a command grant in a read-only job (Codex read access and an explicit read-only sandbox)", async () => {
      for (const args of [{ access: "read" as const }, { access: "ask" as const, sandbox: "read-only" }, { access: "edit" as const, sandbox: "read-only" }]) {
        const rc = context([allowed(), allowed()]);
        expect(await turn(rc, job(), [command("npm test"), command("npm test")], args)).toEqual([true, true]);
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
      }
    });

    it("never reuses a command in a workspace-write, full-access or edit job", async () => {
      for (const args of [{ access: "edit" as const }, { access: "read" as const, sandbox: "workspace-write" }, { access: "read" as const, sandbox: "danger-full-access" }]) {
        const rc = context([allowed(), allowed()]);
        const j = job();
        expect(await turn(rc, j, [command("npm test"), command("npm test")], args)).toEqual([true, true]);
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
        expect(j.approvalGrants?.grants ?? []).toEqual([]);
      }
    });

    it("never reuses a command when an auto-approved pattern names a server other than the Pair Desk", async () => {
      const rc = context([allowed(), allowed()]);
      await turn(rc, job(), [command("npm test"), command("npm test")], { allow_tools: ["files.write_file"] });
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
    });

    it("asks when the job's access changes from read to edit between the grant and the reuse", async () => {
      const rc = context([allowed(), allowed(), allowed()]);
      // No access argument: the sandbox comes from the configuration, which changes while the job runs.
      rc.cfg = { ...rc.cfg, codexSandbox: "read-only" };
      const j = job();
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        expect((await req.approve!(command("npm test"))).allow).toBe(true);
        rc.cfg.codexSandbox = "workspace-write";
        expect((await req.approve!(command("npm test"))).allow).toBe(true);
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
        // Back to read-only: the grant made while it could write was not kept.
        rc.cfg.codexSandbox = "read-only";
        expect((await req.approve!(command("npm test"))).allow).toBe(true);
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task" }, j.controller.signal, undefined, true, j);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(3);
    });

    it("keeps no command grant when the job's access changes while the question waits", async () => {
      const rc = context([]);
      rc.cfg = { ...rc.cfg, codexSandbox: "read-only" };
      rc.jobs!.askParent = vi.fn(async () => { rc.cfg.codexSandbox = "workspace-write"; return allowed(); });
      const j = job();
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        expect((await req.approve!(command("npm test"))).allow).toBe(true);
        expect(j.approvalGrants?.grants ?? []).toEqual([]);
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task" }, j.controller.signal, undefined, true, j);
    });

    it("reuses an identical MCP tool call in an edit job, and a command does not end it", async () => {
      const rc = context([allowed(), allowed()]);
      const j = job();
      const mcp = hook("claude", "mcp__other__lookup", { query: "x" });
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        expect((await req.approve!(mcp)).allow).toBe(true);
        expect((await req.approve!(command("npm test"))).allow).toBe(true);
        // Isolate the grant store from the per-server allow that covers the rest of the run.
        j.allowedServers?.clear();
        expect((await req.approve!(mcp)).allow).toBe(true);
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "edit" }, j.controller.signal, undefined, true, j);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
      expect(vi.mocked(rc.jobs!.fromSubagent).mock.calls.some(([, body]) => body.includes("reused") && body.includes("mcp:other"))).toBe(true);
    });

    it("runs no Git command and starts no process on the approval path", async () => {
      const spawned = [childProcess.spawn, childProcess.spawnSync, childProcess.execFile, childProcess.execFileSync, childProcess.exec, childProcess.execSync, childProcess.fork, worktree.git].map((fn) => vi.mocked(fn));
      const rc = context(Array.from({ length: 4 }, () => allowed()));
      const j = job();
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        for (const fn of spawned) fn.mockClear();
        for (const r of [command("npm test"), command("npm test"), hook("claude", "mcp__other__lookup", {}), hook("claude", "Edit", { file_path: join(repo, "a.ts"), old_string: "a", new_string: "b" }), command("npm test")]) {
          expect((await req.approve!(r)).allow).toBe(true);
        }
        const execFileCalls = vi.mocked(childProcess.execFile).mock.calls.map(([file, args]) => ({ file, args }));
        expect(spawned.map((fn) => fn.mock.calls.length), `execFile calls: ${JSON.stringify(execFileCalls)}`).toEqual(spawned.map(() => 0));
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(4);
    });
  });

  describe("jobs that can reach files without a command approval (H1, M2, M3, L4)", () => {
    /** A command grant planted directly, so a path that cannot coexist with one can still show that it ends it. */
    const plant = (j: Job) => {
      j.approvalGrants ??= { jobId: j.id, scope: "planted", grants: [] };
      j.approvalGrants.grants.push({ identity: "planted", approvalId: "planted", by: "MCP decide", at: 0, command: true, reuses: 0 });
    };
    const commandGrants = (j: Job) => (j.approvalGrants?.grants ?? []).filter((grant) => grant.command).length;
    const ownCall = (tool: string) => hook("claude", `mcp__plugin_agent-bridge_bridge__${tool}`, { prompt: "x" });

    it("asks every command in a job that can start subagents (its delegate depth is below the limit)", async () => {
      for (const [max, depth] of [[2, "0"], [3, "1"]] as const) {
        vi.stubEnv(DELEGATE_DEPTH_ENV, depth);
        const rc = context([allowed(), allowed()]);
        rc.cfg.maxDelegateDepth = max;
        const j = job();
        expect(await turn(rc, j, [command("npm test"), command("npm test")])).toEqual([true, true]);
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
        expect(j.approvalGrants?.grants ?? []).toEqual([]);
      }
      // At the limit the job has no spawn tools: the command is reused.
      vi.stubEnv(DELEGATE_DEPTH_ENV, "1");
      const rc = context([allowed(), allowed()]);
      rc.cfg.maxDelegateDepth = 2;
      expect(await turn(rc, job(), [command("npm test"), command("npm test")])).toEqual([true, true]);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
    });

    it("drops the command grants on an own-server spawn or steering call and keeps none for the rest of the turn", async () => {
      const rc = context(Array.from({ length: 4 }, () => allowed()));
      const j = job();
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        const ask = async (r: PermissionRequest) => expect((await req.approve!(r)).allow).toBe(true);
        await ask(command("npm test"));
        // Read and status tools of its own server keep the grant.
        await ask(ownCall("send"));
        await ask(ownCall("report_progress"));
        await ask(command("npm test"));
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
        // spawn_* is allowed without a question, but a child job may change files.
        await ask(ownCall("spawn_codex"));
        expect(commandGrants(j)).toBe(0);
        await ask(command("npm test"));
        await ask(command("npm test"));
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(3);
        expect(commandGrants(j)).toBe(0);
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
      // Codex names its own server "agent-bridge": message_subagent ends the grants the same way.
      const steer: PermissionRequest = { agent: "codex", tool: "mcp:agent-bridge", detail: 'Allow the agent-bridge MCP server to run tool "message_subagent"?' };
      const codex = context([allowed(), allowed()]);
      expect(await turn(codex, job("steer"), [command("npm test"), steer, command("npm test")])).toEqual([true, true, true]);
      expect(codex.jobs!.askParent).toHaveBeenCalledTimes(2);
    });

    it("is not read-only while a server other than the Pair Desk is allowed for the rest of the job", async () => {
      const rc = context([allowed(), allowed()]);
      const j = job();
      j.allowedServers = new Set(["mcp:files"]);
      expect(await turn(rc, j, [command("npm test"), command("npm test")])).toEqual([true, true]);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
      // The Pair Desk server writes only to the desk.
      const desk = context([allowed(), allowed()]);
      const k = job("desk");
      k.allowedServers = new Set(["mcp:plugin_agent-pair-programming_pair-desk"]);
      expect(await turn(desk, k, [command("npm test"), command("npm test")])).toEqual([true, true]);
      expect(desk.jobs!.askParent).toHaveBeenCalledTimes(1);
    });

    it("drops the command grants on an explicitly allowed MCP call with an exact identity (M3)", async () => {
      const rc = context(Array.from({ length: 3 }, () => allowed()));
      const lookup = hook("claude", "mcp__other__lookup", { query: "x" });
      expect(approvalIdentity(lookup)).not.toBeNull();
      expect(await turn(rc, job(), [command("npm test"), command("npm test"), lookup, command("npm test")])).toEqual([true, true, true, true]);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(3);
    });

    it("drops the command grants on an MCP call allowed through an allowed server, a reused grant or an allow pattern (M2)", async () => {
      const rc = context([allowed()]);
      const j = job();
      const lookup = hook("claude", "mcp__other__lookup", { query: "x" });
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        // Asked once: the call's grant is kept and its server is allowed for the rest of the job.
        expect((await req.approve!(lookup)).allow).toBe(true);
        // Through the allowed server, without a question.
        plant(j);
        expect((await req.approve!(lookup)).allow).toBe(true);
        expect(commandGrants(j)).toBe(0);
        // Through the reused grant of the identical call.
        j.allowedServers?.clear();
        plant(j);
        expect((await req.approve!(lookup)).allow).toBe(true);
        expect(commandGrants(j)).toBe(0);
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
      // Through an allow pattern; a Pair Desk call keeps the grants.
      const auto = context([]);
      const k = job("auto");
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        plant(k);
        expect((await req.approve!(hook("claude", "mcp__plugin_agent-pair-programming_pair-desk__comment", { id: 1 }))).allow).toBe(true);
        expect(commandGrants(k)).toBe(1);
        expect((await req.approve!(hook("claude", "mcp__files__write_file", { path: "a" }))).allow).toBe(true);
        expect(commandGrants(k)).toBe(0);
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(auto, "codex", { title: "reuse", prompt: "task", access: "read", allow_tools: ["files.write_file", "pair-desk:worker"] }, k.controller.signal, undefined, true, k);
      expect(auto.jobs!.askParent).not.toHaveBeenCalled();
    });

    it("never reuses a command in a Codex job whose approvals reviewer is auto_review (L4)", async () => {
      for (const [cfgReviewer, argReviewer] of [["auto_review", undefined], ["user", "auto_review"]] as const) {
        const rc = context([allowed(), allowed()]);
        rc.cfg.codexApprovalsReviewer = cfgReviewer;
        const j = job();
        expect(await turn(rc, j, [command("npm test"), command("npm test")], argReviewer ? { approvals_reviewer: argReviewer } : {})).toEqual([true, true]);
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
        expect(j.approvalGrants?.grants ?? []).toEqual([]);
      }
    });

    it("ends the grants when the Codex approvals reviewer changes (L4)", async () => {
      const rc = context([allowed(), allowed()]);
      const j = job();
      const lookup = hook("claude", "mcp__other__lookup", { query: "x" });
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        expect((await req.approve!(lookup)).allow).toBe(true);
        j.allowedServers?.clear();
        expect((await req.approve!(lookup)).allow).toBe(true);
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
        // An MCP grant does not depend on read-only settings: only the reviewer in its scope ends it here.
        rc.cfg.codexApprovalsReviewer = "auto_review";
        j.allowedServers?.clear();
        expect((await req.approve!(lookup)).allow).toBe(true);
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "edit" }, j.controller.signal, undefined, true, j);
    });
  });
});

describe("readOnlyJob", () => {
  const ro = (target: string, permission: string, more: Partial<Parameters<typeof readOnlyJob>[0]> = {}) =>
    readOnlyJob({ target, permission, approvalsReviewer: target === "codex" ? "user" : undefined, allowPatterns: [], allowedServers: [], canSpawn: false, ...more });
  it("counts only settings in which the job writes nothing without asking", () => {
    expect(ro("codex", "read-only")).toBe(true);
    expect(ro("codex", "workspace-write")).toBe(false);
    expect(ro("codex", "danger-full-access")).toBe(false);
    for (const mode of ["default", "manual", "plan"]) expect(ro("claude", mode)).toBe(true);
    for (const mode of ["acceptEdits", "auto", "dontAsk", "bypassPermissions"]) expect(ro("claude", mode)).toBe(false);
    expect(ro("opencode", "read-only")).toBe(true);
    expect(ro("opencode", "auto-approve")).toBe(false);
    for (const target of ["antigravity", "muse"]) {
      expect(ro(target, "read")).toBe(true);
      expect(ro(target, "ask")).toBe(true);
      expect(ro(target, "edit")).toBe(false);
    }
    expect(ro("antigravity", "native", { bypassPermissions: false })).toBe(false);
    expect(ro("antigravity", "read", { bypassPermissions: false })).toBe(false);
    // A Muse profile may be named "read": a profile is never read-only.
    expect(ro("muse", "read", { permissionProfile: "read" })).toBe(false);
  });
  it("fails closed for unknown targets, permissions and allow patterns", () => {
    expect(ro("other", "read-only")).toBe(false);
    expect(ro("codex", "")).toBe(false);
    expect(ro("claude", "something-new")).toBe(false);
    expect(ro("codex", "read-only", { allowPatterns: ["pair-desk:worker", "pair-desk.get_*", "pair-desk"] })).toBe(true);
    expect(ro("codex", "read-only", { allowPatterns: ["pair-desk.get_*", "files.*"] })).toBe(false);
    expect(ro("codex", "read-only", { allowPatterns: ["*"] })).toBe(false);
    expect(ro("codex", "read-only", { allowPatterns: ["pair-desk-evil.write"] })).toBe(false);
  });
  it("is never read-only when the job can start subagents (H1)", () => {
    for (const [target, permission] of [["codex", "read-only"], ["claude", "default"], ["opencode", "read-only"], ["antigravity", "read"], ["muse", "read"]] as const) {
      expect(ro(target, permission)).toBe(true);
      expect(ro(target, permission, { canSpawn: true })).toBe(false);
    }
  });
  it("is never read-only with a server other than the Pair Desk allowed for the rest of the job (M2)", () => {
    expect(ro("codex", "read-only", { allowedServers: ["mcp:pair-desk", "mcp:plugin_agent-pair-programming_pair-desk"] })).toBe(true);
    expect(ro("codex", "read-only", { allowedServers: ["mcp:pair-desk", "mcp:files"] })).toBe(false);
    expect(ro("codex", "read-only", { allowedServers: ["mcp:pair-desk-evil"] })).toBe(false);
    expect(ro("codex", "read-only", { allowedServers: ["pair-desk"] })).toBe(false);
  });
  it("requires the Codex approvals reviewer user (L4)", () => {
    expect(ro("codex", "read-only", { approvalsReviewer: "auto_review" })).toBe(false);
    expect(ro("codex", "read-only", { approvalsReviewer: undefined })).toBe(false);
  });
});

describe("jobCanSpawn", () => {
  it("follows the depth at which the job's bridge server registers spawn_*", () => {
    expect(jobCanSpawn(1, { [DELEGATE_DEPTH_ENV]: "0" })).toBe(false);
    expect(jobCanSpawn(2, { [DELEGATE_DEPTH_ENV]: "0" })).toBe(true);
    expect(jobCanSpawn(2, { [DELEGATE_DEPTH_ENV]: "1" })).toBe(false);
    expect(jobCanSpawn(3, { [DELEGATE_DEPTH_ENV]: "1" })).toBe(true);
    // The limit is capped like the configuration caps it.
    expect(jobCanSpawn(99, { [DELEGATE_DEPTH_ENV]: "2" })).toBe(false);
  });
});

describe("mcpCallEffect", () => {
  it("keeps grants for desk calls and own read or status tools, and ends them for anything else", () => {
    expect(mcpCallEffect({ tool: "command", detail: "npm test" })).toBeNull();
    expect(mcpCallEffect({ tool: "mcp:plugin_agent-pair-programming_pair-desk", detail: "comment: {}" })).toBe("keep");
    expect(mcpCallEffect({ tool: "mcp:pair-desk", detail: 'Allow the pair-desk MCP server to run tool "progress"?' })).toBe("keep");
    expect(mcpCallEffect({ tool: "mcp:other", detail: "lookup: {}" })).toBe("drop");
    for (const tool of ["send", "report_progress", "peers", "inbox", "wait_for_message", "usage_limits"])
      expect(mcpCallEffect({ tool: "mcp:plugin_agent-bridge_bridge", detail: `${tool}: {}` })).toBe("keep");
    for (const tool of ["spawn_codex", "ask_claude", "message_subagent", "decide", "cancel_subagent"])
      expect(mcpCallEffect({ tool: "mcp:plugin_agent-bridge_bridge", detail: `${tool}: {}` })).toBe("block");
    expect(mcpCallEffect({ tool: "mcp:agent-bridge", detail: 'Allow the agent-bridge MCP server to run tool "spawn_codex"?' })).toBe("block");
    expect(mcpCallEffect({ tool: "mcp:bridge", detail: "bridge_message_subagent: {}" })).toBe("block");
  });
});

describe("approvalIdentity", () => {
  it("is exact on agent, tool, folder, the shown text and the source's identity, with no normalization", () => {
    expect(approvalIdentity(command("npm test"))).toBe(approvalIdentity(command("npm test")));
    expect(approvalIdentity(command("npm test"))).not.toBe(approvalIdentity(command("npm test\r\n")));
    expect(approvalIdentity(command("npm test"))).not.toBe(approvalIdentity(command(" npm test")));
    expect(approvalIdentity(command("npm test"))).not.toBe(approvalIdentity({ ...command("npm test"), agent: "claude" }));
    expect(approvalIdentity(command("npm test"))).not.toBe(approvalIdentity({ ...command("npm test"), identity: requestIdentity({ command: "npm test", hidden: true }) }));
    // The shown text is bound too: an identity can never stand behind a different question.
    expect(approvalIdentity(command("npm test"))).not.toBe(approvalIdentity({ ...command("npm test"), detail: "npm run test" }));
    expect(approvalIdentity({ ...command("npm test"), reason: "a" })).toBe(approvalIdentity({ ...command("npm test"), reason: "b" }));
  });
  it("has none for reviewer refusals, summaries, cut text, empty text, requests without an identity and sandbox permission requests", () => {
    expect(approvalIdentity({ ...command("x"), automaticReview: true })).toBeNull();
    expect(approvalIdentity({ ...command("x"), inexact: true })).toBeNull();
    expect(approvalIdentity({ ...command("x"), detailLength: 99_999 })).toBeNull();
    expect(approvalIdentity({ ...command("x"), detail: "" })).toBeNull();
    expect(approvalIdentity({ ...command("x"), identity: undefined })).toBeNull();
    expect(approvalIdentity({ ...command("{}"), tool: "permissions" })).toBeNull();
  });
  it("keeps per-request bookkeeping out of a Codex command identity", () => {
    expect(commandIdentity({ command: "npm test", itemId: "a", startedAtMs: 1 }, repo)).toEqual(commandIdentity({ command: "npm test", itemId: "b", startedAtMs: 2 }, repo));
    expect(commandIdentity({ command: "npm test" }, repo)).toEqual(commandIdentity({ command: "npm test", cwd: repo }, repo));
    expect(commandIdentity({ reason: "run the checks" }, repo)).toBeUndefined();
  });
});

describe("jobs.reuseIdenticalApprovals config", () => {
  it("is on by default and can be switched off in the home config", () => {
    expect(loadConfig(home, "claude", nullLogger, {}).jobs.reuseIdenticalApprovals).toBe(true);
    writeFileSync(join(home, "config.json"), JSON.stringify({ jobs: { reuseIdenticalApprovals: false } }));
    expect(loadConfig(home, "claude", nullLogger, {}).jobs.reuseIdenticalApprovals).toBe(false);
  });
  it("cannot be switched off by a project config", () => {
    const project = join(home, "project");
    mkdirSync(join(project, ".agent-bridge"), { recursive: true });
    writeFileSync(join(project, ".agent-bridge", "config.json"), JSON.stringify({ jobs: { reuseIdenticalApprovals: false } }));
    expect(loadConfig(home, "claude", nullLogger, {}, project).jobs.reuseIdenticalApprovals).toBe(true);
  });
  it("cannot be switched on by a project config when the home config turned it off", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ jobs: { reuseIdenticalApprovals: false } }));
    const project = join(home, "project");
    mkdirSync(join(project, ".agent-bridge"), { recursive: true });
    writeFileSync(join(project, ".agent-bridge", "config.json"), JSON.stringify({ jobs: { reuseIdenticalApprovals: true } }));
    expect(loadConfig(home, "claude", nullLogger, {}, project).jobs.reuseIdenticalApprovals).toBe(false);
  });
});
