import { describe, expect, it } from "vitest";
import { IdleBackoff } from "../src/core/idle-backoff.js";

describe("idle maintenance scheduling", () => {
  it("uses bounded fallback discovery after draining work and wakes promptly", () => {
    const backoff = new IdleBackoff();
    expect(Array.from({ length: 7 }, () => backoff.next(false))).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(backoff.wake()).toBe(100);
    expect(backoff.next(false)).toBe(2000);
    expect(backoff.next(true)).toBe(100);
    expect(backoff.next(false)).toBe(2000);
  });
});
