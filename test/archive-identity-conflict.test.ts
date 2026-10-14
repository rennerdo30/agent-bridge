import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION, QUEUED_MAIL_MAX_AGE_MS } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { archiveDbPath, archiveMessages } from "../src/core/sqlite-maintenance.js";
import { doctor } from "../src/core/doctor.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const mail = (id: string, body: string, createdAt = Date.now() - QUEUED_MAIL_MAX_AGE_MS - 60_000): BridgeMessage => ({
  id, recipient: "codex-app", from: { id: "sender", name: "sender", agent: "other" }, to: "codex-app",
  conversationId: id, replyTo: null, hop: 0, body, createdAt, readAt: null,
});
function seedConflict(store: MessageStore, id = "poison", sourceCreatedAt?: number) {
  const original = mail(id, "canonical archive variant");
  store.insert(original);
  const { db: source, archiveDb: archive } = store as unknown as { db: DatabaseSync; archiveDb: DatabaseSync };
  expect(archiveMessages(source, archive, "id=?", [id], "fixture canonical")).toBe(1);
  store.insert({ ...original, body: "retained source variant", createdAt: sourceCreatedAt ?? original.createdAt });
  return original;
}
async function hello(raw: BridgeClient, sessionId = "new-session") {
  return raw.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home),
    peer: { id: sessionId, name: "codex-app", agent: "codex", cwd: env.home,
      pid: process.pid, agentPid: null, sessionId, startedAt: Date.now(), autoWake: false } });
}

const archiveFailures = ["marker", "remove", "archive"] as const;
type ArchiveFailure = typeof archiveFailures[number];

/** Synchronous setup owns both handles, including a failed second open or DDL. */
function withArchiveDatabases<T>(file: string, setup: (primary: DatabaseSync, archive: DatabaseSync) => T,
  open: (path: string) => DatabaseSync = path => new DatabaseSync(path)): T {
  let primary: DatabaseSync | undefined, archive: DatabaseSync | undefined;
  try {
    primary = open(file);
    archive = open(archiveDbPath(file));
    return setup(primary, archive);
  } finally {
    try { archive?.close(); } finally { primary?.close(); }
  }
}
function installArchiveFault(primary: DatabaseSync, archive: DatabaseSync, failure: ArchiveFailure): void {
  if (failure === "marker") primary.exec("CREATE TRIGGER reject_marker BEFORE INSERT ON message_archive_conflicts WHEN NEW.id='poison-2' BEGIN SELECT RAISE(ABORT,'fixture marker failure'); END");
  if (failure === "remove") primary.exec("CREATE TRIGGER reject_remove BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'fixture remove failure'); END");
  if (failure === "archive") archive.exec("CREATE TRIGGER reject_archive BEFORE INSERT ON messages WHEN NEW.id='healthy' BEGIN SELECT RAISE(ABORT,'fixture archive failure'); END");
}

