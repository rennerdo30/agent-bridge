import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { answerPendingApproval, listPendingApprovals, type PermissionRequest } from "../src/core/relay.js";
import { approvalIdentity } from "../src/mcp/approval-reuse.js";
import { runDelegate, type DelegateArgs, type RunContext } from "../src/mcp/delegate-run.js";
import { tagApprovalOrigin, waitForApproval, type Job } from "../src/mcp/jobs.js";
import { until } from "./helpers.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { closeMetadataDb } from "../src/core/metadata-db.js";

/** AB-402: an approval identical to one the supervisor already granted in the same job is reused, never widened. */
let home: string;
beforeEach(() => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!;
  mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "reuse-"));
});
afterEach(() => { vi.restoreAllMocks(); closeMetadataDb(home); rmSync(home, { recursive: true, force: true }); });

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
  agent: "claude", cfg: { ...DEFAULT_CONFIG }, home, log: nullLogger, me: () => "parent", cwd: () => home,
  jobs: { askParent: vi.fn(async () => answers.shift() ?? denied()), fromSubagent: vi.fn(), note: vi.fn() },
});
const job = (id = "test"): Job => ({ id, name: `codex-job-${id}`, agent: "codex", model: null, prompt: "task", startedAt: Date.now(), controller: new AbortController(), progress: null, status: "running", sessionId: null, workdir: null, worktree: null, queue: [] });
const command = (detail: string): PermissionRequest => ({ agent: "codex", tool: "command", detail, cwd: "E:/work" });

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
    expect(await turn(rc, j, [command("npm test"), command("npm test")])).toEqual([true, true]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
    const notes = vi.mocked(rc.jobs!.fromSubagent).mock.calls.filter(([, body]) => body.includes("reused"));
    expect(notes).toHaveLength(1);
    // A quiet note (forceNote) naming the original approval id.
    expect(notes[0]![1]).toContain(first.approvalId);
    expect(notes[0]![4]).toBe(true);
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

  it("reuses a grant in a continuation of the same job with the same access", async () => {
    const rc = context([allowed()]);
    const j = job();
    expect(await turn(rc, j, [command("npm test")])).toEqual([true]);
    expect(await turn(rc, j, [command("npm test")])).toEqual([true]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
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

  it("asks again after the job's access changes", async () => {
    const rc = context([allowed(), allowed(), allowed()]);
    const j = job();
    await turn(rc, j, [command("npm test")], { access: "edit" });
    await turn(rc, j, [command("npm test")], { access: "read" });
    // Changing back does not revive the earlier grant either.
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

  it("asks again after the job's supervisor changes", async () => {
    const rc = context([allowed(), allowed()]);
    const j = job();
    j.owner = "parent";
    await turn(rc, j, [command("npm test")]);
    j.supervisor = "other-main";
    await turn(rc, j, [command("npm test")]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
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
    const rc = context([allowed(), allowed(), allowed(), allowed()]);
    const j = job();
    const review: PermissionRequest = { ...command("npm publish"), automaticReview: true };
    const summary: PermissionRequest = { ...command("file changes"), tool: "edit", inexact: true };
    await turn(rc, j, [review, review, summary, summary]);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(4);
  });
});

describe("approvalIdentity", () => {
  it("is exact on agent, tool, folder and the request text", () => {
    expect(approvalIdentity(command("npm test"))).toBe(approvalIdentity(command("npm test\r\n")));
    expect(approvalIdentity(command("npm test"))).not.toBe(approvalIdentity(command("npm  test")));
    expect(approvalIdentity(command("npm test"))).not.toBe(approvalIdentity({ ...command("npm test"), agent: "claude" }));
    expect(approvalIdentity({ ...command("npm test"), reason: "a" })).toBe(approvalIdentity({ ...command("npm test"), reason: "b" }));
  });
  it("has none for reviewer refusals, summaries, cut text, empty text and sandbox permission requests", () => {
    expect(approvalIdentity({ ...command("x"), automaticReview: true })).toBeNull();
    expect(approvalIdentity({ ...command("x"), inexact: true })).toBeNull();
    expect(approvalIdentity({ ...command("x"), detailLength: 99_999 })).toBeNull();
    expect(approvalIdentity(command("  "))).toBeNull();
    expect(approvalIdentity({ ...command("{}"), tool: "permissions" })).toBeNull();
  });
});

describe("jobs.reuseIdenticalApprovals config", () => {
  it("is on by default and can be switched off in the home config", () => {
    expect(loadConfig(home, "claude", nullLogger, {}).jobs.reuseIdenticalApprovals).toBe(true);
    writeFileSync(join(home, "config.json"), JSON.stringify({ jobs: { reuseIdenticalApprovals: false } }));
    expect(loadConfig(home, "claude", nullLogger, {}).jobs.reuseIdenticalApprovals).toBe(false);
  });
  it("cannot be changed by a project config", () => {
    const project = join(home, "project");
    mkdirSync(join(project, ".agent-bridge"), { recursive: true });
    writeFileSync(join(project, ".agent-bridge", "config.json"), JSON.stringify({ jobs: { reuseIdenticalApprovals: false } }));
    expect(loadConfig(home, "claude", nullLogger, {}, project).jobs.reuseIdenticalApprovals).toBe(true);
  });
});
