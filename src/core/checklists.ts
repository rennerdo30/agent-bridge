import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { existingMetadataDb, metadataDb } from "./metadata-db.js";
import { canonicalProjectRoot, physicalPath, projectKey } from "./project-identity.js";
import { BridgeError } from "./protocol.js";
import { storageLease } from "./storage-lock.js";

/**
 * AB-428: job checklists owned by the bridge. bridge.db is the single source of truth; only agent-bridge's MCP tools
 * change it. Two additive tables, never deleted from: a removed or rejected item keeps its row with a status or a
 * removal time.
 * - job_checklist: one row per item of a job (keyed by the job's name, so continuations keep their state). Ids c1, c2, ...
 *   Source: project (the project checklist at spawn), parent (the supervisor) or job (an approved proposal).
 * - project_checklist: the project's definition of done, keyed by the canonical project identity (the project group key:
 *   physical path, linked worktrees share the main checkout, case-insensitive on Windows). Ids p1, p2, ...
 */
export const CHECKLIST_LIMITS = { items: 50, rows: 200, projectItems: 30, projectRows: 200, text: 300, note: 500, proposals: 10, batch: 50 } as const;
/** States a job sets itself. */
export const JOB_ITEM_STATUSES = ["in_progress", "done", "blocked", "skipped"] as const;
export type JobItemStatus = typeof JOB_ITEM_STATUSES[number];
export type ChecklistStatus = "open" | JobItemStatus | "proposed" | "rejected" | "closed";
/** Items that count: everything but pending proposals, rejected proposals and items the supervisor closed. */
const ACTIVE = new Set<ChecklistStatus>(["open", "in_progress", "done", "blocked", "skipped"]);

export interface ChecklistItem {
  id: string;
  text: string;
  required: boolean;
  source: "project" | "parent" | "job";
  status: ChecklistStatus;
  note: string;
  /** A proposal's reason. */
  why: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}
