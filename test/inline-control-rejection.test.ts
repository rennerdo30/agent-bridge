import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { JobManager } from "../src/mcp/jobs.js";

// AB-246: a refused inline job control (owner offline, unauthorized) must not become an unhandled rejection.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
beforeEach(() => { unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
afterEach(() => { process.off("unhandledRejection", onUnhandled); });

it("handles a broker refusal of title, effort, settings and follow-up control for another session's job", async () => {
  const calls: string[] = [];
  const node = Object.assign(new EventEmitter(), {
    name: "me", id: "me-id", currentSessionId: "s", deliverLocal: () => {},
    controlInlineJob: (_job: string, control: { type: string }) => { calls.push(control.type); return Promise.reject(new Error("No job master is currently connected.")); },
  });
  const manager = new JobManager(node as never, nullLogger);
  const tracked = manager.track("codex", null, "task");
  try {
    // A running turn executed by another session (e.g. after a handoff) is steered through the broker.
    tracked.job.status = "running"; tracked.job.executionOwner = "executor";
    expect(manager.setTitle(tracked.job.name, "renamed")).toBe(true);
    expect(manager.setEffort(tracked.job.name, "high")).toBe(true);
    expect(manager.setSettings(tracked.job.name, { model: "m" })).toBe(true);
    manager.followUp(tracked.job.name, "hello");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual(["title", "effort", "settings", "message"]);
    expect(unhandled).toEqual([]);
  } finally { tracked.end(); }
});
