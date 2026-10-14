import { mkdtempSync, readFileSync, writeFileSync, readdirSync, linkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { bytesDigest, ShadowJobsLedger } from "../src/core/state-jobs.js";
import { SHADOW_IMPORT_SCHEMA, importSyntheticColdSource, productionLegacyImport, verifySyntheticColdSource, type VerifiedSyntheticColdSource } from "../src/core/state-import.js";
import { captureSynthetic, legacyJob, legacySqliteBytes } from "./fixtures/state-legacy.js";
import { seedShadowFixture } from "./fixtures/state-jobs-writer.js";

// Real SQLite + fabricated closed-source fixtures; hosted execution only.
let root: string, db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "state-import-"));
  db = new DatabaseSync(join(root, "retained-shadow.db")); seedShadowFixture(db); db.exec(SHADOW_IMPORT_SCHEMA);
});
afterEach(() => { db.close(); }); // Sources, captures and retained copies kept.
const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

it("refuses production import and forged DTO witnesses without touching any rows", () => {
  expect(productionLegacyImport({ enabled: true, safeSource: true, immutable: true, issuer: "broker" })).toEqual({ status: "authority_unavailable" });
  expect(() => importSyntheticColdSource(db, { kind: "verified-synthetic-cold-source", sourceId: "fake", generation: "1", digest: "f".repeat(64) } as VerifiedSyntheticColdSource))
    .toThrow("unknown_source_witness");
  expect(count("retained_sources")).toBe(0);
});
it.each(["0.30.14", "0.30.15"] as const)("retains the %s registry's accepted/context/report/steering/history/unknown fields", release => {
  const raw = Buffer.from(' \r\n' + JSON.stringify([legacyJob(release)]) + '\n');
  const spec = captureSynthetic(root, release, raw, "json"), sourceBefore = readFileSync(spec.sourcePath), snapshot = new ShadowJobsLedger(db).snapshot();
  const token = verifySyntheticColdSource(spec), first = importSyntheticColdSource(db, token);
  expect(first).toMatchObject({ status: "retained", occurrences: 2 });
  expect(Buffer.from(db.prepare("SELECT raw FROM retained_sources").get()!.raw as Uint8Array)).toEqual(raw);
  expect(readFileSync(spec.sourcePath)).toEqual(sourceBefore); expect(new ShadowJobsLedger(db).snapshot()).toBe(snapshot);
  const job = db.prepare("SELECT * FROM retained_occurrences WHERE job_key='legacy-job'").get()!;
  expect(job).toMatchObject({ legacy_turn_key: "legacy-startedAt:1730000000000", execution_evidence: "unknown" });
  expect(JSON.parse(String(job.projection)).value).toEqual(legacyJob(release));
  expect(importSyntheticColdSource(db, token)).toMatchObject({ status: "already_retained", occurrences: 2 });
  expect(count("retained_sources")).toBe(1); expect(count("shadow_jobs")).toBe(0);
});
it("preserves all differing raw occurrences and conflicts rather than collapsing by job/turn key", () => {
  const records = [legacyJob("0.30.14"), legacyJob("0.30.14", { status: "done", result: "first result" }), legacyJob("0.30.15", { startedAt: 1730000000001, status: "interrupted" })];
  const raw = Buffer.from(records.map(r => JSON.stringify(r)).join("\r\n") + "\r\n");
  const spec = captureSynthetic(root, "conflicts", raw, "jsonl");
  importSyntheticColdSource(db, verifySyntheticColdSource(spec));
  const occurrences = db.prepare("SELECT * FROM retained_occurrences ORDER BY occurrence").all();
  expect(occurrences).toHaveLength(3); expect(count("retained_conflicts")).toBe(3);
  expect(Buffer.concat(occurrences.map(o => Buffer.from(o.raw as Uint8Array)))).toEqual(raw);
  expect(occurrences.every(o => o.execution_evidence === "unknown")).toBe(true);
  expect(count("shadow_jobs")).toBe(0);
});
it("retains changed generations separately and never overwrites the first capture", () => {
  const one = captureSynthetic(root, "capture-one", Buffer.from(JSON.stringify(legacyJob("0.30.14"))), "json", "1", "same-logical-source");
  const two = captureSynthetic(root, "capture-two", Buffer.from(JSON.stringify(legacyJob("0.30.15", { status: "done" }))), "json", "2", "same-logical-source");
  importSyntheticColdSource(db, verifySyntheticColdSource(one)); const first = db.prepare("SELECT * FROM retained_sources").get();
  importSyntheticColdSource(db, verifySyntheticColdSource(two));
  expect(count("retained_sources")).toBe(2); expect(count("retained_conflicts")).toBe(1);
  expect(db.prepare("SELECT * FROM retained_sources WHERE generation='1'").get()).toEqual(first);
  expect(readFileSync(one.sourcePath)).toEqual(Buffer.from(first!.raw as Uint8Array));
});
it("retains changed digest under a conflicting same generation without dropping either payload", () => {
  for (const [label, status] of [["first", "running"], ["conflict", "done"]]) {
    const spec = captureSynthetic(root, label!, Buffer.from(JSON.stringify(legacyJob("0.30.15", { status }))), "json", "1", "same-source");
    importSyntheticColdSource(db, verifySyntheticColdSource(spec));
  }
  expect(count("retained_sources")).toBe(2);
  expect(db.prepare("SELECT count(*) AS n FROM retained_sources WHERE generation_conflict=1").get()!.n).toBe(1);
});
it("retains malformed UTF8, duplicate raw keys, partial JSON and line terminators as unknown", () => {
  const raw = Buffer.concat([Buffer.from('{"id":"a","id":"b"}\r\n{"partial":\n'), Buffer.from([255, 0, 10])]);
  const spec = captureSynthetic(root, "malformed", raw, "jsonl");
  importSyntheticColdSource(db, verifySyntheticColdSource(spec));
  expect(db.prepare("SELECT parse_state FROM retained_sources").get()!.parse_state).toBe("unknown");
  const rows = db.prepare("SELECT * FROM retained_occurrences ORDER BY occurrence").all();
  expect(Buffer.concat(rows.map(r => Buffer.from(r.raw as Uint8Array)))).toEqual(raw);
  expect(rows.every(r => JSON.parse(String(r.projection)).state === "unknown")).toBe(true);
  expect(count("shadow_jobs")).toBe(0);
});
it.each(["0.30.14", "0.30.15"] as const)("retains every SQLite table/column and exact %s DB bytes using only a detached copy", release => {
  const raw = legacySqliteBytes(root, release), spec = captureSynthetic(root, `sqlite-${release}`, raw, "sqlite");
  const files = readdirSync(join(spec.sourcePath, ".."));
  const result = importSyntheticColdSource(db, verifySyntheticColdSource(spec));
  expect(result.status).toBe("retained"); expect(result.occurrences).toBeGreaterThan(15);
  expect(Buffer.from(db.prepare("SELECT raw FROM retained_sources").get()!.raw as Uint8Array)).toEqual(raw);
  expect(readFileSync(spec.sourcePath)).toEqual(raw); expect(readdirSync(join(spec.sourcePath, ".."))).toEqual(files);
  const retained = db.prepare("SELECT * FROM retained_occurrences").all();
  const future = retained.find(r => r.locator === "sqlite:unknown_future:0")!;
  expect(JSON.parse(String(future.projection)).value).toMatchObject({ raw: { sqliteType: "blob", base64: "AP8NCg==" }, large_integer: { sqliteType: "integer", decimal: "9223372036854775807" } });
  for (const name of ["bridge_metadata", "job_versions", "job_records", "archive_sources", "unknown_future"])
    expect(retained.some(r => String(r.locator).startsWith(`sqlite:${name}:`))).toBe(true);
  expect(retained.some(r => String(r.projection).includes("acceptedBytes"))).toBe(true);
  expect(retained.some(r => String(r.projection).includes("futureAck"))).toBe(true);
  expect(count("retained_conflicts")).toBeGreaterThan(0); expect(count("shadow_jobs")).toBe(0);
  const copies = readdirSync(spec.retainedCopyDirectory); expect(copies).toEqual([`${bytesDigest(raw)}.db`]);
  expect(readFileSync(join(spec.retainedCopyDirectory, copies[0]!))).toEqual(raw);
});
it.each(["-wal", "-shm", "-journal"])("refuses hot/unknown %s BEFORE any page SQL or retained copy", suffix => {
  const spec = captureSynthetic(root, "hot", legacySqliteBytes(root, "0.30.15"), "sqlite");
  const original = readFileSync(spec.sourcePath); writeFileSync(spec.sourcePath + suffix, "synthetic-hot-companion");
  expect(() => verifySyntheticColdSource(spec)).toThrow("hot_or_unknown_source");
  expect(readdirSync(spec.retainedCopyDirectory)).toEqual([]); expect(count("retained_sources")).toBe(0);
  expect(readFileSync(spec.sourcePath)).toEqual(original); expect(readFileSync(spec.sourcePath + suffix, "utf8")).toBe("synthetic-hot-companion");
});
it("refuses WAL-header files even when their WAL is absent", () => {
  const raw = legacySqliteBytes(root, "0.30.15"); raw[18] = 2; raw[19] = 2;
  const spec = captureSynthetic(root, "wal-header", raw, "sqlite");
  expect(() => verifySyntheticColdSource(spec)).toThrow("hot_or_unknown_source"); expect(readdirSync(spec.retainedCopyDirectory)).toEqual([]);
});
it("refuses missing, unknown, changed manifest/generation/digest or changed admitted sources", () => {
  const spec = captureSynthetic(root, "changed", Buffer.from("[]"), "json"), token = verifySyntheticColdSource(spec);
  expect(() => verifySyntheticColdSource({ ...spec, sourcePath: join(root, "missing.db") })).toThrow();
  expect(() => verifySyntheticColdSource({ ...spec, expectedManifestDigest: "0".repeat(64) })).toThrow("changed_source_manifest");
  const m = JSON.parse(readFileSync(spec.manifestPath, "utf8")); m.kind = "owner-live-source";
  const unknown = Buffer.from(JSON.stringify(m)); writeFileSync(spec.manifestPath, unknown);
  expect(() => verifySyntheticColdSource({ ...spec, expectedManifestDigest: bytesDigest(unknown) })).toThrow("unknown_source_manifest");
  expect(() => importSyntheticColdSource(db, token)).toThrow("changed_source_manifest"); expect(count("retained_sources")).toBe(0);
});
it("checks an admitted source again and refuses later raw changes without losing changed bytes", () => {
  const spec = captureSynthetic(root, "changed-raw", Buffer.from("[]"), "json"), token = verifySyntheticColdSource(spec);
  writeFileSync(spec.sourcePath, "changed retained original");
  expect(() => importSyntheticColdSource(db, token)).toThrow("changed_source_generation_or_digest");
  expect(readFileSync(spec.sourcePath, "utf8")).toBe("changed retained original"); expect(count("retained_sources")).toBe(0);
});
it.each(["stable", "raw", "manifest", "sidecar"] as const)("revalidates %s replay source after capture during real candidate parsing", change => {
  const raw = Buffer.from(JSON.stringify(legacyJob("0.30.15")));
  const spec = captureSynthetic(root, "replay-window", raw, "json", "1", "replay-source");
  const token = verifySyntheticColdSource(spec), first = importSyntheticColdSource(db, token);
  const prior = captureSynthetic(root, "other-generation", Buffer.from(JSON.stringify(legacyJob("0.30.14", { status: "done" }))), "json", "2", "replay-source");
  importSyntheticColdSource(db, verifySyntheticColdSource(prior));
  const retainedRows = () => ({
    sources: db.prepare("SELECT * FROM retained_sources ORDER BY source_id,generation,digest").all(),
    occurrences: db.prepare("SELECT * FROM retained_occurrences ORDER BY source_id,generation,digest,occurrence").all(),
    conflicts: db.prepare("SELECT * FROM retained_conflicts ORDER BY job_key,left_source,left_generation,left_digest,left_occurrence,right_source,right_generation,right_digest,right_occurrence").all(),
  });
  const before = retainedRows(), priorRaw = readFileSync(prior.sourcePath), manifestRaw = readFileSync(spec.manifestPath);
  const changedRaw = Buffer.from("synthetic source changed during replay parsing");
  let parsedCandidates = 0, changedManifest = manifestRaw;
  const originalParse = JSON.parse;
  // Test-local passthrough, not a mocked importer/guard/result or public seam.
  // safeSource parses the distinct manifest first. Matching original job JSON
  // is parsed only by occurrences(w), AFTER initial capture and before BEGIN.
  // Always return the actual parser result; mutate only fabricated fixture files.
  const parser = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    const result: unknown = originalParse(text, reviver);
    if (text === raw.toString("utf8") && parsedCandidates === 0) {
      parsedCandidates++;
      if (change === "raw") writeFileSync(spec.sourcePath, changedRaw);
      else if (change === "manifest") {
        changedManifest = Buffer.from(JSON.stringify({ ...originalParse(manifestRaw.toString("utf8")), generation: "3" }));
        writeFileSync(spec.manifestPath, changedManifest);
      } else if (change === "sidecar") writeFileSync(spec.sourcePath + "-journal", "synthetic replay sidecar");
    }
    return result;
  });
  try {
    if (change === "stable") expect(importSyntheticColdSource(db, token)).toEqual({ ...first, status: "already_retained" });
    else expect(() => importSyntheticColdSource(db, token)).toThrow(change === "raw"
      ? "changed_source_generation_or_digest" : change === "manifest" ? "changed_source_manifest" : "hot_or_unknown_source");
  } finally { parser.mockRestore(); }
  expect(parsedCandidates).toBe(1); expect(db.isTransaction).toBe(false);
  expect(retainedRows()).toEqual(before); expect(count("retained_sources")).toBe(2);
  expect(Buffer.from(before.sources.find(s => s.generation === "1")!.raw as Uint8Array)).toEqual(raw);
  expect(readFileSync(spec.sourcePath)).toEqual(change === "raw" ? changedRaw : raw);
  expect(readFileSync(spec.manifestPath)).toEqual(changedManifest);
  expect(readFileSync(prior.sourcePath)).toEqual(priorRaw); expect(count("shadow_jobs")).toBe(0);
  if (change === "sidecar") expect(readFileSync(spec.sourcePath + "-journal", "utf8")).toBe("synthetic replay sidecar");
});
it("refuses hard-linked source/copy ambiguity before SQLite opens", () => {
  const spec = captureSynthetic(root, "linked", Buffer.from("[]"), "json"); linkSync(spec.sourcePath, join(root, "source-alias"));
  expect(() => verifySyntheticColdSource(spec)).toThrow("unknown_source_identity"); expect(count("retained_sources")).toBe(0);
});
it("rolls back retained generation/occurrences/conflicts together on a target write fault", () => {
  const raw = Buffer.from(JSON.stringify([legacyJob("0.30.15")])), spec = captureSynthetic(root, "rollback", raw, "json");
  db.exec("CREATE TRIGGER synthetic_fault BEFORE INSERT ON retained_occurrences BEGIN SELECT RAISE(ABORT,'synthetic import fault'); END");
  expect(() => importSyntheticColdSource(db, verifySyntheticColdSource(spec))).toThrow("synthetic import fault");
  for (const table of ["retained_sources", "retained_occurrences", "retained_conflicts"]) expect(count(table)).toBe(0);
  expect(readFileSync(spec.sourcePath)).toEqual(raw);
});