export interface ProjectChecklistItem { id: string; text: string; required: boolean; createdAt: number; updatedAt: number; updatedBy: string; removedAt: number | null }
export interface ChecklistInput { text: string; required?: boolean }
export interface ChecklistSummary { total: number; done: number; skipped: number; blocked: number; inProgress: number; open: number; requiredOpen: number; proposed: number }
export interface SupervisorChange {
  add?: ChecklistInput[];
  edit?: { id: string; text?: string; required?: boolean }[];
  require?: string[];
  unrequire?: string[];
  close?: string[];
  approve?: string[];
  reject?: string[];
  note?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS job_checklist (
 job TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, required INTEGER NOT NULL,
 source TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', why TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
 supervisor_rev INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(job, id)
);
CREATE TABLE IF NOT EXISTS project_checklist (
 project TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, required INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, removed_at INTEGER,
 PRIMARY KEY(project, id)
);
INSERT INTO bridge_components(name, version) VALUES ('checklists', 1) ON CONFLICT(name) DO NOTHING;
`;
const prepared = new WeakSet<DatabaseSync>();

const bad = (message: string): never => { throw new BridgeError("bad_request", message); };

/** One line of plain text: control, format (zero-width, bidi marks and overrides, BOM) and line separator characters become spaces; whitespace collapses. */
export function sanitizeChecklistText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim();
}
function cleanText(value: string, what: string, max: number, allowEmpty = false): string {
  const text = sanitizeChecklistText(String(value ?? ""));
  if (!text && !allowEmpty) bad(`${what} is empty.`);
  if (text.length > max) bad(`${what} has ${text.length} characters; at most ${max} are allowed.`);
  return text;
}

/** The project checklist's key for a working directory: the canonical project identity, alias spellings included. */
export function projectChecklistKey(cwd: string): string | null {
  if (!cwd) return null;
  const root = canonicalProjectRoot(cwd);
  if (root) return projectKey(root);
  try { return projectKey(physicalPath(resolve(cwd))); } catch { return null; }
}

function transaction<T>(home: string, db: DatabaseSync, work: () => T): T {
  const release = storageLease(home);
  try {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  } finally { release(); }
}
function writable(home: string): DatabaseSync {
  const db = metadataDb(home);
  if (!prepared.has(db)) { transaction(home, db, () => db.exec(SCHEMA)); prepared.add(db); }
  return db;
}
/** Reads never create the store or its tables. */
function readable(home: string): DatabaseSync | undefined {
  const db = existingMetadataDb(home);
  if (!db) return undefined;
  if (prepared.has(db)) return db;
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_checklist'").get() ? (prepared.add(db), db) : undefined;
}

const toItem = (row: Record<string, unknown>): ChecklistItem => ({
  id: String(row.id), text: String(row.text), required: Number(row.required) === 1, source: String(row.source) as ChecklistItem["source"],
  status: String(row.status) as ChecklistStatus, note: String(row.note ?? ""), why: String(row.why ?? ""),
  createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), updatedBy: String(row.updated_by),
});
const jobRows = (db: DatabaseSync, job: string): ChecklistItem[] =>
  db.prepare("SELECT * FROM job_checklist WHERE job=? ORDER BY seq").all(job).map(toItem);

export function readJobChecklist(home: string, job: string): ChecklistItem[] {
  const db = readable(home);
  return db ? jobRows(db, job) : [];
}

/** Changes made by the supervisor (not the job's own ticks): a job's server compares it to show changes at its next step. */
export function supervisorRevision(home: string, job: string): string {
  const db = readable(home);
  if (!db) return "0:0";
  const row = db.prepare("SELECT MAX(supervisor_rev) AS rev, COUNT(*) AS n FROM job_checklist WHERE job=? AND supervisor_rev>0").get(job);
  return `${Number(row?.rev ?? 0)}:${Number(row?.n ?? 0)}`;
}

function insertItems(db: DatabaseSync, job: string, items: { text: string; required: boolean; source: ChecklistItem["source"]; status: ChecklistStatus; why?: string }[],
  by: string, now: number, supervisorRev: number): ChecklistItem[] {
  const existing = jobRows(db, job);
  if (existing.length + items.length > CHECKLIST_LIMITS.rows) bad(`A job keeps at most ${CHECKLIST_LIMITS.rows} checklist rows.`);
  let seq = existing.reduce((max, item) => Math.max(max, Number(item.id.slice(1)) || 0), 0);
  const insert = db.prepare(`INSERT INTO job_checklist (job,id,seq,text,required,source,status,note,why,created_at,updated_at,updated_by,supervisor_rev)
    VALUES (?,?,?,?,?,?,?,'',?,?,?,?,?)`);
  const added: ChecklistItem[] = [];
  for (const item of items) {
    seq++;
    insert.run(job, `c${seq}`, seq, item.text, item.required ? 1 : 0, item.source, item.status, item.why ?? "", now, now, by, supervisorRev);
    added.push({ id: `c${seq}`, text: item.text, required: item.required, source: item.source, status: item.status, note: "", why: item.why ?? "", createdAt: now, updatedAt: now, updatedBy: by });
  }
  const active = jobRows(db, job).filter(i => ACTIVE.has(i.status) || i.status === "proposed").length;
  if (active > CHECKLIST_LIMITS.items) bad(`A job's checklist has at most ${CHECKLIST_LIMITS.items} items, proposals included.`);
  return added;
}

/** Validated, one-line items; throws a bad_request before anything is stored. */
export function cleanChecklistInputs(items: readonly ChecklistInput[], defaultRequired = true): { text: string; required: boolean }[] {
  if (items.length > CHECKLIST_LIMITS.items) bad(`A checklist has at most ${CHECKLIST_LIMITS.items} items.`);
  return items.map(item => ({ text: cleanText(item.text, "A checklist item", CHECKLIST_LIMITS.text), required: item.required ?? defaultRequired }));
}

/**
 * The checklist a new job starts with: the project checklist (unless "none"), then the supervisor's items (required
 * unless required=false). A job that already has a checklist keeps it (a continuation never resets its state).
 */
export function seedJobChecklist(home: string, job: string, input: readonly ChecklistInput[] | "none" | undefined, project: string | null, by: string): ChecklistItem[] {
  const parent = input === "none" ? [] : cleanChecklistInputs(input ?? [], true);
  if (input !== "none" && !parent.length && !project) return readJobChecklist(home, job);
  const projectItems = input === "none" || !project ? [] : readProjectChecklist(home, project);
  if (!parent.length && !projectItems.length) return readJobChecklist(home, job);
  const db = writable(home);
  return transaction(home, db, () => {
    if (jobRows(db, job).length) return jobRows(db, job);
    insertItems(db, job, [
      ...projectItems.map(item => ({ text: item.text, required: item.required, source: "project" as const, status: "open" as const })),
      ...parent.map(item => ({ ...item, source: "parent" as const, status: "open" as const })),
    ], by, Date.now(), 0);
    return jobRows(db, job);
  });
}

