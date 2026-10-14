import { describe, expect, it } from "vitest";
import { z } from "zod";
import { historyFiltersSchema, historySearchSchema } from "../src/core/history-query.js";

// AB-336: agents only see published tool metadata, so every filter must carry a description
// and the descriptions must not change validation.
describe("search_history filter schema", () => {
  const published = z.toJSONSchema(historyFiltersSchema, { io: "input" }) as { properties: Record<string, { description?: string }> };

  it("publishes a description for every filter field", () => {
    for (const field of ["project", "session", "job", "agent", "kind", "since", "until"]) {
      expect(published.properties[field]?.description, field).toBeTruthy();
    }
  });

  it("describes report hits as reports or snapshots, not as final results", () => {
    const kind = published.properties.kind?.description ?? "";
    expect(kind).toContain("report:");
    expect(kind).toMatch(/still-running/);
    expect(kind).not.toMatch(/final job reports/);
  });

  it("keeps validation unchanged", () => {
    expect(historySearchSchema.safeParse({ query: "branch limit", filters: { kind: "decision" } }).success).toBe(true);
    expect(historySearchSchema.safeParse({ query: "x", filters: { kind: "nope" } }).success).toBe(false);
    expect(historySearchSchema.safeParse({ query: "x", filters: { since: "2026-10-14T00:00:00+09:00" } }).success).toBe(true);
    expect(historySearchSchema.safeParse({ query: "x", filters: { since: 2, until: 1 } }).success).toBe(false);
    expect(historySearchSchema.safeParse({ query: "x", filters: { unknown: 1 } }).success).toBe(false);
  });
});
