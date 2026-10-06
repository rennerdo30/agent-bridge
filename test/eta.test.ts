import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ParentLink, parentFromEnv } from "../src/core/parent-link.js";
import { nullLogger } from "../src/core/logger.js";
import { startRunFeed, runMetaPath } from "../src/core/runfeed.js";
import { readDashboard, summarizeRun } from "../src/core/dashboard-read.js";
import { markRemoteDashboard } from "../src/network/dashboard-projection.js";
import { remoteJobSnapshotSchema } from "../src/network/remote-job-protocol.js";

describe("completion estimates", () => {
  it("timestamps ETA at receipt and accepts legacy reports and both bounds", async () => {
    const reports: { etaAt: number; etaReportedAt: number }[] = [];
    const link = new ParentLink("parent", () => {}, nullLogger, (_percent, _note, eta) => { if (eta) reports.push(eta); });
    await link.start();
    try {
      const child = parentFromEnv(link.childEnv())!;
      const before = Date.now();
      await child.progress(40, "tests", 12);
      expect(reports[0]!.etaReportedAt).toBeGreaterThanOrEqual(before);
      expect(reports[0]!.etaReportedAt).toBeLessThanOrEqual(Date.now());
      expect(reports[0]!.etaAt - reports[0]!.etaReportedAt).toBe(12 * 60_000);
      await child.progress(45, "legacy");
      expect(reports).toHaveLength(1);
      for (const minutes of [0, 1440, 0.5]) {
        await child.progress(50, "updated", minutes);
        expect(reports.at(-1)!.etaAt - reports.at(-1)!.etaReportedAt).toBe(minutes * 60_000);
      }
      for (const minutes of [-1, 1441, NaN, Infinity]) await expect(child.progress(50, "", minutes)).rejects.toThrow(/eta_minutes/);
    } finally { await link.close(); }
  });

  it("exposes estimates in state and remote projections then clears completed metadata", async () => {
    const home = mkdtempSync(join(tmpdir(), "eta-"));
    const eta = { etaAt: Date.now() + 720_000, etaReportedAt: Date.now() };
    const feed = startRunFeed({ home, name: "codex-12345678", header: "codex by parent", meta: { job: "codex-job-12345678", percent: 40, ...eta } });
    try {
      const state = await readDashboard({ home, log: nullLogger, peers: () => [] }, { path: "/api/state" });
      expect(state.body).toMatchObject({ runs: [expect.objectContaining(eta)] });
      expect(markRemoteDashboard(state.body, "desktop")).toMatchObject({ runs: [expect.objectContaining({ ...eta, job: "desktop/codex-job-12345678" })] });
      feed.meta({ percent: 50 });
      expect(JSON.parse(readFileSync(runMetaPath(feed.logPath), "utf8"))).toMatchObject(eta);
      feed.end("done");
      const saved = JSON.parse(readFileSync(runMetaPath(feed.logPath), "utf8"));
      expect(saved).not.toHaveProperty("etaAt");
      expect(saved).not.toHaveProperty("etaReportedAt");
      const final = await readDashboard({ home, log: nullLogger, peers: () => [] }, { path: "/api/state" });
      expect(JSON.stringify(final.body)).not.toContain('"etaAt"');
      // Finished legacy runs with stale ETA are masked without mutating their stored data.
      const old = summarizeRun("2026-10-06-12-00-00-codex-test.log", "12:00:00 finished after 1s · done", Date.now(), Date.now(), eta);
      expect(old.etaAt).toBeUndefined();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("accepts old remote snapshots and preserves optional ETA fields", () => {
    const state = { pid: 1, peer: "runner", status: "running", updatedAt: 1, percent: 40 };
    expect(remoteJobSnapshotSchema.parse({ state, alive: true, approvals: [] }).state).toEqual(state);
    const eta = { etaAt: 720_001, etaReportedAt: 1 };
    expect(remoteJobSnapshotSchema.parse({ state: { ...state, ...eta }, alive: true, approvals: [] }).state).toMatchObject(eta);
  });
});
