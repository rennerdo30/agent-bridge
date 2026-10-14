import { expect, it, vi } from "vitest";
import { retryRequest } from "../src/core/request-retry.js";

it("backs off bounded transient authority failures then returns the current authority", async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn().mockRejectedValueOnce(new Error("broker request timed out: jobAuthority"))
      .mockRejectedValueOnce(new Error("database is locked")).mockResolvedValue({ owner: "current" });
    const result = retryRequest("jobAuthority", request);
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ owner: "current" });
    expect(request).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); }
});

it("exhausts authority retries with a clear retry-later result", async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn().mockRejectedValue(new Error("broker request timed out: jobAuthority"));
    const result = retryRequest("jobAuthority", request).catch(error => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ details: { retryLater: true, attempts: 3 } });
    expect(String(await result)).toContain("retry later");
    expect(request).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); }
});

it("never retries permission or protocol errors", async () => {
  const request = vi.fn().mockRejectedValue(new Error("unauthorized"));
  await expect(retryRequest("jobAuthority", request)).rejects.toThrow("unauthorized");
  expect(request).toHaveBeenCalledTimes(1);
});
