import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishApproval, newApprovalId } from "../src/core/relay.js";
import { MessageStore } from "../src/core/store.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageWaitStore } from "../src/mcp/message-wait.js";
import { uninstallOpencode } from "../src/cli/opencode-install.js";
import { makeEnv, type TestEnv } from "./helpers.js";
import { normalizeSource, removalOperations } from "./retention-guard.js";

const SOURCE_ROOT = join(import.meta.dirname, "..", "src");
// Every exception is an exact call, counted below. Reasons and limits live in docs/data-retention.md.
const REVIEWED_REMOVALS: Record<string, string[]> = {
  // Exclusively created unpublished key staging file; the active key is never removed.
  "cli/dashboard-key.ts": ["unlinkSync(temp)"],
  "core/json-store.ts": ["rmSync(tmp, { force: true })"],
  "core/node.ts": ["unlinkSync(this.opts.pipePath)"],
  // Lock/lease files hold only PID, start time and nonce. A stale lock is moved aside first and its moved copy removed
  // only when its nonce still matches; a lease is removed only when its owner process is gone.
  "core/storage-lock.ts": ["rmSync(moved, { force: true })", "rmSync(moved, { force: true })", "rmSync(path)", "rmSync(path, { force: true })", "rmSync(path, { force: true })", "rmSync(lease, { force: true })"],
  // Exclusively created unpublished token staging file (or a duplicate hard link after publication); the token itself is never removed.
  "core/token.ts": ["unlinkSync(temp)"],
  "core/migration-lock.ts": ["rmSync(path)", "rmSync(path)", "rmSync(path)", "rmSync(recovery)"],
  // Exited worker's migration lock only: current PID and exact recorded nonce must match.
  // retainFailedAttempt copies every row into retained_<stamp>_* tables in the same transaction before emptying the copy tables;
  // clearHistoryDocuments empties the derived search documents (FTS delete-all) for that retained attempt or a reindex.
  "core/history-store.ts": ["rmSync(path)", "`DELETE FROM ${quote(name)}`",
    "`CREATE TABLE ${quote(`retained_${stamp}_history_migration`)} AS SELECT * FROM history_migration; DELETE FROM history_migration;`",
    "`CREATE TABLE ${quote(`retained_${stamp}_history_copy_state`)} AS SELECT * FROM history_copy_state; DELETE FROM history_copy_state;`",
    '"DELETE FROM history_documents"', '"DELETE FROM history_documents"'],
  // Packing bookkeeping only: the failure record of a run that has since been packed successfully.
  "core/finished-run-bundles.ts": ['"DELETE FROM bridge_metadata WHERE domain=? AND key=?"'],
  // Absorb cursor bookkeeping only: a table with conflicts restarts its scan; the conflicting rows themselves are kept.
  "core/storage-absorb.ts": ['"DELETE FROM absorb_progress WHERE source=? AND table_name=?"'],
  // Owner decision 2026-10-09: the explicit, confirmed `storage finalize` removes superseded copies only after the new
  // format is verified and each item is proven redundant row by row / byte by byte immediately before removal.
  "core/storage-finalize.ts": ["`DROP TABLE IF EXISTS \"${item.path.slice(\"bridge.db:\".length).replaceAll('\"', '\"\"')}\"`",
    "`DROP TABLE IF EXISTS \"${name.replaceAll('\"', '\"\"')}\"`", "rmSync(path, { recursive: true, force: true })", "rmSync(path, { force: true })", "rmdirSync(group.dir)"],
  "core/notifications.ts": ["rmdirSync(lock)", "rmdirSync(lock)"],
  "mcp/rewake.ts": ["rmSync(sessionFile(this.home, this.registered), { force: true })", "rmSync(sessionFile(this.home, this.registered), { force: true })"],
  "network/files.ts": ["rmSync(staging, { recursive: true, force: true })"],
  "cli/smoke.ts": ["rmSync(dir, { recursive: true, force: true })"],
  "cli/reliability.ts": ["rmSync(r, { recursive: true, force: true, maxRetries: 3 })", "rmSync(home, { recursive: true, force: true, maxRetries: 3 })"],
  "cli/reliability-live.ts": ["rmSync(h, { recursive: true, force: true, maxRetries: 3 })"],
  "core/worktree-links.ts": ["unlinkSync(path)", "rmdirSync(path)", "rmSync(probe, { recursive: true, force: true })"],
  "core/worktree.ts": ["rmSync(toNamespacedPath(resolve(path)), { recursive: true, force: true, maxRetries: REMOVE_RETRIES })"],
  "core/resource-slots.ts": ['"DELETE FROM slots WHERE expiresAt <= ?"', '"DELETE FROM slots WHERE pid = ? AND identity IS ?"', '`DELETE FROM slots WHERE id = ? AND pid = ?${resource ? " AND resource = ?" : ""}`'],
  "core/sqlite-maintenance.ts": ["`DELETE FROM ${table} WHERE ${where}`"],
  "core/sqlite-migrations.ts": ["`DELETE FROM ${quoted}`"],
  // Temporary working folder (mkdtempSync) of the low-cost model that answers search questions.
  "core/history-answer.ts": ["rmSync(cwd, { recursive: true, force: true })"],
  // Derived search index only (pending queue, full rebuild by reindex); source messages, logs and transcripts are read-only.
  "core/history.ts": ['"DELETE FROM history_pending WHERE id=? AND recipient=?"', '"DELETE FROM history_tags; DELETE FROM history_cursors WHERE source<>\'legacy-record-tail\'; DELETE FROM history_files;"'],
  // Temporary duplicates after whole-file SHA-256 verification and exclusive publication of the final file; truncation trims
  // only unverified tails of private .part files and their checksum journal on resume. Received files are never removed.
  "network/transfers.ts": ["unlink(part)", "unlink(verified)", "unlink(verifiedPath)", "unlink(verified)", "file.truncate(verified)", "journal.truncate(chunks * SHA_RECORD_BYTES)"],
};
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

