import { execFileSync } from "node:child_process";
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
import { approvalIdentity, approvalReuseLimits, treeState } from "../src/mcp/approval-reuse.js";
import { runDelegate, type DelegateArgs, type RunContext } from "../src/mcp/delegate-run.js";
import { tagApprovalOrigin, waitForApproval, type Job } from "../src/mcp/jobs.js";
import { until } from "./helpers.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { closeMetadataDb } from "../src/core/metadata-db.js";

/** AB-402: an approval identical to one the supervisor already granted in the same job is reused, never widened. */
let home: string;
/** The job's working folder: a Git repository, so command grants can be tied to its file state. */
let repo: string;
const gitInit = (dir: string) => execFileSync("git", ["init", "-q"], { cwd: dir, timeout: 30_000, windowsHide: true, stdio: "ignore" });
/** Test commits use an identity from the environment only; no Git configuration is written. */
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, timeout: 30_000, windowsHide: true, env: gitEnv, encoding: "utf8" }).trim();
const commitAll = (dir: string, message: string) => { git(dir, "add", "-A"); git(dir, "commit", "-q", "--no-gpg-sign", "-m", message); };
beforeEach(() => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!;
  mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "reuse-"));
  repo = join(home, "repo");
  mkdirSync(repo);
  gitInit(repo);
});
afterEach(() => { vi.restoreAllMocks(); closeMetadataDb(home); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

type Answer = { allow: boolean; reason: string };
let answerCount = 0;
const approvalId = () => `00000000-0000-4000-8000-${String(++answerCount).padStart(12, "0")}`;
/** Stand-ins for answers of waitForApproval, tagged with the approval they settled and who decided it. */
const allowed = (by = "MCP decide"): Answer & { approvalId: string } => {
  const id = approvalId();
  return tagApprovalOrigin({ allow: true, reason: "allow", approvalId: id }, { approvalId: id, by });
};
const denied = (): Answer => tagApprovalOrigin({ allow: false, reason: "deny: not now" }, { approvalId: approvalId(), by: "MCP decide" });

const context = (answers: Answer[]): RunContext => ({
  agent: "claude", cfg: { ...DEFAULT_CONFIG }, home, log: nullLogger, me: () => "parent", cwd: () => repo,
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

/** One turn of the job in which the subagent asks for each request in order; returns the decisions. */
async function turn(rc: RunContext, j: Job, requests: PermissionRequest[], args: Partial<DelegateArgs> = {}): Promise<boolean[]> {
  const decisions: boolean[] = [];
  vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
    for (const request of requests) decisions.push((await req.approve!(request)).allow);
    return { sessionId: "saved", text: "done", isError: false, details: {} };
  });
  await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "edit", ...args }, j.controller.signal, undefined, true, j);
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
    const result = await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "edit" }, j.controller.signal, undefined, true, j);
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
    await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "edit" }, j.controller.signal, undefined, true, j);
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
    await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "edit" }, j.controller.signal, undefined, true, j);
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
    await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "edit" }, j.controller.signal, undefined, true, j);
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
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "edit" }, j.controller.signal, undefined, true, j);
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
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "edit" }, j.controller.signal, undefined, true, j);
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
    const result = await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "edit" }, j.controller.signal, undefined, false, j);
    expect(rc.askUser).toHaveBeenCalledOnce();
    expect(rc.jobs!.askParent).not.toHaveBeenCalled();
    expect(result.text).toMatch(/allowed \(reused approval [0-9a-f-]{36}\): command npm test/);
  });

  describe("hidden request fields (H1)", () => {
    it("asks again when a Claude Bash request differs only in a field the question does not show", async () => {
      const rc = context(Array.from({ length: 4 }, () => allowed()));
      const j = job();
      const bash = (input: Record<string, unknown>) => hook("claude", "Bash", { command: "npm test", ...input });
      await turn(rc, j, [bash({}), bash({ dangerouslyDisableSandbox: true }), bash({ run_in_background: true }), bash({ timeout: 600_000 }), bash({})]);
      // All five show "npm test"; only the last is the same request as the first.
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(4);
    });

    it("asks again when a Codex hook request differs in its folder or escalation fields", async () => {
      const rc = context(Array.from({ length: 4 }, () => allowed()));
      const j = job();
      const shell = (input: Record<string, unknown>) => hook("codex", "Bash", { command: "npm test", ...input });
      await turn(rc, j, [shell({ workdir: "a" }), shell({ workdir: "b" }), shell({ workdir: "a", sandbox_permissions: "require_escalated", justification: "network" }),
        shell({ workdir: "a", with_escalated_permissions: true }), shell({ workdir: "a" })]);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(4);
    });

    it("asks again when a Codex command runs in another folder, through another shell, or with other approval context (M1)", async () => {
      const other = join(home, "other");
      mkdirSync(other);
      gitInit(other);
      const rc = context(Array.from({ length: 5 }, () => allowed()));
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

    it("drops a command grant once the job's files change, and after any file change request", async () => {
      writeFileSync(join(repo, "deploy.sh"), "echo one\n");
      const rc = context(Array.from({ length: 4 }, () => allowed()));
      const j = job();
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        const ask = async (r: PermissionRequest) => expect((await req.approve!(r)).allow).toBe(true);
        await ask(command("./deploy.sh"));
        await ask(command("./deploy.sh"));
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
        // The job edits the script it was allowed to run: the grant ends.
        writeFileSync(join(repo, "deploy.sh"), "echo two\n");
        await ask(command("./deploy.sh"));
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
        await ask(command("./deploy.sh"));
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
        // A file change request ends command grants even before anything is written.
        await ask(hook("claude", "Edit", { file_path: join(repo, "deploy.sh"), old_string: "two", new_string: "three" }));
        await ask(command("./deploy.sh"));
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(4);
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "edit" }, j.controller.signal, undefined, true, j);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(4);
    });

    /** A grant for ./deploy.sh, reused once, then `change` runs and the same command is asked again or reused. */
    async function afterChange(change: () => void): Promise<number> {
      const rc = context(Array.from({ length: 3 }, () => allowed()));
      const j = job();
      vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
        expect((await req.approve!(command("./deploy.sh"))).allow).toBe(true);
        expect((await req.approve!(command("./deploy.sh"))).allow).toBe(true);
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
        change();
        expect((await req.approve!(command("./deploy.sh"))).allow).toBe(true);
        return { sessionId: "saved", text: "done", isError: false, details: {} };
      });
      await runDelegate(rc, "codex", { title: "reuse", prompt: "task", access: "edit" }, j.controller.signal, undefined, true, j);
      return vi.mocked(rc.jobs!.askParent).mock.calls.length;
    }

    it("asks again when the script is edited and committed, leaving a clean tree (M1: HEAD changed)", async () => {
      writeFileSync(join(repo, "deploy.sh"), "echo one\n");
      commitAll(repo, "one");
      expect(await afterChange(() => {
        writeFileSync(join(repo, "deploy.sh"), "echo two\n");
        commitAll(repo, "two");
        expect(git(repo, "status", "--porcelain")).toBe("");
      })).toBe(2);
    });

    it("asks again after a branch switch (M1: symbolic ref changed)", async () => {
      writeFileSync(join(repo, "deploy.sh"), "echo one\n");
      commitAll(repo, "one");
      expect(await afterChange(() => git(repo, "checkout", "-q", "-b", "other"))).toBe(2);
    });

    it("still reuses while HEAD, the branch and the files stay the same", async () => {
      writeFileSync(join(repo, "deploy.sh"), "echo one\n");
      commitAll(repo, "one");
      expect(await afterChange(() => {})).toBe(1);
    });

    it("keeps no command grant in a repository with submodules", async () => {
      writeFileSync(join(repo, ".gitmodules"), "[submodule \"lib\"]\n\tpath = lib\n\turl = ../lib\n");
      const rc = context([allowed(), allowed()]);
      await turn(rc, job(), [command("npm test"), command("npm test")]);
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
    });

    it("keeps no command grant when a changed file is over the size cap (L1: fail closed)", async () => {
      const cap = approvalReuseLimits.maxFileBytes;
      // A small stand-in for a file over 64 MiB: lower the cap instead of writing a large file.
      approvalReuseLimits.maxFileBytes = 8;
      try {
        writeFileSync(join(repo, "big.bin"), "0123456789abcdef");
        expect(await treeState([repo], nullLogger)).toBeNull();
        const rc = context([allowed(), allowed()]);
        await turn(rc, job(), [command("npm test"), command("npm test")]);
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
      } finally { approvalReuseLimits.maxFileBytes = cap; }
      expect(await treeState([repo], nullLogger)).not.toBeNull();
    });

    it("hashes the same repository once, however its folder is spelled (L1)", async () => {
      writeFileSync(join(repo, "a.txt"), "a\n");
      mkdirSync(join(repo, "sub"));
      const once = await treeState([repo], nullLogger);
      expect(once).not.toBeNull();
      const slashes = repo.replace(/\\/g, "/") + "/";
      const spellings = [repo, slashes, join(repo, "sub"), ...(process.platform === "win32" ? [repo.toUpperCase(), repo.toLowerCase()] : [])];
      expect(await treeState(spellings, nullLogger)).toBe(once);
      // A second repository does count.
      const other = join(home, "other");
      mkdirSync(other);
      gitInit(other);
      expect(await treeState([repo, other], nullLogger)).not.toBe(once);
    });

    it("keeps no command grant for a folder outside a Git repository", async () => {
      const plain = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "plain-"));
      try {
        const rc = context([allowed(), allowed()]);
        rc.cwd = () => plain;
        const j = job();
        const request = { ...command("npm test"), cwd: plain };
        await turn(rc, j, [request, request]);
        expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
      } finally { rmSync(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    });
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
