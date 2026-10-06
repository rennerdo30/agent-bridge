import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { ParentLink, parentFromEnv } from "../src/core/parent-link.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { JobManager, type RunResult } from "../src/mcp/jobs.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

describe("parent link", () => {
  it("uses the task report to answer consumed instructions while retaining unseen instructions", async () => {
    const link = new ParentLink("parent", () => {}, nullLogger);
    await link.start();
    link.post("Use the new scope");
    await parentFromEnv(link.childEnv())!.inbox();
    link.post("Arrived after the report");
    link.reportCompleted();
    expect(await link.close()).toEqual(["Arrived after the report"]);
  });
  it("delivers the parent's messages once and carries the subagent's answers back", async () => {
    const answers: [string, string | null][] = [];
    const link = new ParentLink("claude-app", (body, replyTo) => answers.push([body, replyTo]), nullLogger);
    await link.start();
    try {
      const child = parentFromEnv(link.childEnv())!;
      expect(child.name).toBe("claude-app");
      expect(await child.inbox()).toEqual([]);
      const m = link.post("How far are you?");
      expect(await child.inbox()).toEqual([m]);
      expect(await child.inbox()).toEqual([]);
      await child.send("About 60%: tests are next.", m.id);
      expect(answers).toEqual([["About 60%: tests are next.", m.id]]);
      expect(await parentFromEnv({ ...link.childEnv(), AGENT_BRIDGE_PARENT_TOKEN: "wrong" })!.inbox().catch((e: Error) => e.message)).toBe("unauthorized");
    } finally {
      expect(await link.close()).toEqual([]);
    }
  });

  it("carries the subagent's progress reports to the parent", async () => {
    const reports: [number, string][] = [];
    const link = new ParentLink("p", () => {}, nullLogger, (percent, note) => reports.push([percent, note]));
    await link.start();
    const child = parentFromEnv(link.childEnv())!;
    await child.progress(40, "gate frame done");
    expect(reports).toEqual([[40, "gate frame done"]]);
    await expect(child.progress(140, "")).rejects.toThrow(/0-100/);
    await link.close();
  });

  it("hands back messages picked up but never answered", async () => {
    const link = new ParentLink("p", () => {}, nullLogger);
    await link.start();
    const child = parentFromEnv(link.childEnv())!;
    link.post("seen at the very end");
    await child.inbox();
    expect(await link.close()).toEqual(["seen at the very end"]);
  });

  it("hands back messages the subagent never picked up", async () => {
    const link = new ParentLink("p", () => {}, nullLogger);
    await link.start();
    link.post("too late");
    expect(await link.close()).toEqual(["too late"]);
  });

  it("injects parent messages through the subagent's hooks, and holds its Stop until it answered", async () => {
    const link = new ParentLink("codex-app", () => {}, nullLogger);
    await link.start();
    try {
      const ctx = { node: null, log: nullLogger, parent: parentFromEnv(link.childEnv()) } as unknown as ServerContext;
      const hook = (event: "PostToolUse" | "Stop") => buildHookResponse(ctx, { event, sessionId: null, stopHookActive: false });
      expect(await hook("PostToolUse")).toEqual({});
      link.post("Stop after the tests and report.");
      const out = (await hook("PostToolUse")) as { hookSpecificOutput: { additionalContext: string } };
      expect(out.hookSpecificOutput.additionalContext).toContain("Stop after the tests and report.");
      expect(out.hookSpecificOutput.additionalContext).toContain('from="codex-app"');
      link.post("Also: which file?");
      expect(await hook("Stop")).toMatchObject({ decision: "block" });
    } finally {
      await link.close();
    }
  });
});

describe("messages to a running subagent", () => {
  let env: TestEnv;
  let me: BridgeNode;
  let jobs: JobManager;
  beforeEach(async () => {
    env = makeEnv();
    me = env.node("claude-l", "claude");
    await me.start();
    jobs = new JobManager(me, nullLogger);
  });
  afterEach(async () => {
    jobs.cancelAll();
    await env.cleanup();
  });

  it("are delivered live and its answer comes back as a message from the job", async () => {
    let release!: (r: RunResult) => void;
    const posted: string[] = [];
    const job = jobs.start("codex", null, "long task", (_s, _p, j) => {
      j.live = { post: (m) => posted.push(m) };
      return new Promise((r) => (release = r));
    });
    await until(() => Boolean(job.live));
    expect(jobs.followUp(job.name, "how far are you?").outcome).toBe("delivered");
    expect(posted).toEqual(["how far are you?"]);
    jobs.fromSubagent(job, "about half", null);
    await until(() => me.unread().some((m) => m.from.name === job.name && m.body === "about half"));
    release({ sessionId: "s", text: "done", isError: false, details: {} });
  });
});
