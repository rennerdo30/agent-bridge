import { expect, it, vi } from "vitest";
import { HISTORY_BATCH_RESERVE_BYTES as reserve, HistoryBudgetAdmission, type HistoryBudget } from "../src/core/history-budget.js";

const sample = (budgetBytes: number, bytes = 0): HistoryBudget => ({ bytes, budgetBytes, files: 1,
  paused: budgetBytes > 0 && bytes + reserve >= budgetBytes, policy: "retain-and-pause" });

it("keeps live admission independent of a slow full walk while charged headroom remains", async () => {
  const quota = 4 * reserve, scan = vi.fn().mockResolvedValueOnce(sample(quota)).mockImplementation(() => new Promise(() => {}));
  const meter = new HistoryBudgetAdmission(scan);
  expect(await meter.admit(quota)).toBe(true); meter.complete();
  void meter.refresh();
  expect(await meter.admit(quota)).toBe(true); meter.complete();
  expect(scan).toHaveBeenCalledTimes(2);
});

it("blocks at exhausted reserved headroom and joins the pending full refresh", async () => {
  const quota = 2 * reserve + 1;
  let finish!: (value: HistoryBudget) => void;
  const scan = vi.fn().mockResolvedValueOnce(sample(quota)).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const meter = new HistoryBudgetAdmission(scan);
  expect(await meter.admit(quota)).toBe(true); meter.complete(); expect(await meter.admit(quota)).toBe(true); meter.complete();
  const refresh = meter.refresh(); let settled = false;
  const admission = meter.admit(quota).then(result => { settled = true; return result; });
  await Promise.resolve(); expect(settled).toBe(false); expect(scan).toHaveBeenCalledTimes(2);
  finish(sample(quota, quota - reserve)); await refresh;
  expect(await admission).toBe(false);
});

it("a full refresh resets prior debits but retains every debit made since the scan started", async () => {
  const quota = 2 * reserve + 1;
  let finish!: (value: HistoryBudget) => void;
  const scan = vi.fn().mockResolvedValueOnce(sample(quota)).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(sample(quota, quota));
  const meter = new HistoryBudgetAdmission(scan);
  expect(await meter.admit(quota)).toBe(true); meter.complete();
  const refresh = meter.refresh(); await Promise.resolve();
  expect(await meter.admit(quota)).toBe(true); meter.complete(); // A debit during the scan.
  finish(sample(quota)); await refresh;
  expect(await meter.admit(quota)).toBe(true); meter.complete(); // Pre-scan debit reset, in-flight debit retained.
  expect(await meter.admit(quota)).toBe(false); // Both post-scan reserves exhausted.
  expect(scan).toHaveBeenCalledTimes(3);
});

it("requires a full sample initially, on quota changes, and after a failed refresh", async () => {
  const quota = 4 * reserve, scan = vi.fn().mockResolvedValue(sample(quota));
  const meter = new HistoryBudgetAdmission(scan);
  expect(await meter.admit(quota)).toBe(true); meter.complete();
  scan.mockRejectedValueOnce(new Error("SIMULATED unreadable storage"));
  await expect(meter.refresh()).rejects.toThrow("unreadable storage");
  scan.mockResolvedValue(sample(quota, quota));
  expect(await meter.admit(quota)).toBe(false);
  scan.mockResolvedValue(sample(quota * 2));
  expect(await meter.admit(quota * 2)).toBe(true);
  expect(scan).toHaveBeenCalledTimes(4);
});

it("also retains the reservation of a tick already active when a full scan starts", async () => {
  const quota = 2 * reserve;
  const scan = vi.fn().mockResolvedValueOnce(sample(quota)).mockResolvedValueOnce(sample(quota)).mockResolvedValue(sample(quota, quota));
  const meter = new HistoryBudgetAdmission(scan);
  expect(await meter.admit(quota)).toBe(true); // Keep this tick active across the scan.
  await meter.refresh(); meter.complete();
  expect(await meter.admit(quota)).toBe(false); // The in-flight reservation was not forgiven.
  expect(scan).toHaveBeenCalledTimes(3);
});
