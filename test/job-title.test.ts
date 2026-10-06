import { describe, expect, it } from "vitest";
import { deriveJobTitle } from "../src/mcp/job-title.js";

describe("derived job titles", () => {
  it("uses the first nonempty line, normalizes whitespace and limits words", () => {
    expect(deriveJobTitle("\r\n # Fix   the gate before players enter the castle\r\nDetails")).toBe("Fix the gate before players enter the");
    expect(deriveJobTitle("- Repair doors\nDetails")).toBe("Repair doors");
  });
  it("bounds long titles and supplies a nonempty fallback", () => {
    expect(deriveJobTitle("x".repeat(200))).toHaveLength(80);
    expect(deriveJobTitle(" \n\t")).toBe("Background task");
  });
});