function requireIds(items: ChecklistItem[], ids: readonly string[], allowed: (item: ChecklistItem) => boolean, what: string): ChecklistItem[] {
  if (ids.length > CHECKLIST_LIMITS.batch) bad(`At most ${CHECKLIST_LIMITS.batch} items per call.`);
  return ids.map(id => {
    const item = items.find(i => i.id === id);
    if (!item) bad(`No checklist item ${JSON.stringify(id)}.`);
    if (!allowed(item!)) bad(`${item!.id} is ${item!.status}: it cannot be ${what}.`);
    return item!;
  });
}

/** The job's own ticks. A job never adds, deletes or un-requires items; a required item is skipped only with a note. */
export function updateJobChecklistAsJob(home: string, job: string, updates: readonly { id: string; status: JobItemStatus; note?: string }[]): { items: ChecklistItem[]; blocked: ChecklistItem[] } {
  if (!updates.length) return { items: readJobChecklist(home, job), blocked: [] };
  const db = writable(home);
  return transaction(home, db, () => {
    const items = jobRows(db, job);
    const targets = requireIds(items, updates.map(u => u.id), i => ACTIVE.has(i.status), "updated by the job");
    const now = Date.now(), blocked: ChecklistItem[] = [];
    const update = db.prepare("UPDATE job_checklist SET status=?, note=?, updated_at=?, updated_by=? WHERE job=? AND id=?");
    updates.forEach((u, index) => {
      if (!(JOB_ITEM_STATUSES as readonly string[]).includes(u.status)) bad(`A job sets in_progress, done, blocked or skipped, not ${JSON.stringify(u.status)}.`);
      const item = targets[index]!;
      const note = u.note === undefined ? item.note : cleanText(u.note, "A note", CHECKLIST_LIMITS.note, true);
      if (u.status === "skipped" && item.required && !note) bad(`${item.id} is required: skipping it needs a note saying why.`);
      if (u.status === "blocked" && item.status !== "blocked") blocked.push({ ...item, status: "blocked", note });
      update.run(u.status, note, now, job, job, item.id);
    });
    return { items: jobRows(db, job), blocked };
  });
}

/** A job's proposals: stored as "proposed" until the supervisor approves or rejects them. */
export function proposeJobChecklist(home: string, job: string, proposals: readonly { text: string; why?: string }[]): { items: ChecklistItem[]; proposed: ChecklistItem[] } {
  if (!proposals.length) return { items: readJobChecklist(home, job), proposed: [] };
  const clean = proposals.map(p => ({ text: cleanText(p.text, "A proposed item", CHECKLIST_LIMITS.text), why: p.why === undefined ? "" : cleanText(p.why, "A reason", CHECKLIST_LIMITS.note, true) }));
  const db = writable(home);
  return transaction(home, db, () => {
    const pending = jobRows(db, job).filter(i => i.status === "proposed").length;
    if (pending + clean.length > CHECKLIST_LIMITS.proposals) bad(`At most ${CHECKLIST_LIMITS.proposals} proposals can wait for the supervisor at once.`);
    const proposed = insertItems(db, job, clean.map(p => ({ ...p, required: false, source: "job" as const, status: "proposed" as const })), job, Date.now(), 0);
    return { items: jobRows(db, job), proposed };
  });
}

/** The supervisor's changes, applied together or not at all. */
export function superviseJobChecklist(home: string, job: string, change: SupervisorChange, by: string): ChecklistItem[] {
  const db = writable(home);
  return transaction(home, db, () => {
    const now = Date.now(), note = change.note === undefined ? undefined : cleanText(change.note, "A note", CHECKLIST_LIMITS.note, true);
    const set = (id: string, fields: Record<string, string | number>) => {
      const keys = Object.keys(fields);
      db.prepare(`UPDATE job_checklist SET ${keys.map(k => `${k}=?`).join(", ")}, updated_at=?, updated_by=?, supervisor_rev=? WHERE job=? AND id=?`)
        .run(...keys.map(k => fields[k]!), now, by, now, job, id);
    };
    const current = () => jobRows(db, job);
    const changeable = (i: ChecklistItem) => ACTIVE.has(i.status) || i.status === "proposed";
    for (const edit of change.edit ?? []) {
      if (edit.text === undefined && edit.required === undefined) bad(`Edit of ${edit.id} changes nothing: give text, required or both.`);
      const [item] = requireIds(current(), [edit.id], changeable, "edited");
      set(item!.id, { ...(edit.text !== undefined ? { text: cleanText(edit.text, "A checklist item", CHECKLIST_LIMITS.text) } : {}), ...(edit.required !== undefined ? { required: edit.required ? 1 : 0 } : {}) });
    }
    for (const item of requireIds(current(), change.require ?? [], changeable, "required")) set(item.id, { required: 1 });
    for (const item of requireIds(current(), change.unrequire ?? [], changeable, "made optional")) set(item.id, { required: 0 });
    for (const item of requireIds(current(), change.close ?? [], i => ACTIVE.has(i.status), "closed")) set(item.id, { status: "closed", ...(note !== undefined ? { note } : {}) });
    for (const item of requireIds(current(), change.approve ?? [], i => i.status === "proposed", "approved")) set(item.id, { status: "open", ...(note !== undefined ? { note } : {}) });
    for (const item of requireIds(current(), change.reject ?? [], i => i.status === "proposed", "rejected")) set(item.id, { status: "rejected", ...(note !== undefined ? { note } : {}) });
    if (change.add?.length) insertItems(db, job, cleanChecklistInputs(change.add, true).map(i => ({ ...i, source: "parent" as const, status: "open" as const })), by, now, now);
    return current();
  });
}

