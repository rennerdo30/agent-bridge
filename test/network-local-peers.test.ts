import { expect, it } from "vitest";
import { NetworkService } from "../src/network/link.js";

// AB-242: one invalid local registration must not make the whole local peer list unusable for paired PCs.
const peer = (name: string, extra: Record<string, unknown> = {}) => ({ id: `id-${name}`, name, agent: "codex", cwd: "/w", pid: 1, agentPid: null, sessionId: null, startedAt: 1, autoWake: false, ...extra });
const localPeers = (peers: unknown[]) => NetworkService.prototype.localPeers.call({ broker: { peers: () => peers }, log: { warn() {} } } as never);

it("drops invalid, duplicate and excess local peers instead of failing the whole list", () => {
  const list = [peer("good"), peer("long", { jobTitle: "x".repeat(10_000) }), peer("hops", { wakeMaxHops: 1_000 }), peer("good", { id: "id-dupe" }), ...Array.from({ length: 300 }, (_, i) => peer(`many-${i}`))];
  const out = localPeers(list);
  expect(out[0]?.name).toBe("good");
  expect(out.some((p) => p.name === "long" || p.name === "hops")).toBe(false);
  expect(out.filter((p) => p.name === "good")).toHaveLength(1);
  expect(out.length).toBe(256);
});
