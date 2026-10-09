import { expect, it } from "vitest";
import { IdleBackoff } from "../src/core/idle-backoff.js";
it("backs off idle scans to a bounded discovery interval and resets on work or events", () => {
  const idle = new IdleBackoff();
  expect(Array.from({ length: 6 }, () => idle.next(0, false))).toEqual([4000,8000,16000,30000,30000,30000]);
  expect(idle.next(1, false)).toBe(2000);
  expect(idle.next(0, true)).toBe(2000);
  idle.next(0, false); idle.reset(); expect(idle.next(0, false)).toBe(4000);
});