const toProjectItem = (row: Record<string, unknown>): ProjectChecklistItem => ({
  id: String(row.id), text: String(row.text), required: Number(row.required) === 1, createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at), updatedBy: String(row.updated_by), removedAt: row.removed_at === null ? null : Number(row.removed_at),
});
const projectRows = (db: DatabaseSync, project: string): ProjectChecklistItem[] =>
  db.prepare("SELECT * FROM project_checklist WHERE project=? ORDER BY seq").all(project).map(toProjectItem);

/** The project's definition of done; withRemoved also lists removed items (their rows are kept). */
export function readProjectChecklist(home: string, project: string, withRemoved = false): ProjectChecklistItem[] {
  const db = readable(home);
  if (!db) return [];
  const rows = projectRows(db, project);
  return withRemoved ? rows : rows.filter(row => row.removedAt === null);
}

/** set replaces the active items (the old ones are marked removed), add appends, remove marks items removed. */
export function changeProjectChecklist(home: string, project: string, change: { set?: ChecklistInput[]; add?: ChecklistInput[]; remove?: string[] }, by: string): ProjectChecklistItem[] {
  const set = change.set ? cleanChecklistInputs(change.set, true) : undefined, add = cleanChecklistInputs(change.add ?? [], true);
  const db = writable(home);
  return transaction(home, db, () => {
    const now = Date.now();
    const remove = db.prepare("UPDATE project_checklist SET removed_at=?, updated_at=?, updated_by=? WHERE project=? AND id=? AND removed_at IS NULL");
    for (const id of change.remove ?? []) {
      if (!projectRows(db, project).some(row => row.id === id && row.removedAt === null)) bad(`No project checklist item ${JSON.stringify(id)}.`);
      remove.run(now, now, by, project, id);
    }
    if (set) for (const row of projectRows(db, project)) if (row.removedAt === null) remove.run(now, now, by, project, row.id);
    const rows = projectRows(db, project), items = [...set ?? [], ...add];
    if (rows.length + items.length > CHECKLIST_LIMITS.projectRows) bad(`A project keeps at most ${CHECKLIST_LIMITS.projectRows} checklist rows.`);
    if (rows.filter(row => row.removedAt === null).length + items.length > CHECKLIST_LIMITS.projectItems) bad(`A project checklist has at most ${CHECKLIST_LIMITS.projectItems} items.`);
    let seq = rows.reduce((max, row) => Math.max(max, Number(row.id.slice(1)) || 0), 0);
    const insert = db.prepare("INSERT INTO project_checklist (project,id,seq,text,required,created_at,updated_at,updated_by,removed_at) VALUES (?,?,?,?,?,?,?,?,NULL)");
    for (const item of items) { seq++; insert.run(project, `p${seq}`, seq, item.text, item.required ? 1 : 0, now, now, by); }
    return projectRows(db, project).filter(row => row.removedAt === null);
  });
}

export function checklistSummary(items: readonly ChecklistItem[]): ChecklistSummary {
  const count = (status: ChecklistStatus) => items.filter(i => i.status === status).length;
  return {
    total: items.filter(i => ACTIVE.has(i.status) && i.status !== "skipped").length, done: count("done"), skipped: count("skipped"),
    blocked: count("blocked"), inProgress: count("in_progress"), open: count("open"), proposed: count("proposed"),
    requiredOpen: items.filter(i => i.required && (i.status === "open" || i.status === "in_progress" || i.status === "blocked")).length,
  };
}
/** "3/5 done, 1 skipped, 1 blocked, 2 proposed". */
export function summaryText(s: ChecklistSummary): string {
  return [`${s.done}/${s.total} done`, s.skipped ? `${s.skipped} skipped` : "", s.blocked ? `${s.blocked} blocked` : "", s.proposed ? `${s.proposed} proposed` : ""].filter(Boolean).join(", ");
}
/** For peers: the summary plus open required items. */
export function peersChecklistText(s: ChecklistSummary): string {
  return `checklist ${summaryText(s)}${s.requiredOpen ? `; ${s.requiredOpen} required open` : ""}`;
}

