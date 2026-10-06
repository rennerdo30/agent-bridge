import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { delegateToCodexAppServer } from "../src/core/codex-appserver.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { answerPendingApproval, listPendingApprovals } from "../src/core/relay.js";
import { changedJobArgs, parseJobSettings } from "../src/mcp/job-settings.js";
import { waitForApproval, type Job } from "../src/mcp/jobs.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { remoteSpawnArgsSchema } from "../src/network/remote-job-protocol.js";
import { until } from "./helpers.js";

const TIMEOUT_SEC = 10;
const APPROVAL_TIMEOUT_MS = 5_000;
const REVIEW_ACTION = { type: "command", command: "npm test", cwd: "/repo", source: "unifiedExec" };
const REVIEW_RATIONALE = "job cannot request sandbox escalations";
const FAKE_APP_SERVER = `
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
let turn = 0;
const send = (value) => console.log(JSON.stringify(value));
const finish = (id, status = "completed") => {
  send({ method: "item/completed", params: { turnId: id, item: { type: "agentMessage", text: "done" } } });
  send({ method: "turn/completed", params: { turn: { id, status } } });
};
createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync("requests.jsonl", line + "\\n");
  const m = JSON.parse(line);
  if (m.id === 100 && m.result) {
    send({ method: "item/completed", params: { turnId: "turn-1", item: { type: "agentMessage", text: JSON.stringify(m.result) } } });
    return send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
  }
  if (m.id === undefined || !m.method) return;
  let result = {};
  if (m.method === "thread/start" || m.method === "thread/resume") result = { thread: { id: "thread" } };
  if (m.method === "turn/start") result = { turn: { id: "turn-" + ++turn } };
  send({ id: m.id, result });
  if (m.method === "turn/interrupt") return finish(m.params.turnId, "interrupted");
  if (m.method !== "turn/start") return;
  const id = "turn-" + turn;
  if (turn === 1 && process.env.AB_TEST_PERMISSION) {
    return send({ id: 100, method: "item/permissions/requestApproval", params: { permissions: { network: { enabled: true } }, reason: "requested test network" } });
  }
  if (turn === 1 && process.env.AB_TEST_REVIEWS) {
    for (const review of JSON.parse(process.env.AB_TEST_REVIEWS)) {
      send({ method: "item/autoApprovalReview/completed", params: { threadId: "thread", turnId: id, ...review } });
    }
  }
  finish(id);
});
`;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ab-auto-review-"));
  mkdirSync(join(home, "codex-home"));
  writeFileSync(join(home, "app-server"), FAKE_APP_SERVER);
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const calls = () => readFileSync(join(home, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const reviews = (status: string, extra = {}) => [{ reviewId: "review", action: REVIEW_ACTION, review: { status, rationale: REVIEW_RATIONALE }, ...extra }];
const request = (events: object[] = []) => ({ bin: process.execPath, cwd: home, prompt: "task", sandbox: "read-only" as const, timeoutSec: TIMEOUT_SEC, log: nullLogger,
  extraEnv: { CODEX_HOME: join(home, "codex-home"), AB_TEST_REVIEWS: JSON.stringify(events) } });

describe("Codex automatic approval review", () => {
  it("loads auto_review by default and validates top-level and per-agent bridge config", () => {
    expect(loadConfig(home, "claude", nullLogger, {}).codexApprovalsReviewer).toBe("auto_review");
    writeFileSync(join(home, "config.json"), JSON.stringify({ codexApprovalsReviewer: "user", claude: { codexApprovalsReviewer: "auto_review" } }));
    expect(loadConfig(home, "codex", nullLogger, {}).codexApprovalsReviewer).toBe("user");
    expect(loadConfig(home, "claude", nullLogger, {}).codexApprovalsReviewer).toBe("auto_review");
    writeFileSync(join(home, "config.json"), JSON.stringify({ codexApprovalsReviewer: "invalid" }));
    expect(loadConfig(home, "codex", nullLogger, {}).codexApprovalsReviewer).toBe("auto_review");
  });

  it.each([false, true])("sets the reviewer on thread and turn with an explicit user override (resume=%s)", async (resume) => {
    for (const reviewer of [undefined, "user"] as const) {
      await delegateToCodexAppServer({ ...request(), sessionId: resume ? "thread" : undefined, approvalsReviewer: reviewer });
      for (const method of [resume ? "thread/resume" : "thread/start", "turn/start"]) {
        expect(calls().filter((call) => call.method === method).at(-1).params).toMatchObject({ approvalsReviewer: reviewer ?? "auto_review", approvalPolicy: "on-request" });
      }
    }
  });

  it.each(["read-only", "workspace-write", "danger-full-access"] as const)("keeps %s sandbox selection", async (sandbox) => {
    await delegateToCodexAppServer({ ...request(), sandbox });
    const thread = calls().find((call) => call.method === "thread/start").params;
    const turn = calls().find((call) => call.method === "turn/start").params;
    expect(thread).toMatchObject({ sandbox, approvalsReviewer: sandbox === "danger-full-access" ? "user" : "auto_review" });
    expect(turn.sandboxPolicy.type).toBe(sandbox === "danger-full-access" ? "dangerFullAccess" : sandbox === "workspace-write" ? "workspaceWrite" : "readOnly");
  });

  it("uses per-job reviewer settings before bridge defaults", async () => {
    const base = request();
    await DELEGATION_TARGETS.codex.run({ ...DEFAULT_CONFIG, codexBin: process.execPath, codexApprovalsReviewer: "user" }, base, { approvals_reviewer: "auto_review" });
    expect(calls().find((call) => call.method === "turn/start").params.approvalsReviewer).toBe("auto_review");
  });

  it.each(["denied", "timedOut", "aborted"])("forwards %s once, waits for dashboard approval, and continues the same thread", async (status) => {
    const controller = new AbortController();
    const job: Job = { id: "review", name: "codex-job-review", owner: "parent", agent: "codex", model: null, prompt: "task", startedAt: Date.now(), controller,
      progress: null, status: "running", sessionId: null, workdir: home, worktree: null, queue: [] };
    const approve = vi.fn(async (r) => {
      const decision = await waitForApproval(job, r.detail, APPROVAL_TIMEOUT_MS, () => {}, nullLogger, home, r);
      return decision.allow ? { allow: true as const } : { allow: false as const, message: decision.reason };
    });
    const events = [...reviews(status), ...reviews(status)];
    const run = delegateToCodexAppServer({ ...request(events), canApprove: true, approve });
    try {
      await until(() => listPendingApprovals(home).length === 1);
      expect(calls().filter((call) => call.method === "turn/start")).toHaveLength(1);
      const entry = listPendingApprovals(home)[0]!;
      expect(entry).toMatchObject({ owner: "parent", job: job.name, agent: "codex", tool: "command" });
      expect(entry.command).toContain(REVIEW_RATIONALE);
      expect(await answerPendingApproval(home, entry.id, { decision: "allow" })).toBe("answered");
      expect(await run).toMatchObject({ sessionId: "thread", text: "done", isError: false });
      expect(approve).toHaveBeenCalledTimes(1);
      expect(approve).toHaveBeenCalledWith(expect.objectContaining({ automaticReview: true }));
      const turns = calls().filter((call) => call.method === "turn/start");
      expect(turns).toHaveLength(2);
      expect(turns[1].params).toMatchObject({ threadId: "thread", approvalsReviewer: "auto_review", sandboxPolicy: { type: "readOnly", networkAccess: false } });
      expect(turns[1].params.input[0].text).toContain("approved one retry");
      expect(turns[1].params.input[0].text).toContain(JSON.stringify(REVIEW_ACTION));
      expect(listPendingApprovals(home)).toEqual([]);
    } finally { controller.abort(); await run.catch(() => {}); }
  });

  it("carries a supervisor denial reason into the continuation", async () => {
    await delegateToCodexAppServer({ ...request(reviews("denied")), canApprove: true, approve: async () => ({ allow: false, message: "Stay in scope" }) });
    expect(calls().filter((call) => call.method === "turn/start")[1].params.input[0].text).toContain("Stay in scope");
    expect(calls().filter((call) => call.method === "turn/start")[1].params.input[0].text).toContain("Do not retry");
  });

  it.each([true, false])("forwards permission-profile requests with turn-only grants (allow=%s)", async (allow) => {
    const base = request();
    const approve = vi.fn(async () => allow ? { allow: true as const } : { allow: false as const, message: "Keep network blocked" });
    const result = await delegateToCodexAppServer({ ...base, extraEnv: { ...base.extraEnv, AB_TEST_PERMISSION: "1" }, canApprove: true, approve });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ tool: "permissions", detail: expect.stringContaining("requested test network") }));
    expect(JSON.parse(result.text)).toEqual({ permissions: allow ? { network: { enabled: true } } : {}, scope: "turn" });
  });

  it("reports a forwarding failure as a denial in continuation context", async () => {
    await delegateToCodexAppServer({ ...request(reviews("denied")), canApprove: true, approve: async () => { throw new Error("supervisor disconnected"); } });
    expect(calls().filter((call) => call.method === "turn/start")[1].params.input[0].text).toContain("supervisor disconnected");
  });

  it("reports unavailable supervision without hanging or granting a retry", async () => {
    const onDenied = vi.fn(), approve = vi.fn();
    await delegateToCodexAppServer({ ...request(reviews("denied")), canApprove: false, approve, onDenied });
    expect(approve).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledWith(expect.stringContaining(REVIEW_RATIONALE));
    expect(calls().filter((call) => call.method === "turn/start")).toHaveLength(1);
  });

  it("ignores approved, stale, and nonterminal review notifications", async () => {
    const approve = vi.fn();
    await delegateToCodexAppServer({ ...request([...reviews("approved"), ...reviews("inProgress", { reviewId: "pending" }), ...reviews("denied", { reviewId: "stale", turnId: "old-turn" })]), canApprove: true, approve });
    expect(approve).not.toHaveBeenCalled();
  });

  it("keeps reviewer overrides through access changes and rejects invalid or wrong-agent settings", () => {
    expect(changedJobArgs({ sandbox: "read-only", approvals_reviewer: "user" }, { access: "edit" })).toEqual({ access: "edit", approvals_reviewer: "user" });
    expect(changedJobArgs({ access: "edit" }, { approvals_reviewer: "user" })).toEqual({ access: "edit", approvals_reviewer: "user" });
    expect(parseJobSettings({ approvals_reviewer: "auto_review" }, "codex")).toEqual({ approvals_reviewer: "auto_review" });
    expect(parseJobSettings({ approvals_reviewer: "invalid" }, "codex")).toBe("invalid approvals_reviewer");
    expect(parseJobSettings({ approvals_reviewer: "user" }, "claude")).toBe("approvals_reviewer applies only to codex jobs.");
    expect(remoteSpawnArgsSchema.parse({ prompt: "task", title: "Review", cwd: home, approvals_reviewer: "user" }).approvals_reviewer).toBe("user");
  });
});