it("registers repeatedly with mixed stale/current mail and bounded durable conflict evidence", async () => {
  const host = env.node("host", "other"); await host.start();
  const store = new MessageStore(env.db, nullLogger);
  const warn = vi.spyOn(nullLogger, "warn");
  try {
    for (const id of ["poison", "poison-2", "poison-3"]) seedConflict(store, id);
    seedConflict(store, "fresh-conflict", Date.now());
    store.insert(mail("healthy-old", "normal stale mail"));
    store.insert(mail("fresh", "current mail", Date.now()));
  }
  finally { store.close(); }
  const received: BridgeMessage[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await BridgeClient.connect(env.pipe, nullLogger);
    raw.on("event", (event, message) => { if (event === "message") received.push(message as BridgeMessage); });
    try {
      await expect(hello(raw)).resolves.toBeTruthy();
      expect((await raw.request("pending", { limit: 500 })).map(m => m.id).sort()).toEqual(["fresh", "fresh-conflict"]);
    } finally { raw.close(); }
  }
  expect(received.every(m => m.id === "fresh" || m.id === "fresh-conflict")).toBe(true);
  const primary = new DatabaseSync(env.db, { readOnly: true });
  const archive = new DatabaseSync(archiveDbPath(env.db), { readOnly: true });
  try {
    expect(primary.prepare("SELECT body, read_at FROM messages WHERE id='poison'").get()).toEqual({ body: "retained source variant", read_at: null });
    expect(archive.prepare("SELECT body FROM messages WHERE id='poison'").get()!.body).toBe("canonical archive variant");
    expect(primary.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n).toBe(5);
    expect(archive.prepare("SELECT body FROM messages WHERE id='healthy-old'").get()!.body).toBe("normal stale mail");
    const evidence = primary.prepare("SELECT * FROM message_archive_conflicts ORDER BY id").all();
    expect(evidence).toHaveLength(3);
    const fields = ["id", "recipient", "from_id", "from_name", "from_agent", "to_target", "conversation_id", "reply_to", "hop", "body", "created_at"];
    for (const row of evidence) {
      const source = JSON.parse(String(row.source_json)), canonical = JSON.parse(String(row.archive_json));
      expect(source.body).toBe("retained source variant");
      expect(canonical.body).toBe("canonical archive variant");
      const hash = (value: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(fields.map(key => value[key]))).digest("hex");
      expect(row.source_hash).toBe(hash(source)); expect(row.archive_hash).toBe(hash(canonical));
      expect(row.source_hash).not.toBe(row.archive_hash);
      expect(row).toMatchObject({ source_table: "messages", source_db: env.db, archive_db: archiveDbPath(env.db),
        reason: "stale queue", encounters: 1, last_seen: row.first_seen });
      expect(primary.prepare("SELECT * FROM messages WHERE rowid=?").get(row.source_rowid!)).toEqual(source);
    }
    expect(warn.mock.calls.filter(([message]) => message === "quarantined archive identity conflicts; original messages preserved")).toEqual([
      ["quarantined archive identity conflicts; original messages preserved", { table: "messages", reason: "stale queue", count: 3 }],
    ]);
  } finally { primary.close(); archive.close(); }
  // Restarting the store neither retries frozen rows nor logs them again.
  const reopened = new MessageStore(env.db, nullLogger);
  try { expect(await reopened.expireQueuedAsync("codex-app", Date.now() - QUEUED_MAIL_MAX_AGE_MS)).toBe(0); }
  finally { reopened.close(); }
  expect(warn.mock.calls.filter(([message]) => message.includes("quarantined archive"))).toHaveLength(1);
  await host.stop(); // Read-only doctor runs after this fixture's background writers stop.
  expect(doctor(env.home).findings.some(f => f.code === "archive-conflicts" && f.detail.includes("3"))).toBe(true);
});

it("keeps equal content idempotent while merging mutable read metadata", () => {
  const store = new MessageStore(env.db, nullLogger), message = mail("equal", "same payload");
  const primary = new DatabaseSync(env.db), archive = new DatabaseSync(archiveDbPath(env.db));
  try {
    store.insert(message); expect(store.expireQueued("codex-app", Date.now())).toBe(1);
    const before = archive.prepare("SELECT * FROM messages WHERE id='equal'").get()!;
    store.insert(message); expect(store.markRead("codex-app", [message.id], 123)).toBe(1);
    expect(store.purgeOlderThan(Date.now())).toBe(1);
    expect(archive.prepare("SELECT * FROM messages WHERE id='equal'").get()).toEqual({ ...before, read_at: 123 });
    // Legacy archive_reason/archived_at are also receipt metadata, never identity.
    primary.prepare("ATTACH DATABASE ? AS fixture_archive").run(archiveDbPath(env.db));
    primary.prepare("INSERT INTO archived_messages SELECT id,recipient,from_id,from_name,from_agent,to_target,conversation_id,reply_to,hop,body,created_at,read_at,?,? FROM fixture_archive.messages").run("different reason", 999);
    primary.exec("DETACH DATABASE fixture_archive");
    expect(archiveMessages(primary, archive, "1", [], "legacy", "archived_messages")).toBe(1);
    expect(archive.prepare("SELECT * FROM messages WHERE id='equal'").get()).toEqual({ ...before, read_at: 123 });
    expect(primary.prepare("SELECT COUNT(*) AS n FROM message_archive_conflicts").get()!.n).toBe(0);
  } finally { primary.close(); archive.close(); store.close(); }
});