/** One model-facing line; text and notes are JSON strings, so no item can break out of its line or quotes. */
export function formatChecklistItem(item: ChecklistItem): string {
  return `- ${item.id} [${item.status}] ${item.required ? "required" : "optional"}, ${item.source}: ${JSON.stringify(item.text)}` +
    (item.note ? ` (note: ${JSON.stringify(item.note)})` : "") + (item.status === "proposed" && item.why ? ` (why: ${JSON.stringify(item.why)})` : "");
}
/** The list a job works from: items that count and pending proposals; all=true adds closed and rejected items. */
export function formatChecklist(items: readonly ChecklistItem[], all = false): string {
  const shown = all ? items : items.filter(i => ACTIVE.has(i.status) || i.status === "proposed");
  return shown.length ? shown.map(formatChecklistItem).join("\n") : "(no items)";
}

const UPDATE_CALL = 'checklist({ update: [{ id: "c1", status: "done", note: "…" }] })';
const PROPOSE_CALL = 'checklist({ propose: [{ text: "…", why: "…" }] })';
/** The checklist section of a job's brief. */
export function checklistBrief(items: readonly ChecklistItem[], toolAvailable: boolean): string | null {
  if (!items.some(i => ACTIVE.has(i.status) || i.status === "proposed")) return null;
  const how = toolAvailable
    ? `Tick items as you go with the checklist tool of the agent-bridge MCP server: ${UPDATE_CALL}; status is in_progress, done, blocked or skipped. ` +
      "Skip a required item only with a note saying why. Marking an item blocked notifies your supervisor; other ticks are quiet. " +
      `If an item is missing, propose it: ${PROPOSE_CALL}; it joins only when your supervisor approves. You cannot add, delete or un-require items. `
    : "The checklist tool is not available in this run: report each item's state in your final message. ";
  const changes = toolAvailable ? "Your supervisor may change the list while you work: call checklist() to see changes. " : "";
  return `(agent-bridge checklist: your supervisor tracks this task with the checklist below. ${how}${changes}` +
    `Required items still open when you finish mark your result incomplete; it is reported, not blocked.\n${formatChecklist(items)})`;
}

/** The checklist section of a final report, or null without a checklist. */
export function checklistReport(items: readonly ChecklistItem[]): string | null {
  if (!items.some(i => ACTIVE.has(i.status) || i.status === "proposed")) return null;
  const s = checklistSummary(items);
  return [`Checklist: ${summaryText(s)}.`,
    s.requiredOpen ? `incomplete: ${s.requiredOpen} required item${s.requiredOpen === 1 ? "" : "s"} open` : "",
    formatChecklist(items)].filter(Boolean).join("\n");
}

/** Summaries and items of the named jobs that have a checklist (peers and the dashboard). Read-only, never creates the store. */
export function readChecklists(home: string, jobs: Iterable<string>): Map<string, { summary: ChecklistSummary; items: ChecklistItem[] }> {
  const names = [...new Set(jobs)].filter(Boolean);
  const out = new Map<string, { summary: ChecklistSummary; items: ChecklistItem[] }>();
  if (!names.length || !existsSync(join(resolve(home), "bridge.db"))) return out;
  try {
    const db = readable(home);
    if (!db) return out;
    for (let at = 0; at < names.length; at += 400) {
      const chunk = names.slice(at, at + 400);
      const grouped = new Map<string, ChecklistItem[]>();
      for (const row of db.prepare(`SELECT * FROM job_checklist WHERE job IN (${chunk.map(() => "?").join(",")}) ORDER BY job, seq`).all(...chunk)) {
        const job = String(row.job), list = grouped.get(job) ?? [];
        list.push(toItem(row)); grouped.set(job, list);
      }
      for (const [name, items] of grouped) if (items.some(i => ACTIVE.has(i.status) || i.status === "proposed")) out.set(name, { summary: checklistSummary(items), items });
    }
  } catch { /* Display only: a busy or older store shows no checklist rather than failing the listing. */ }
  return out;
}
