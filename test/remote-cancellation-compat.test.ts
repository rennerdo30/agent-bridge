import { expect, it, vi } from "vitest";
import { z } from "zod";
import { remoteJobSnapshotSchema, remoteSnapshotForPeer } from "../src/network/remote-job-protocol.js";
import { runRemoteAsk } from "../src/mcp/remote-ask.js";

const legacy = remoteJobSnapshotSchema.extend({ state: remoteJobSnapshotSchema.shape.state.unwrap()
  .extend({ status: z.enum(["running", "done", "failed"]) }).nullable() });
const fixture = { alive: false, approvals: [], state: { pid: 1, peer: "codex-job-fixture", status: "cancelled", updatedAt: 2,
  report: "Subagent codex-job-fixture (codex) cancelled after 1s.\n\nRetained partial context", sessionId: "retained-session" } };

it("projects cancellation for a legacy paired broker without changing retained evidence", () => {
  const before = JSON.stringify(fixture);
  expect(legacy.safeParse(fixture).success).toBe(false);
  const compatible = legacy.parse(remoteSnapshotForPeer(fixture, false));
  expect(compatible.state).toMatchObject({ status: "failed", sessionId: "retained-session" });
  expect(compatible.state?.report).toContain("Cause: cancelled");
  expect(compatible.state?.report).toContain("Retained partial context");
  expect(JSON.stringify(fixture)).toBe(before);
});
it("preserves the distinct cancelled status for capable paired brokers", () => {
  expect(remoteSnapshotForPeer(fixture, true)).toBe(fixture);
  expect(remoteJobSnapshotSchema.parse(remoteSnapshotForPeer(fixture, true)).state?.status).toBe("cancelled");
});
it("returns a cancelled remote ask as an error with retained partial context and session", async () => {
  const node = { remoteJob: vi.fn().mockResolvedValue(fixture) };
  const job = { id: "12345678", controller: new AbortController(), sessionId: null, workdir: null, worktree: null };
  const response = await runRemoteAsk(node as unknown as Parameters<typeof runRemoteAsk>[0], "codex",
    { host: "paired", title: "Cancelled fixture", prompt: "fixture", cwd: "D:/fixture" },
    job as Parameters<typeof runRemoteAsk>[3], new AbortController().signal, () => {});
  expect(response).toMatchObject({ status: "cancelled", isError: true, sessionId: "retained-session", text: fixture.state.report });
  expect(job.sessionId).toBe("retained-session");
  expect(node.remoteJob).toHaveBeenCalledOnce();
});
