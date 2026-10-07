// Capture real released SQLite layouts. No package installation or owner stores are used.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tags = ["v0.27.0", "v0.27.1", "v0.28.0", "v0.28.1", "v0.28.2", "v0.29.0", "v0.29.10", "v0.29.13", "v0.29.14"];
const work = join(root, ".agent-bridge-test", `historical-sqlite-${randomUUID()}`);
const output = join(root, "test", "fixtures", "sqlite-upgrade");
mkdirSync(work, { recursive: true });
mkdirSync(output, { recursive: true });
process.env.AGENT_BRIDGE_BACKUP_INTERVAL_MS = "0";
process.env.AGENT_BRIDGE_HOME = join(work, "unused-owner-home");
process.env.CLAUDE_CONFIG_DIR = join(work, "empty-cli", "claude");
process.env.CODEX_HOME = join(work, "empty-cli", "codex");
process.env.XDG_DATA_HOME = join(work, "empty-cli", "data");
const log = { debug() {}, info() {}, warn() {}, error() {} };
const digest = (data) => createHash("sha256").update(data).digest("hex");
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const encode = (row) => JSON.stringify(row, (_key, value) =>
  value instanceof Uint8Array ? { blob: Buffer.from(value).toString("base64") } : typeof value === "bigint" ? { integer: String(value) } : value);
