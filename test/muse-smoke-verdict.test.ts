import { describe, expect, it } from "vitest";
import { smokeResumeSucceeded } from "../src/cli/smoke.js";
const result = (sessionId: string | null, isError = false) => ({ sessionId, isError, text: "AGENT_BRIDGE_OK", details: {} });
describe("Muse smoke outcome gate", () => {
  it("requires two successful outcomes in the same native session", () => {
    expect(smokeResumeSucceeded(result("first"), result("first"))).toBe(true);
    expect(smokeResumeSucceeded(result("first", true), result("first"))).toBe(false);
    expect(smokeResumeSucceeded(result("first"), result("first", true))).toBe(false);
    expect(smokeResumeSucceeded(result("first"), result("different"))).toBe(false);
    expect(smokeResumeSucceeded(result(null), result(null))).toBe(false);
    expect(smokeResumeSucceeded(result("first"), null)).toBe(false);
  });
});
