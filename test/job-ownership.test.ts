import { expect, it } from "vitest";
import { canControlJob, chooseJobRecipient, mastersFor } from "../src/core/job-ownership.js";
import type { PeerInfo } from "../src/core/protocol.js";
const peer = (name: string, patch = {}) => ({ name, startedAt: 1, ...patch }) as PeerInfo;
const job = { owner: "primary", rootName: "primary", masters: ["first", "second", "primary"], ownershipHistory: [
  { from: "first", to: "second" }, { from: "second", to: "primary" },
] };
it("chooses the available primary and keeps historical masters' control rights", () => {
  expect(chooseJobRecipient(job, [peer("first"), peer("second"), peer("primary")])).toBe("primary");
  expect(mastersFor(job).sort()).toEqual(["first", "primary", "second"]);
  expect(canControlJob(job, "first")).toBe(true);
});
it("falls back to previous primaries newest first, then the deterministic project masters", () => {
  expect(chooseJobRecipient(job, [peer("first"), peer("second"), peer("primary", { unavailable: true })])).toBe("second");
  expect(chooseJobRecipient(job, [peer("first")])).toBe("first");
  const group = [peer("later", { startedAt: 3 }), peer("earlier", { startedAt: 2 })];
  expect(chooseJobRecipient(job, group, group)).toBe("earlier");
  expect(canControlJob(job, "later", group)).toBe(true);
  expect(job.owner).toBe("primary");
});
it("keeps paired PCs and nested workers outside fallback even with matching names", () => {
  expect(chooseJobRecipient(job, [peer("first", { host: "remote" }), peer("second", { subagent: true })])).toBe("primary");
  expect(canControlJob(job, "pc/first")).toBe(false);
});
it("never routes a changed legacy direct owner to its stale rootName", () => {
  const legacy = { owner: "new", rootName: "old" };
  expect(chooseJobRecipient(legacy, [peer("new"), peer("old")])).toBe("new");
  expect(mastersFor(legacy)).toEqual(["new"]);
});
