import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONVERSATION_SCHEMA } from "./conversation-schema.js";
import { historySchema } from "./history-schema.js";
import { migrateSqlite } from "./sqlite-migrations.js";
import { nullLogger } from "./logger.js";
import { canonicalProjectRoot } from "./project-identity.js";
import { isPluginCacheCwd } from "./session-visibility.js";

const excluded = new Map<string, boolean>();
function linkedParent(file: string): boolean {
  let parent = dirname(resolve(file));
  while (!existsSync(parent) && dirname(parent) !== parent)
    parent = dirname(parent);
  try {
    const physical = realpathSync.native(parent);
    return process.platform === "win32"
      ? physical.toLowerCase() !== parent.toLowerCase()
      : physical !== parent;
  } catch {
    return true;
  }
}
/** Worker-only canonicalization. Worktrees share the original project's root. */
export { conversationProject } from "./project-identity.js";

/** Never follow a user-provided link for writable project storage. */
export function ensureProjectFolder(project: string): string | null {
  if (!project || !existsSync(project)) return null;
  const folder = join(project, ".agent-bridge");
  if (
    existsSync(folder) &&
    (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink())
  )
    return null;
  const fresh = !existsSync(folder);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const gitMarker = existsSync(join(project, ".git"));
  if (!fresh && excluded.get(project) === gitMarker) return folder;
  try {
    const exclude = execFileSync(
      "git",
      [
        "-C",
        project,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "info/exclude",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      },
    ).trim();
    if (
      linkedParent(exclude) ||
      (existsSync(exclude) && lstatSync(exclude).isSymbolicLink())
    )
      return null;
    const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!text.split(/\r?\n/).includes("/.agent-bridge/")) {
      mkdirSync(dirname(exclude), { recursive: true });
      appendFileSync(
        exclude,
        `${text && !text.endsWith("\n") ? "\n" : ""}/.agent-bridge/\n`,
      );
    }
  } catch {
    if (existsSync(join(project, ".git"))) return null;
    /* Non-Git projects have no exclude file. */
  }
  excluded.set(project, gitMarker);
  return folder;
}

/** A moved folder gets a new filename; old replicas remain untouched. */
export function projectDatabasePath(project: string): string {
  const id = createHash("sha256").update(project).digest("hex").slice(0, 16);
  return join(project, ".agent-bridge", `conversations-${id}.db`);
}

