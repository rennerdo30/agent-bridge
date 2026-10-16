import { expect, it, vi } from "vitest";
import { deliverFinalResult, readStoredFinalResult, resultDeliveryLabel, type StoredFinalResult } from "../src/mcp/final-result.js";
import { writeRunnerState } from "../src/mcp/job-host.js";
import { makeEnv } from "./helpers.js";

const report = "Subagent codex-job-12345678 done after 1s.\n\nFinal review";
const initial = (): StoredFinalResult => ({ report, reportId: "turn-one", delivered: false });

it("stores before a failed send, then retries with the same identity", async () => {
  let saved: StoredFinalResult | null = null;
  const persist = vi.fn((state: StoredFinalResult) => { saved = { ...state }; });
  const send = vi.fn().mockRejectedValueOnce(new Error("broker restarted")).mockResolvedValue({ stored: true });
  await deliverFinalResult(initial(), persist, send, async () => {});
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]).toEqual([report, "turn-one"]);
  expect(send.mock.calls[1]).toEqual([report, "turn-one"]);
  expect(persist.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
  expect(saved).toMatchObject({ delivered: true });
});

it("does not send while durable storage rejects the result", async () => {
  const persist = vi.fn().mockImplementationOnce(() => { throw new Error("database busy"); }).mockImplementation(() => {});
  const send = vi.fn().mockResolvedValue({ stored: true });
  await deliverFinalResult(initial(), persist, send, async () => {});
  expect(persist).toHaveBeenCalledTimes(3);
  expect(persist.mock.invocationCallOrder[1]).toBeLessThan(send.mock.invocationCallOrder[0]!);
});

it("resumes an undelivered stored result after the sender restarts", async () => {
  let saved = initial();
  const controller = new AbortController();
  const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ stored: true });
  await deliverFinalResult(saved, (state) => { saved = { ...state }; }, send, async () => controller.abort(), controller.signal);
  expect(saved).toMatchObject({ report, reportId: "turn-one", delivered: false });
  expect(resultDeliveryLabel(saved, false)).toBe("result stored, not delivered");
  await deliverFinalResult(saved, (state) => { saved = { ...state }; }, send, async () => {});
  expect(send).toHaveBeenCalledTimes(2);
  expect(saved.delivered).toBe(true);
});

it("allows the parent to fetch the stored report after delivery fails", async () => {
  const env = makeEnv();
  try {
    const controller = new AbortController();
    await deliverFinalResult(initial(), (state) => writeRunnerState(env.home, "12345678", {
      pid: process.pid, peer: "codex-job-12345678", status: "done", updatedAt: Date.now(), ...state,
    }), async () => { throw new Error("offline"); }, async () => controller.abort(), controller.signal);
    const fetched = readStoredFinalResult(env.home, "12345678");
    expect(fetched?.report).toBe(report);
    expect(resultDeliveryLabel(fetched, false)).toBe("result stored, not delivered");
  } finally { await env.cleanup(); }
});

it("does not send again after a durable receipt", async () => {
  const send = vi.fn();
  await deliverFinalResult({ ...initial(), delivered: true }, () => {}, send, async () => {});
  expect(send).not.toHaveBeenCalled();
  const persist = vi.fn();
  const receipt = vi.fn().mockResolvedValue(true);
  await deliverFinalResult(initial(), persist, send, async () => {}, undefined, receipt);
  expect(receipt).toHaveBeenCalledWith("turn-one");
  expect(send).not.toHaveBeenCalled();
  expect(persist).toHaveBeenLastCalledWith({ ...initial(), delivered: true });
  expect(resultDeliveryLabel(initial(), true)).toBe("delivered");
});