describe("owner data retention rule", () => {
  it("refuses every unreviewed filesystem removal or destructive SQL in production source", () => {
    const violations: string[] = [];
    for (const file of sources(SOURCE_ROOT)) {
      const name = relative(SOURCE_ROOT, file).replace(/\\/g, "/");
      const allowed = [...(REVIEWED_REMOVALS[name] ?? [])].map(normalizeSource);
      for (const operation of removalOperations(readFileSync(file, "utf8"))) {
        const index = allowed.indexOf(operation.expression);
        if (index < 0) violations.push(`${name}: ${operation.expression}`);
        else allowed.splice(index, 1);
      }
    }
    expect(violations, "Unique user data must be archived before removal. See docs/data-retention.md.").toEqual([]);
  });

  it("detects new deletions even through aliases, namespaces and promises", () => {
    expect(removalOperations('import { rmSync as erase } from "node:fs"; erase("user.log");')).toMatchObject([{ kind: "file", expression: 'rmSync("user.log")' }]);
    expect(removalOperations('import * as fs from "node:fs/promises"; await fs.unlink("transcript.jsonl");')).toHaveLength(1);
    expect(removalOperations('db.exec("DROP TABLE messages");')).toHaveLength(1);
    expect(removalOperations('db.exec(`DELETE FROM ${table}`);')).toHaveLength(1);
    expect(removalOperations('db.exec("SELECT 1; DELETE FROM messages");')).toHaveLength(1);
    expect(removalOperations('await fileHandle.truncate(0);')).toMatchObject([{ kind: "file", expression: "fileHandle.truncate(0)" }]);
    // Quotes inside regular expressions and nested template literals must not hide later statements.
    expect(removalOperations('const r = s.replace(/"?x"?/, ""); db.exec("DELETE FROM a");')).toMatchObject([{ kind: "sql", expression: '"DELETE FROM a"' }]);
    expect(removalOperations('db.exec(`CREATE TABLE ${q(`x_${n}`)} AS SELECT * FROM b; DELETE FROM b;`); db.exec("DELETE FROM c");')).toHaveLength(2);
  });

  it("requires copy commit before SQL deletion and durable job archival before filtering", () => {
    const sql = readFileSync(join(SOURCE_ROOT, "core/sqlite-maintenance.ts"), "utf8");
    expect(sql.indexOf('archive.exec("COMMIT")')).toBeLessThan(sql.indexOf("DELETE FROM ${table}"));
    expect(sql).toContain("archive identity conflict; original message preserved");
    const jobs = readFileSync(join(SOURCE_ROOT, "mcp/jobs.ts"), "utf8");
    const archiveAt = jobs.indexOf("archiveJobs(this.storePath"), pruneAt = jobs.indexOf("jobs: all.filter");
    expect(archiveAt).toBeGreaterThanOrEqual(0);
    expect(pruneAt).toBeGreaterThanOrEqual(0);
    expect(archiveAt).toBeLessThan(pruneAt);
    const runfeed = readFileSync(join(SOURCE_ROOT, "core/runfeed.ts"), "utf8");
    expect(runfeed).toContain("archiveRun(path)");
    const archiveRun = readFileSync(join(SOURCE_ROOT, "core/run-archive.ts"), "utf8");
    expect(archiveRun).toContain("copyFileSync(meta, archivedMeta)");
    expect(archiveRun).toContain("renameSync(log, target)");
    expect(removalOperations(runfeed)).toEqual([]);
    expect(removalOperations(readFileSync(join(SOURCE_ROOT, "core/relay.ts"), "utf8"))).toEqual([]);
    expect(readFileSync(join(SOURCE_ROOT, "core/worktree-cleanup.ts"), "utf8")).toContain('"ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"');
  });

  it("keeps original messages when an archive copy fails, and all recipients after expiry", () => {
    const path = join(env.home, "retention.db"), store = new MessageStore(path, nullLogger);
    const archive = new DatabaseSync(join(env.home, "archive.db"));
    const message: BridgeMessage = { id: "old", recipient: "codex", from: { id: "parent", name: "parent", agent: "claude" }, to: "codex", conversationId: "conversation", replyTo: null, hop: 0, body: "Unique user content", createdAt: 1, readAt: null };
    try {
      store.insert(message); store.insert({ ...message, recipient: "claude" });
      archive.exec("CREATE TRIGGER refuse_archive BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'copy refused'); END;");
      expect(() => store.purgeOlderThan(2)).toThrow("copy refused");
      expect(store.byId(message.id)?.body).toBe(message.body); expect(store.receipts(message.id)).toHaveLength(2);
      archive.exec("DROP TRIGGER refuse_archive");
      expect(store.expireQueued("codex", 2)).toBe(1); expect(store.purgeOlderThan(2)).toBe(1);
      expect(store.byId(message.id)?.body).toBe(message.body); expect(store.receipts(message.id)).toHaveLength(2);
      expect(archive.prepare("SELECT body FROM messages").all()).toHaveLength(2);
    } finally { archive.close(); store.close(); }
  });

  it("archives completed approvals and wait records with their original bytes", async () => {
    const id = newApprovalId(), dir = join(env.home, "approvals");
    const close = await publishApproval(env.home, { id, owner: "parent", job: "codex-job-test", agent: "codex", tool: "shell", command: "npm test", reason: "test", askedAt: Date.now(), deadline: Date.now() + 10_000 }, () => true);
    const bytes = readFileSync(join(dir, `${id}.json`)); close();
    const archive = join(dir, "archive"), name = readdirSync(archive).find((file) => file.startsWith(`${id}.json-`))!;
    expect(readFileSync(join(archive, name))).toEqual(bytes);
    const waits = join(env.home, "message-waits"); mkdirSync(waits, { recursive: true });
    writeFileSync(join(waits, `${id}.json`), "unique wait record"); new MessageWaitStore(env.home).remove(id);
    expect(readFileSync(join(waits, "archive", readdirSync(join(waits, "archive"))[0]!), "utf8")).toBe("unique wait record");
  });

  it("keeps all transcript modules read-only", () => {
    const unsafeFs = /\b(?:write|append|copy|rename|mkdir|rm|unlink|rmdir|truncate|createWriteStream)[A-Za-z]*\b/;
    for (const file of sources(join(SOURCE_ROOT, "core/transcripts"))) {
      const text = readFileSync(file, "utf8");
      expect(removalOperations(text)).toEqual([]);
      const imports = text.match(/import\s+\{[^}]+\}\s+from\s+["']node:fs["']/g) ?? [];
      expect(imports.filter((entry) => unsafeFs.test(entry))).toEqual([]);
      if (text.includes("new DatabaseSync")) expect(text).toMatch(/new DatabaseSync\([^\n]+readOnly: true/);
    }
    const history = readFileSync(join(SOURCE_ROOT, "core/run-history.ts"), "utf8");
    expect(history).not.toMatch(/\breadJsonStore\s*\(/);
    expect(history.match(/import\s+\{[^}]+\}\s+from\s+["']node:fs["']/g)?.some((entry) => unsafeFs.test(entry))).toBe(false);
  });

  it("archives locally edited installed files and folders during uninstall", () => {
    const plugins = join(env.home, "plugins"), folder = join(plugins, "agent-bridge");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(plugins, "agent-bridge.js"), "agent-bridge with local edits");
    writeFileSync(join(folder, "owner-notes.txt"), "unique user notes");
    expect(uninstallOpencode(env.home, null).files).toHaveLength(2);
    const archive = join(plugins, "archive"), entries = readdirSync(archive);
    expect(readFileSync(join(archive, entries.find((name) => name.startsWith("agent-bridge.js-"))!), "utf8")).toBe("agent-bridge with local edits");
    expect(readFileSync(join(archive, entries.find((name) => name.startsWith("agent-bridge-"))!, "owner-notes.txt"), "utf8")).toBe("unique user notes");
  });
});