/** A bounded append-only replica. Open with readOnly:true in consumers. */
export function syncProjectMirror(main: DatabaseSync, project: string, onPending?: (pending: boolean) => void): number {
  const folder = ensureProjectFolder(project);
  if (!folder) return 0;
  const path = projectDatabasePath(project);
  const archive = join(folder, "archive");
  if (
    linkedParent(path) ||
    (existsSync(archive) && lstatSync(archive).isSymbolicLink()) ||
    linkedParent(join(archive, "backup"))
  )
    return 0;
  for (const file of [path, `${path}-wal`, `${path}-shm`])
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) return 0;
  const existed = existsSync(path),
    mirror = new DatabaseSync(path, { timeout: 50 });
  try {
    migrateSqlite(
      mirror,
      path,
      existed,
      1,
      [
        {
          version: 1,
          sql: `CREATE TABLE messages (id TEXT, body TEXT, from_agent TEXT, from_name TEXT, from_id TEXT, recipient TEXT, to_target TEXT, created_at INTEGER); ${historySchema()} ${CONVERSATION_SCHEMA} CREATE TABLE mirror_cursor (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL); INSERT INTO mirror_cursor VALUES(1,0); PRAGMA user_version=1;`,
        },
      ],
      nullLogger,
    );
    mirror.exec("PRAGMA journal_mode=WAL;");
    const after = Number(
      mirror.prepare("SELECT value FROM mirror_cursor WHERE id=1").get()!.value,
    );
    const primary = main
      .prepare(
        `SELECT r.id,r.conversation FROM conversation_records r JOIN conversations c ON c.id=r.conversation WHERE c.project=? AND r.id>? ORDER BY r.id LIMIT 32`,
      )
      .all(project, after);
    const associated = main
      .prepare(
        "SELECT r.id,r.conversation FROM conversation_memberships m JOIN conversation_records r ON r.conversation=m.conversation WHERE m.project=? AND r.id>? ORDER BY r.id LIMIT 32",
      )
      .all(project, after);
    const candidates = [
      ...new Map(
        [...primary, ...associated].map((row) => [Number(row.id), row]),
      ).values(),
    ]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(0, 32);
    let copied = 0,
      last = after;
    mirror.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of candidates) {
        const conversation = main
          .prepare("SELECT * FROM conversations WHERE id=?")
          .get(candidate.conversation!)!;
        const previous = mirror
          .prepare("SELECT * FROM conversations WHERE id=?")
          .get(candidate.conversation!);
        if (
          !previous ||
          previous.parent !== conversation.parent ||
          previous.session !== conversation.session ||
          previous.agent !== conversation.agent ||
          previous.kind !== conversation.kind ||
          previous.project !== conversation.project ||
          previous.job !== conversation.job
        ) {
          mirror
            .prepare(
              `INSERT INTO conversations VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,project=excluded.project,job=excluded.job,session=excluded.session,agent=excluded.agent,kind=excluded.kind`,
            )
            .run(
              conversation.id!,
              conversation.agent!,
              conversation.session!,
              conversation.parent!,
              conversation.project!,
              conversation.job!,
              conversation.kind!,
            );
        }
        const documentId = `durable:${candidate.id}`;
        mirror
          .prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)")
          .run(documentId, "project", project);
        for (const tag of main
          .prepare(
            "SELECT type,value FROM history_tags WHERE id=? AND type IN ('session','job')",
          )
          .all(documentId))
          mirror
            .prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)")
            .run(documentId, tag.type!, tag.value!);
        const docMeta = main
          .prepare("SELECT session FROM history_documents WHERE id=?")
          .get(documentId);
        const alias = docMeta?.session
          ? main
              .prepare("SELECT * FROM history_sessions WHERE alias=?")
              .get(docMeta.session)
          : null;
        if (alias)
          mirror
            .prepare(
              "INSERT INTO history_sessions VALUES(?,?,?) ON CONFLICT(alias) DO UPDATE SET session=excluded.session,job=excluded.job WHERE history_sessions.session IS NOT excluded.session OR history_sessions.job IS NOT excluded.job",
            )
            .run(alias.alias!, alias.session!, alias.job!);
        if (
          mirror
            .prepare("SELECT id FROM conversation_records WHERE id=?")
            .get(candidate.id!)
        ) {
          last = Number(candidate.id);
          continue;
        }
        if (copied >= 8) break;
        const row = main
          .prepare("SELECT * FROM conversation_records WHERE id=?")
          .get(candidate.id!)!;
        mirror
          .prepare(
            "INSERT OR IGNORE INTO conversation_records VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            row.id!,
            row.source!,
            row.generation!,
            row.offset!,
            row.conversation!,
            row.at!,
            row.raw!,
            row.body!,
            row.part!,
          );
        const doc = main
          .prepare("SELECT * FROM history_documents WHERE id=?")
          .get(`durable:${row.id}`);
        if (doc) {
          mirror
            .prepare(
              "INSERT OR IGNORE INTO history_documents(id,kind,agent,at,body,folded,link,message,job,run,session,cursor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              doc.id!,
              doc.kind!,
              doc.agent!,
              doc.at!,
              doc.body!,
              doc.folded!,
              doc.link!,
              doc.message!,
              doc.job!,
              doc.run!,
              doc.session!,
              doc.cursor!,
            );
        }
        copied++;
        last = Number(row.id);
      }
      // Cycle metadata IDs, never reread unchanged bodies. Late project associations are recovered.
      mirror
        .prepare("UPDATE mirror_cursor SET value=? WHERE id=1")
        .run(candidates.length ? last : 0);
      mirror.exec("COMMIT");
    } catch (err) {
      mirror.exec("ROLLBACK");
      throw err;
    }
    // A metadata-only page is still work to drain. Only the empty page wraps the cursor to zero.
    onPending?.(candidates.length > 0);
    return copied;
  } finally {
    mirror.close();
  }
}