it.each(archiveFailures)("rolls back marker and evidence on %s failure and hello fails closed", async failure => {
  // This case owns a fresh home. Finish setup before creating any broker or worker.
  const store = new MessageStore(env.db, nullLogger);
  try { seedConflict(store); seedConflict(store, "poison-2"); store.insert(mail("healthy", "normal stale mail")); }
  finally { store.close(); }
  const before = withArchiveDatabases(env.db, (primary, archive) => {
    const before = primary.prepare("SELECT * FROM messages ORDER BY id").all();
    installArchiveFault(primary, archive, failure);
    return before;
  }); // Both setup handles are really closed before host startup.
  let primary: DatabaseSync | undefined, archive: DatabaseSync | undefined, raw: BridgeClient | undefined;
  try {
    await env.node("host", "other").start();
    primary = new DatabaseSync(env.db, { readOnly: true });
    archive = new DatabaseSync(archiveDbPath(env.db), { readOnly: true });
    raw = await BridgeClient.connect(env.pipe, nullLogger);
    const received: BridgeMessage[] = [];
    raw.on("event", (event, message) => { if (event === "message") received.push(message as BridgeMessage); });
    await expect(hello(raw)).rejects.toMatchObject({ code: "internal", message: `fixture ${failure} failure` });
    expect(await raw.request("pending", { limit: 500 })).toEqual([]);
    expect(received).toEqual([]);
    expect(primary.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(before);
    expect(primary.prepare("SELECT COUNT(*) AS n FROM message_archive_conflicts").get()!.n).toBe(0);
    expect(archive.prepare("SELECT body FROM messages WHERE id='poison'").get()!.body).toBe("canonical archive variant");
  } finally {
    try { raw?.close(); } finally {
      try { archive?.close(); } finally { primary?.close(); }
    }
  }
});

it.each(archiveFailures)("rejects forced %s setup contention, then installs only after writer close", failure => {
  const store = new MessageStore(env.db, nullLogger);
  try { seedConflict(store); seedConflict(store, "poison-2"); store.insert(mail("healthy", "normal stale mail")); }
  finally { store.close(); }
  const writer = new DatabaseSync(failure === "archive" ? archiveDbPath(env.db) : env.db);
  let locked = false;
  try {
    writer.exec("BEGIN IMMEDIATE"); locked = true;
    let contention: unknown;
    try {
      withArchiveDatabases(env.db, (primary, archive) => {
        primary.prepare("SELECT * FROM messages ORDER BY id").all();
        installArchiveFault(primary, archive, failure);
      });
    } catch (error) { contention = error; }
    expect(contention).toMatchObject({ errcode: 5 });
    expect(writer.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name=?").get(`reject_${failure}`)!.n).toBe(0);
    writer.exec("COMMIT"); locked = false;
  } finally {
    try { if (locked) writer.exec("ROLLBACK"); } finally { writer.close(); }
  }
  // No sleep, busy-timeout change, retry loop, or worker termination substitutes for close.
  withArchiveDatabases(env.db, (primary, archive) => {
    installArchiveFault(primary, archive, failure);
    const target = failure === "archive" ? archive : primary;
    expect(target.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name=?").get(`reject_${failure}`)!.n).toBe(1);
  });
});

it.each(["archive-open", "setup"] as const)("closes native setup handles on early %s failure", phase => {
  const store = new MessageStore(env.db, nullLogger);
  store.close();
  const handles: DatabaseSync[] = [], injected = new Error(`fixture early ${phase} failure`);
  const open = (path: string) => {
    if (phase === "archive-open" && path === archiveDbPath(env.db)) throw injected;
    const db = new DatabaseSync(path); handles.push(db); return db;
  };
  let thrown: unknown;
  try { withArchiveDatabases(env.db, () => { throw injected; }, open); }
  catch (error) { thrown = error; }
  expect(thrown).toBe(injected);
  expect(handles).toHaveLength(phase === "archive-open" ? 1 : 2);
  for (const db of handles) expect(() => db.prepare("SELECT 1")).toThrow(/not open|closed/i);
  // The same database pair remains usable; afterEach also removes this case's home on Windows.
  withArchiveDatabases(env.db, (primary, archive) => {
    expect(primary.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n).toBe(0);
    expect(archive.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n).toBe(0);
  });
});

it("freezes conflicts across claim, receipt, handoff, inline delivery, sync/async expiry and purge", async () => {
  const store = new MessageStore(env.db, nullLogger);
  const primary = new DatabaseSync(env.db), archive = new DatabaseSync(archiveDbPath(env.db));
  try {
    const message = { ...mail("job-conflict", "old job variant"), from: { id: "job:worker", name: "worker", agent: "other" as const } };
    store.insert(message); store.expireQueued("codex-app", Date.now());
    store.insert({ ...message, body: "source job variant" });
    const before = primary.prepare("SELECT * FROM messages WHERE id=?").get(message.id)!;
    expect(await store.expireQueuedAsync("codex-app", Date.now())).toBe(1);
    expect(store.unread("codex-app", 100)).toEqual([]);
    expect(store.replyConflicts("codex-app", ["worker"], message.conversationId)).toEqual([]);
    expect(store.claim("codex-app", "new-owner")).toBe(0);
    expect(store.markRead("codex-app", [message.id])).toBe(0);
    expect(store.handoffMail("codex-app", "new-owner", "worker", Date.now())).toEqual([]);
    expect(store.pendingJobRecipients("worker")).toEqual([]);
    expect(store.pendingJobSenders()).toEqual(new Set());
    expect(store.recentProjectSenders("codex-app", "codex-app", 0)).toEqual([]);
    expect(store.insertJobDelivery({ ...message, body: "source job variant" })).toBe(false);
    expect(store.insertOnce(message)).toBe(false);
    store.insert({ ...message, recipient: "new-owner", createdAt: Date.now() });
    expect(store.handoffMail("new-owner", "codex-app", "worker", Date.now(), true)).toEqual([]);
    expect(store.claim("codex-app", "new-owner")).toBe(0); // duplicate retirement also cannot mutate the frozen row
    expect(store.expireQueued("codex-app", Date.now())).toBe(0);
    expect(await store.expireQueuedAsync("codex-app", Date.now())).toBe(0);
    expect(store.purgeOlderThan(Date.now() - QUEUED_MAIL_MAX_AGE_MS)).toBe(0);
    expect(archiveMessages(primary, archive, "id=? AND recipient=?", [message.id, "codex-app"], "offline purge")).toBe(0);
    // Inspection and retry identity lookups retain the original source content.
    expect(store.byId(message.id)?.body).toBe("source job variant");
    expect(store.messagesById(message.id)[0]?.body).toBe("source job variant");
    expect(primary.prepare("SELECT * FROM messages WHERE id=?").get(message.id)).toEqual(before);
    const original = (store as unknown as { archivePurgeChunk(cutoff: number): boolean });
    while (original.archivePurgeChunk(Date.now())) { /* bounded maintenance cursor advances past frozen rows */ }
    expect(primary.prepare("SELECT * FROM messages WHERE id=?").get(message.id)).toEqual(before);
    expect(primary.prepare("SELECT encounters FROM message_archive_conflicts").get()!.encounters).toBe(1);
  } finally { primary.close(); archive.close(); store.close(); }
});

it("preserves separate legacy variants and skips them in later maintenance chunks", () => {
  const store = new MessageStore(env.db, nullLogger), primary = new DatabaseSync(env.db), archive = new DatabaseSync(archiveDbPath(env.db));
  try {
    seedConflict(store);
    primary.prepare("INSERT INTO archived_messages SELECT *,?,? FROM messages WHERE id='poison'").run("legacy original", 1);
    primary.prepare("INSERT INTO archived_messages SELECT *,?,? FROM messages WHERE id='poison'").run("legacy duplicate", 3);
    primary.prepare("INSERT INTO archived_messages SELECT id,recipient,from_id,from_name,from_agent,to_target,conversation_id,reply_to,hop,?,created_at,read_at,?,? FROM messages WHERE id='poison'").run("second legacy variant", "legacy second", 2);
    expect(archiveMessages(primary, archive, "1", [], "legacy", "archived_messages")).toBe(3);
    expect(archiveMessages(primary, archive, "1", [], "legacy", "archived_messages")).toBe(0);
    expect(primary.prepare("SELECT COUNT(*) AS n FROM archived_messages").get()!.n).toBe(3);
    expect(primary.prepare("SELECT COUNT(*) AS n FROM message_archive_conflicts WHERE source_table='archived_messages'").get()!.n).toBe(2);
    expect(primary.prepare("SELECT encounters FROM message_archive_conflicts WHERE source_table='archived_messages' ORDER BY encounters").all()).toEqual([{ encounters: 1 }, { encounters: 2 }]);
    primary.exec("VACUUM"); // quarantine identity survives rowid reassignment in snapshots/compaction
    expect((store as unknown as { archiveChunk(table: string, where: string, args: unknown[], reason: string): number }).archiveChunk("archived_messages", "1", [], "legacy")).toBe(0);
  } finally { primary.close(); archive.close(); store.close(); }
});

it("reproduces a source origin: job handoff reuses an archived identity with rewritten routing", () => {
  const store = new MessageStore(env.db, nullLogger), primary = new DatabaseSync(env.db), archive = new DatabaseSync(archiveDbPath(env.db));
  try {
    const original = { ...mail("handoff-id", "unchanged body"), to: "old-owner",
      from: { id: "job:worker", name: "worker", agent: "other" as const } };
    store.insert(original); store.expireQueued("codex-app", Date.now());
    store.insert({ ...original, recipient: "old-owner" });
    expect(store.handoffMail("old-owner", "codex-app", "worker", Date.now(), true)).toHaveLength(1);
    expect(store.expireQueued("codex-app", Date.now())).toBe(1);
    const evidence = primary.prepare("SELECT * FROM message_archive_conflicts WHERE id='handoff-id'").get()!;
    const source = JSON.parse(String(evidence.source_json)), canonical = JSON.parse(String(evidence.archive_json));
    expect(source.id).toBe(canonical.id); expect(source.body).toBe(canonical.body);
    expect(source.to_target).toBe("codex-app"); expect(canonical.to_target).toBe("old-owner");
    expect(source.conversation_id).toBe("handoff-id:fallback"); expect(canonical.conversation_id).toBe("handoff-id");
    expect(store.unread("codex-app", 10)).toEqual([]);
  } finally { primary.close(); archive.close(); store.close(); }
});
