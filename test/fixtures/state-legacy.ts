import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bytesDigest } from "../../src/core/state-jobs.js";
import { syntheticSourceIdentity, type SyntheticColdSpec } from "../../src/core/state-import.js";

/** Synthetic 0.30.14/15 shapes from runner-store/job-archive-index/jobs source.
 * No fixture is captured from a home, installed runtime or owner's files.
 */
export const legacyJob = (release: "0.30.14" | "0.30.15", overrides: Record<string, unknown> = {}) => ({
  id: "legacy-job", name: "codex-job-synthetic", agent: "codex", model: null,
  prompt: "accepted prompt\r\nkeep all bytes", startedAt: 1730000000000, status: "running",
  sessionId: "synthetic-native-thread", owner: "synthetic-supervisor-name", supervisor: "synthetic-session",
  workdir: null, worktree: null, executionOwner: "synthetic-executor", executionPid: 12345,
  rootSession: "synthetic-root", queuedMessages: ["steer \u0000 unchanged", "next-turn"],
  forwarded: [{ body: "forwarded context", future: [1, 2] }],
  deliveryHistory: [{ id: "report", body: "report bytes\n", futureEnvelope: { retained: true } }],
  ownershipHistory: [{ from: "old-owner", to: "new-owner", at: 10 }], masters: ["old-owner", "new-owner"],
  args: { access: "read", futurePolicy: true }, metadataVersion: 5,
  unknownFuture: { release, rawOccurrences: ["first", "second"] }, ...overrides,
});

export function captureSynthetic(root: string, label: string, raw: Buffer,
    format: "json" | "jsonl" | "sqlite", generation = "1", sourceId = label): SyntheticColdSpec {
  const dir = join(root, label); mkdirSync(dir);
  const sourcePath = join(dir, `source.${format === "sqlite" ? "db" : format}`);
  const manifestPath = join(dir, "capture.json"), retainedCopyDirectory = join(dir, "retained-copies");
  mkdirSync(retainedCopyDirectory); writeFileSync(sourcePath, raw);
  const manifest = Buffer.from(JSON.stringify({ kind: "synthetic-consistent-cold-copy", sourceId, generation,
    format, snapshotIdentity: syntheticSourceIdentity(sourcePath), digest: bytesDigest(raw), bytes: raw.length,
    consistency: "closed-fixture-writers", provenance: `synthetic:${label}:no-owner-data`, futureManifestField: ["keep"] }));
  writeFileSync(manifestPath, manifest);
  return { sourcePath, manifestPath, retainedCopyDirectory, expectedManifestDigest: bytesDigest(manifest) };
}

export function legacySqliteBytes(root: string, release: "0.30.14" | "0.30.15"): Buffer {
  const path = join(root, `generated-${release}.db`), db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA journal_mode=DELETE;
      CREATE TABLE bridge_metadata(domain TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(domain,key));
      CREATE TABLE job_versions(id TEXT NOT NULL,sha256 TEXT NOT NULL,payload TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(id,sha256));
      CREATE TABLE job_records(id TEXT PRIMARY KEY,sha256 TEXT,name TEXT,status TEXT,started_at INTEGER,finished_at INTEGER,metadata TEXT,history_json TEXT,observed_at INTEGER,live INTEGER,archived INTEGER,active INTEGER);
      CREATE TABLE archive_sources(path TEXT NOT NULL,sha256 TEXT NOT NULL,imported_at INTEGER NOT NULL,PRIMARY KEY(path,sha256));
      CREATE TABLE unknown_future(k TEXT,raw BLOB,large_integer INTEGER);`);
    const running = JSON.stringify(legacyJob(release)), conflict = JSON.stringify(legacyJob(release, { status: "done", result: "full conflict retained" }));
    for (const [domain, key, value] of [
      ["job-state", "legacy-job", running], ["job-state-archive", "legacy-job/old", conflict],
      ["job-spec", "legacy-job", JSON.stringify({ jobId: "legacy-job", startedAt: 1730000000000, prompt: "spec context", consumedAt: 12, future: true })],
      ["job-spec-archive", "legacy-job/old", '{"prompt":"old spec"}'],
      ["job-pending", "receipt", '{"acceptedBytes":"report\\nsteering","unknownReceipt":true}'],
      ["read-journal", "synthetic-session", '{"ids":["consumed-report"],"futureAck":true}'],
      ["unknown-domain", "malformed", '{"never":"drop"'],
    ]) db.prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?)").run(domain!, key!, value!, 12);
    for (const payload of [running, conflict]) db.prepare("INSERT INTO job_versions VALUES (?,?,?,?)").run("legacy-job", bytesDigest(Buffer.from(payload)), payload, 12);
    db.prepare("INSERT INTO job_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("legacy-job", bytesDigest(Buffer.from(running)), "codex-job-synthetic", "running", 1730000000000, null,
      running, JSON.stringify({ ownershipHistory: legacyJob(release).ownershipHistory, futureHistory: true }), 12, 1, 0, 1);
    db.prepare("INSERT INTO archive_sources VALUES (?,?,?)").run("synthetic-jobs.json", bytesDigest(Buffer.from(running)), 12);
    db.prepare("INSERT INTO unknown_future VALUES (?,?,?)").run("keep", Buffer.from([0, 255, 13, 10]), 9223372036854775807n);
  } finally { db.close(); }
  return readFileSync(path);
}
