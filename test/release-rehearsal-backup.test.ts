import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageBackupIfDue, type MessageBackupManifest } from "../src/core/message-backups.js";
import { verifyRehearsalMessageBackup } from "../scripts/release-rehearsal.js";

afterEach(() => vi.unstubAllEnvs());

async function backup(body = "Synthetic retained message") {
  const root = join(process.cwd(), ".agent-bridge-test", "tmp"); mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, "rehearsal-message-proof-"));
  const db = new DatabaseSync(join(home, "bridge.db"));
  try {
    db.exec("CREATE TABLE messages(id TEXT PRIMARY KEY,body TEXT,payload BLOB); CREATE TABLE archived_messages(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE job_delivery_routes(id TEXT PRIMARY KEY,recipient TEXT); CREATE TABLE conversation_records(raw BLOB); PRAGMA user_version=9");
    db.prepare("INSERT INTO messages VALUES(?,?,?)").run("synthetic-id", body, Buffer.from([1, 2, 3]));
    db.exec("INSERT INTO job_delivery_routes VALUES('synthetic-id','synthetic-recipient'); INSERT INTO conversation_records VALUES(X'0123')");
  } finally { db.close(); }
  vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "1");
  const result = await messageBackupIfDue(home, { checkpoint: async () => {} });
  if (!result.path) throw new Error("Synthetic message backup was not published");
  const path = result.path, manifestPath = join(path, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MessageBackupManifest;
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  const refreshFileProof = () => {
    const file = manifest.files[0]!, bytes = readFileSync(join(path, file.path));
    file.bytes = bytes.length; file.sha256 = createHash("sha256").update(bytes).digest("hex"); save();
  };
  return { path, manifest, save, refreshFileProof };
}

describe("rehearsal automatic backup proof", () => {
  it("accepts a genuine message-only backup above 8MiB with verified tables, rows and hashes", async () => {
    const fixture = await backup("m".repeat(9 * 1024 * 1024));
    const proof = await verifyRehearsalMessageBackup(fixture.path);
    expect(proof.bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(proof).toMatchObject({ conversationHistoryAbsent: true, tableProofsVerified: true });
    expect(proof.manifest.files[0]!.tables.map(table => [table.name, table.rows])).toEqual([["messages", 1], ["archived_messages", 0], ["job_delivery_routes", 1]]);
  });
  it("rejects a tiny injected history table even with a valid replacement file hash", async () => {
    const fixture = await backup(), db = new DatabaseSync(join(fixture.path, fixture.manifest.files[0]!.path));
    try { db.exec("CREATE TABLE conversation_records(raw BLOB); INSERT INTO conversation_records VALUES(X'01')"); }
    finally { db.close(); }
    fixture.refreshFileProof();
    expect(fixture.manifest.files[0]!.bytes).toBeLessThan(8 * 1024 * 1024);
    await expect(verifyRehearsalMessageBackup(fixture.path)).rejects.toThrow("non-message or undeclared table");
  });
  it("rejects an undeclared tiny history database beside valid message files", async () => {
    const fixture = await backup(), db = new DatabaseSync(join(fixture.path, "history.db"));
    try { db.exec("CREATE TABLE conversation_records(raw BLOB)"); } finally { db.close(); }
    await expect(verifyRehearsalMessageBackup(fixture.path)).rejects.toThrow("undeclared file");
  });
  it.each(["kind", "restore", "exclusions", "source", "path", "duplicate-file", "undeclared-table"])("rejects a tiny backup with invalid %s manifest proof", async fault => {
    const fixture = await backup();
    if (fault === "kind") Object.assign(fixture.manifest, { kind: "full-store" });
    if (fault === "restore") Object.assign(fixture.manifest, { restore: "replace-store" });
    if (fault === "exclusions") fixture.manifest.excludes.pop();
    if (fault === "source") fixture.manifest.files[0]!.source = "history.db";
    if (fault === "path") fixture.manifest.files[0]!.path = "../bridge.db";
    if (fault === "duplicate-file") fixture.manifest.files.push(fixture.manifest.files[0]!);
    if (fault === "undeclared-table") fixture.manifest.files[0]!.tables.pop();
    fixture.save();
    await expect(verifyRehearsalMessageBackup(fixture.path)).rejects.toThrow(/scope failed|undeclared table|undeclared file/);
  });
  it.each(["file-hash", "file-bytes", "row-count", "row-digest", "schema"])("rejects a tiny backup with invalid %s content proof", async fault => {
    const fixture = await backup(), file = fixture.manifest.files[0]!, table = file.tables[0]!;
    if (fault === "file-hash") file.sha256 = "0".repeat(64);
    if (fault === "file-bytes") file.bytes++;
    if (fault === "row-count") table.rows++;
    if (fault === "row-digest") table.sha256 = "0".repeat(64);
    if (fault === "schema") table.schema = "CREATE TABLE messages(wrong TEXT)";
    fixture.save();
    await expect(verifyRehearsalMessageBackup(fixture.path)).rejects.toThrow(/hash\/bytes failed|schema\/count proof failed|row count\/digest failed/);
  });
});