function snapshot(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name").all().map(({ name }) => {
    const rows = db.prepare(`SELECT * FROM ${quote(name)}`).all().map(encode).sort();
    return { name, count: rows.length, sha256: digest(JSON.stringify(rows)) };
  });
}
function insert(db, table, row) {
  const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((c) => c.name).filter((name) => name in row);
  db.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map((name) => row[name]));
}
function seed(db, tag, archive = false) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  const marker = `historical_sqlite_${tag.slice(1).replaceAll(".", "_")}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [i, agent] of ["claude", "codex", "opencode"].entries()) {
      const row = { id: `${tag}-${archive ? "cold" : "live"}-${i}`, recipient: "witness-owner", from_id: `${agent}-old-session`, from_name: `${agent}-old`, from_agent: agent,
        to_target: "witness-owner", conversation_id: i === 1 ? "siblings-witness:note" : i === 2 ? "broadcast-witness" : "direct-witness", reply_to: i ? `${tag}-live-0` : null,
        hop: i, body: `${marker} ${agent} ${archive ? "cold" : "live"} — 猫 🐈\n${"context ".repeat(24)}`, created_at: 1700000000000 + i,
        read_at: i === 1 ? 1700000000100 : null, archive_reason: "retained witness", archived_at: 1700000000200 };
      insert(db, "messages", row);
      if (tables.has("archived_messages")) insert(db, "archived_messages", { ...row, id: `${tag}-legacy-${i}`, body: `${marker} legacy ${agent}` });
    }
    if (tables.has("decisions")) for (let revision = 0; revision < 2; revision++) insert(db, "decisions", { id: `${tag}-decision-${revision}`, topic: "witness-decision", body: `${marker} decision ${revision}`, scope: '"all"', author_id: "opencode-old-session", author_name: "opencode-old", author_agent: "opencode", created_at: 1700000000300 + revision, source_message_id: `${tag}-live-2`, supersedes: revision ? `${tag}-decision-0` : null });
    if (tables.has("decision_deliveries")) insert(db, "decision_deliveries", { decision_id: `${tag}-decision-0`, session_key: "witness-owner", message_id: `${tag}-live-2`, created_at: 1700000000300 });
    const document = `${tag}-retained-document`;
    if (tables.has("history_documents")) insert(db, "history_documents", { id: document, kind: "transcript", agent: "opencode", at: 1700000000400, body: `${marker} old-index`, folded: `${marker} old-index`, link: "/?witness=retained", message: null, job: "opencode-job-witness", run: null, session: "opencode-old-session", cursor: "0" });
    if (tables.has("history_tags")) insert(db, "history_tags", { id: document, type: "session", value: "opencode-old-session" });
    if (tables.has("history_sessions")) insert(db, "history_sessions", { alias: "witness-alias", session: "opencode-old-session", job: "opencode-job-witness" });
    if (tables.has("history_cursors")) insert(db, "history_cursors", { source: "historical-witness", cursor: '{"offset":42}' });
    if (tables.has("history_files")) insert(db, "history_files", { path: "D:/retention-witness/transcript.jsonl", kind: "transcript", agent: "opencode", session: "opencode-old-session", cwd: "D:/retention-witness", child: null, checked: 1 });
    const identity = JSON.stringify(["opencode", 42, "historical-start", "D:/retention-witness", "opencode-old"]);
    if (tables.has("session_bindings")) insert(db, "session_bindings", { identity, session_id: "opencode-old-session", learned_at: 1700000000500 });
    if (tables.has("peer_names")) insert(db, "peer_names", { identity, name: "opencode-old", session_id: "opencode-old-session", agent: "opencode", learned_at: 1700000000500 });
    if (tables.has("peer_name_owners")) insert(db, "peer_name_owners", { name: "opencode-old", identity });
    if (tables.has("job_delivery_routes")) insert(db, "job_delivery_routes", { id: `${tag}-live-0`, recipient: "witness-owner", consumed_at: null });
    db.exec("CREATE TABLE witness_user_extensions(id TEXT PRIMARY KEY, payload BLOB NOT NULL, note TEXT)");
    insert(db, "witness_user_extensions", { id: "extension", payload: new Uint8Array([0, 255, 128, 1, 42]), note: `${marker} unknown-field` });
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
const manifest = { provenance: "Created by executing actual tagged MessageStore and, where present, openArchive source; seeded with synthetic local records.", runtime: process.version, captures: [] };
for (const tag of tags) {
  const reference = join(work, tag);
  mkdirSync(reference);
  const tar = join(work, `${tag}.tar`);
  execFileSync("git", ["archive", "--format=tar", `--output=${tar}`, tag, "src"], { cwd: root, windowsHide: true });
  execFileSync("tar", ["-xf", tar, "-C", reference], { windowsHide: true });
  const hasArchive = existsSync(join(reference, "src/core/sqlite-maintenance.ts"));
  const entry = join(reference, "entry.mjs");
  writeFileSync(entry, `export { MessageStore, SQLITE_STORE_VERSION } from './src/core/store.ts';\n${hasArchive ? "export { openArchive } from './src/core/sqlite-maintenance.ts';\n" : ""}`);
  const bundle = join(reference, "old-store.mjs");
  buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22", external: ["node:*"], banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }, logLevel: "silent" });
  const released = await import(pathToFileURL(bundle).href);
  const capture = join(reference, "capture");
  mkdirSync(capture);
  new released.MessageStore(join(capture, "bridge.db"), log).close();
  if (hasArchive) released.openArchive(join(capture, "archive.db")).close();
  const destination = join(output, tag);
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(reference, "src/core/store.ts"), join(destination, "store.ts.txt"));
  if (hasArchive) copyFileSync(join(reference, "src/core/sqlite-maintenance.ts"), join(destination, "sqlite-maintenance.ts.txt"));
  const files = [];
  for (const name of ["bridge.db", ...(hasArchive ? ["archive.db"] : [])]) {
    const path = join(capture, name), db = new DatabaseSync(path);
    seed(db, tag, name === "archive.db");
    const version = Number(db.prepare("PRAGMA user_version").get().user_version);
    const tables = snapshot(db);
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error(`Invalid historical witness ${tag}/${name}`);
    db.close();
    copyFileSync(path, join(destination, name));
    files.push({ name, version, sha256: digest(readFileSync(path)), tables });
  }
  manifest.captures.push({ tag, commit: execFileSync("git", ["rev-parse", `${tag}^{commit}`], { cwd: root, encoding: "utf8", windowsHide: true }).trim(), storeSourceSha256: digest(readFileSync(join(reference, "src/core/store.ts"))), archiveSourceSha256: hasArchive ? digest(readFileSync(join(reference, "src/core/sqlite-maintenance.ts"))) : null, files });
  process.stdout.write(`${tag}: bridge schema ${released.SQLITE_STORE_VERSION}; ${hasArchive ? "separate archive captured" : "legacy in-bridge archive only"}\n`);
}
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
