import { expect, it, vi } from "vitest";
import { httpFailureEvidence } from "./http-failure-evidence.js";

it("retains HTTP status and finite admission cause without error bodies", async () => {
  const evidence = await httpFailureEvidence(new Response(JSON.stringify({ error: "metadata lease has a live or unknown owner PRIVATE_TOKEN_BODY" }), { status: 500 }));
  expect(evidence).toEqual({ status: 500, category: "metadata-owner-unavailable" });
  expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE|metadata lease/);
  expect(await httpFailureEvidence(new Response(JSON.stringify({ error: "Broker did not attest the exact native identity PRIVATE_TOKEN" }), { status: 500 })))
    .toEqual({ status: 500, category: "native_attestation_text" });
  expect(await httpFailureEvidence(new Response("ok", { status: 200 }))).toEqual({ status: 200, category: "none" });
});

it("bounds the diagnostic body and wait and cancels only its response reader", async () => {
  const cancelled = vi.fn();
  const oversized = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4097)); }, cancel: cancelled }), { status: 500 });
  expect(await httpFailureEvidence(oversized)).toEqual({ status: 500, category: "oversized_response" });
  expect(cancelled).toHaveBeenCalledOnce();
  const emptyChunks = new Response(new ReadableStream({ start(controller) { for (let n = 0; n < 17; n++) controller.enqueue(new Uint8Array()); }, cancel: cancelled }), { status: 500 });
  expect(await httpFailureEvidence(emptyChunks)).toEqual({ status: 500, category: "oversized_response" });
  expect(cancelled).toHaveBeenCalledTimes(2);
  vi.useFakeTimers();
  try {
    const pending = httpFailureEvidence(new Response(new ReadableStream({ cancel: cancelled }), { status: 503 }));
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({ status: 503, category: "invalid_response" });
    expect(cancelled).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); }
});
