import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_SCHEMA } from "../src/core/conversation-schema.js";
import { REHEARSAL_RAW_HASH_SQL, rehearsalRawHash } from "../scripts/release-rehearsal.js";

const source = "synthetic-rehearsal-source";
const payloads = [Buffer.from("First retained raw\n"), Buffer.from([0, 255, 12, 13, 10]), Buffer.from("Last retained raw: λ\n")];
function validRow(index: number): Record<string, SQLInputValue> {
  return { id: index + 1, source, generation: 0, offset: payloads.slice(0, index).reduce((sum, raw) => sum + raw.length, 0), conversation: source, at: 1_700_000_000_000 + index, raw: payloads[index]!, body: `Synthetic retained transcript record ${index}`, part: null };
}
function fixture(rows: Record<string, SQLInputValue>[]): string {
  const root = join(process.cwd(), ".agent-bridge-test", "tmp"); mkdirSync(root, { recursive: true });
  const file = join(mkdtempSync(join(root, "rehearsal-raw-proof-")), "history.db"), db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE messages(id TEXT,recipient TEXT)");
    db.exec(CONVERSATION_SCHEMA);
    const insert = db.prepare("INSERT INTO conversation_records(id,source,generation,offset,conversation,at,raw,body,part) VALUES(?,?,?,?,?,?,?,?,?)");
    for (const row of rows) insert.run(row.id!, row.source!, row.generation!, row.offset!, row.conversation!, row.at!, row.raw!, row.body!, row.part!);
  } finally { db.close(); }
  vi.stubEnv("AGENT_BRIDGE_HISTORY_MIGRATION_IO_BYTES_PER_SECOND", String(1024 * 1024));
  return file;
}
afterEach(() => vi.unstubAllEnvs());

describe("streamed rehearsal raw history integrity", () => {
  it("returns exact row/byte/SHA proof in source generation/offset order with all metadata intact", async () => {
    const file = fixture([validRow(2), validRow(0), { ...validRow(0), id: 99, source: "unrelated-synthetic-source" }, validRow(1)]);
    const expected = Buffer.concat(payloads);
    expect(await rehearsalRawHash(file)).toEqual({ rows: 3, bytes: expected.length, sha256: createHash("sha256").update(expected).digest("hex") });
  });
  it("uses the existing source/generation/offset unique index without a temporary ORDER BY sort", () => {
    const file = fixture([validRow(0), validRow(1)]), db = new DatabaseSync(file, { readOnly: true });
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${REHEARSAL_RAW_HASH_SQL}`).all(source).map(row => String(row.detail));
      expect(plan.some(detail => /SEARCH.*INDEX.*source=\?/i.test(detail))).toBe(true);
      expect(plan.some(detail => /TEMP B-TREE.*ORDER BY/i.test(detail))).toBe(false);
      const previousPlan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM conversation_records WHERE source=? ORDER BY offset").all(source).map(row => String(row.detail));
      expect(previousPlan.some(detail => /TEMP B-TREE.*ORDER BY/i.test(detail))).toBe(true);
    } finally { db.close(); }
  });
  it("rejects an unexpected generation rather than filtering it out of the final proof", async () => {
    const file = fixture([validRow(0), { ...validRow(1), generation: 1, offset: 0 }]);
    await expect(rehearsalRawHash(file)).rejects.toThrow("Seeded history row metadata changed");
  });
  it.each([
    ["sparse ID", { id: 2 }], ["sparse offset", { offset: 1 }],
    ["conversation", { conversation: "corrupted-conversation" }], ["timestamp", { at: 1_700_000_000_001 }],
    ["body", { body: "Corrupted retained metadata" }], ["part", { part: "unexpected-part" }],
  ] as const)("rejects corrupted %s metadata", async (_label, corruption) => {
    const file = fixture([{ ...validRow(0), ...corruption }]);
    await expect(rehearsalRawHash(file)).rejects.toThrow("Seeded history row metadata changed");
  });
});
