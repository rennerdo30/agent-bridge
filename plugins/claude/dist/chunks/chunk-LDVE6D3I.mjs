import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ResourceSlots
} from "./chunk-6JEBVQTD.mjs";
import {
  readArchivedJobSnapshot
} from "./chunk-KCELIZDL.mjs";
import {
  canonicalProjectRoot,
  external_exports,
  physicalPath,
  projectKey
} from "./chunk-7TGCOQY2.mjs";
import {
  AGENT_KINDS,
  BridgeError
} from "./chunk-IYJ5P7ML.mjs";
import {
  assertWritableStore,
  existingMetadataDb,
  isRecord,
  metadataDb,
  physicalMetadataPath,
  readJsonSnapshot,
  storageLease
} from "./chunk-RBBYN7QN.mjs";

// src/core/startup-admission.ts
import { randomUUID } from "node:crypto";
var STARTUP_CAPACITY = 2;
var STARTUP_RESOURCE = "delegate-startup";
var STARTUP_ROW_SEPARATOR = "~startup-";
async function acquireStartup(home, signal, job) {
  const slots = new ResourceSlots(home);
  const owner = { id: job ? `${job}${STARTUP_ROW_SEPARATOR}${randomUUID()}` : `startup-${randomUUID()}`, pid: process.pid };
  try {
    await slots.acquire(STARTUP_RESOURCE, STARTUP_CAPACITY, owner, signal);
  } catch (err) {
    slots.close();
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      slots.release(owner, STARTUP_RESOURCE);
    } finally {
      slots.close();
    }
  };
}

// src/core/checklists.ts
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
var CHECKLIST_LIMITS = { items: 50, rows: 200, projectItems: 30, projectRows: 200, text: 300, note: 500, proposals: 10, batch: 50 };
var JOB_ITEM_STATUSES = ["in_progress", "done", "blocked", "skipped"];
var ACTIVE = /* @__PURE__ */ new Set(["open", "in_progress", "done", "blocked", "skipped"]);
var itemSchema = external_exports.strictObject({ text: external_exports.string().min(1).max(CHECKLIST_LIMITS.text), required: external_exports.boolean().optional() });
var idsSchema = external_exports.array(external_exports.string().regex(/^c\d{1,4}$/)).min(1).max(CHECKLIST_LIMITS.batch);
var jobChecklistRequestSchema = external_exports.strictObject({
  job: external_exports.string().min(1).max(80),
  get: external_exports.boolean().optional(),
  add: external_exports.array(itemSchema).min(1).max(CHECKLIST_LIMITS.items).optional(),
  edit: external_exports.array(external_exports.strictObject({ id: external_exports.string().regex(/^c\d{1,4}$/), text: external_exports.string().min(1).max(CHECKLIST_LIMITS.text).optional(), required: external_exports.boolean().optional() })).min(1).max(CHECKLIST_LIMITS.batch).optional(),
  require: idsSchema.optional(),
  unrequire: idsSchema.optional(),
  close: idsSchema.optional(),
  approve: idsSchema.optional(),
  reject: idsSchema.optional(),
  note: external_exports.string().max(CHECKLIST_LIMITS.note).optional()
});
var changesJobChecklist = (change) => Boolean(change.add || change.edit || change.require || change.unrequire || change.close || change.approve || change.reject);
var authorityText = external_exports.string().min(1).refine((value) => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
var authorityPath = external_exports.string().refine(isAbsolute);
var positiveInteger = external_exports.number().int().positive().safe();
var authorityIdentity = external_exports.object({ id: authorityText, name: authorityText }).passthrough();
var authorityWorktree = external_exports.object({ repoRoot: authorityPath, path: authorityPath.optional(), cwd: authorityPath.optional() }).passthrough();
var checklistAuthoritySchema = authorityIdentity.extend({
  agent: external_exports.enum(AGENT_KINDS),
  startedAt: positiveInteger,
  metadataVersion: positiveInteger,
  sessionId: authorityText.nullable(),
  threadId: authorityText.nullable().optional(),
  owner: authorityText,
  supervisor: authorityText,
  rootName: authorityText,
  rootSession: authorityText,
  parentJob: authorityText.optional(),
  status: external_exports.enum(["running", "paused", "done", "failed", "cancelled", "interrupted"]),
  // Only explicit local absence markers are allowed. Falsy strings/numbers are unknown, not local.
  remote: external_exports.union([external_exports.null(), external_exports.literal(false)]).optional(),
  executionOwner: authorityText.optional(),
  masters: external_exports.array(authorityText).optional(),
  ownershipHistory: external_exports.array(external_exports.object({
    id: authorityText,
    at: positiveInteger,
    from: authorityText,
    to: authorityText,
    rootSession: authorityText,
    rootName: authorityText,
    fromRoot: authorityText.optional(),
    fromRootName: authorityText.optional()
  }).passthrough()).optional(),
  projectRoot: authorityPath.optional(),
  workdir: external_exports.string().nullable().optional(),
  worktree: authorityWorktree.nullable().optional(),
  args: external_exports.object({ cwd: external_exports.string().optional(), _worktree: authorityWorktree.optional(), host: external_exports.never().optional() }).passthrough().optional(),
  host: external_exports.object({ pid: positiveInteger.nullable(), peer: authorityText, startedAt: positiveInteger }).passthrough().nullable().optional()
});
function readChecklistAuthority(path, witness) {
  const identity = authorityIdentity.safeParse(witness);
  if (!witness || !identity.success) return void 0;
  const { id, name } = identity.data;
  try {
    const snapshot = readJsonSnapshot(path), data = snapshot.value;
    assertWritableStore(data);
    if (isRecord(data) && data.handoffs !== void 0 && !Array.isArray(data.handoffs)) return void 0;
    const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : void 0;
    if (!rows) return void 0;
    const ids = /* @__PURE__ */ new Set(), names = /* @__PURE__ */ new Set();
    const identified = [];
    for (const row of rows) {
      const parsed2 = authorityIdentity.safeParse(row);
      if (!parsed2.success || ids.has(parsed2.data.id) || names.has(parsed2.data.name)) return void 0;
      ids.add(parsed2.data.id);
      names.add(parsed2.data.name);
      identified.push(parsed2.data);
    }
    let selected = identified.filter((row) => row.id === id || row.name === name);
    const active = selected.length > 0;
    if (!active) selected = readArchivedJobSnapshot(path, {
      ids: /* @__PURE__ */ new Set([id]),
      names: /* @__PURE__ */ new Set([name])
    }).jobs;
    if (selected.length !== 1 || readJsonSnapshot(path).signature !== snapshot.signature) return void 0;
    const parsed = checklistAuthoritySchema.safeParse(selected[0]);
    if (!parsed.success) return void 0;
    const current = parsed.data;
    if (!active && (current.status === "running" || current.status === "paused")) return void 0;
    for (const key of ["id", "name", "agent", "startedAt", "sessionId", "threadId", "metadataVersion", "parentJob"]) {
      if (current[key] !== witness[key]) return void 0;
    }
    return current;
  } catch {
    return void 0;
  }
}
var SCHEMA = `
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
var prepared = /* @__PURE__ */ new WeakSet();
var bad = (message) => {
  throw new BridgeError("bad_request", message);
};
function sanitizeChecklistText(value) {
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim();
}
function cleanText(value, what, max, allowEmpty = false) {
  const text = sanitizeChecklistText(String(value ?? ""));
  if (!text && !allowEmpty) bad(`${what} is empty.`);
  if (text.length > max) bad(`${what} has ${text.length} characters; at most ${max} are allowed.`);
  return text;
}
function projectChecklistKey(cwd) {
  if (!cwd) return null;
  const root = canonicalProjectRoot(cwd);
  if (root) return projectKey(root);
  try {
    return projectKey(physicalPath(resolve(cwd)));
  } catch {
    return null;
  }
}
function transaction(home, db, work) {
  const release = storageLease(home);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    release();
  }
}
function writable(home) {
  const db = metadataDb(home);
  if (!prepared.has(db)) {
    transaction(home, db, () => db.exec(SCHEMA));
    prepared.add(db);
  }
  return db;
}
function readable(home) {
  const db = existingMetadataDb(home);
  if (!db) return void 0;
  if (prepared.has(db)) return db;
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_checklist'").get() ? (prepared.add(db), db) : void 0;
}
var toItem = (row) => ({
  id: String(row.id),
  text: String(row.text),
  required: Number(row.required) === 1,
  source: String(row.source),
  status: String(row.status),
  note: String(row.note ?? ""),
  why: String(row.why ?? ""),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  updatedBy: String(row.updated_by)
});
var jobRows = (db, job) => db.prepare("SELECT * FROM job_checklist WHERE job=? ORDER BY seq").all(job).map(toItem);
function readJobChecklist(home, job) {
  const db = readable(home);
  return db ? jobRows(db, job) : [];
}
function supervisorRevision(home, job) {
  const db = readable(home);
  if (!db) return "0:0";
  const row = db.prepare("SELECT MAX(supervisor_rev) AS rev, COUNT(*) AS n FROM job_checklist WHERE job=? AND supervisor_rev>0").get(job);
  return `${Number(row?.rev ?? 0)}:${Number(row?.n ?? 0)}`;
}
function insertItems(db, job, items, by, now, supervisorRev) {
  const existing = jobRows(db, job);
  if (existing.length + items.length > CHECKLIST_LIMITS.rows) bad(`A job keeps at most ${CHECKLIST_LIMITS.rows} checklist rows.`);
  let seq = existing.reduce((max, item) => Math.max(max, Number(item.id.slice(1)) || 0), 0);
  const insert = db.prepare(`INSERT INTO job_checklist (job,id,seq,text,required,source,status,note,why,created_at,updated_at,updated_by,supervisor_rev)
    VALUES (?,?,?,?,?,?,?,'',?,?,?,?,?)`);
  const added = [];
  for (const item of items) {
    seq++;
    insert.run(job, `c${seq}`, seq, item.text, item.required ? 1 : 0, item.source, item.status, item.why ?? "", now, now, by, supervisorRev);
    added.push({ id: `c${seq}`, text: item.text, required: item.required, source: item.source, status: item.status, note: "", why: item.why ?? "", createdAt: now, updatedAt: now, updatedBy: by });
  }
  const active = jobRows(db, job).filter((i) => ACTIVE.has(i.status) || i.status === "proposed").length;
  if (active > CHECKLIST_LIMITS.items) bad(`A job's checklist has at most ${CHECKLIST_LIMITS.items} items, proposals included.`);
  return added;
}
function cleanChecklistInputs(items, defaultRequired = true) {
  if (items.length > CHECKLIST_LIMITS.items) bad(`A checklist has at most ${CHECKLIST_LIMITS.items} items.`);
  return items.map((item) => ({ text: cleanText(item.text, "A checklist item", CHECKLIST_LIMITS.text), required: item.required ?? defaultRequired }));
}
function seedJobChecklist(home, job, input, project, by, projectSnapshot) {
  const parent = input === "none" ? [] : cleanChecklistInputs(input ?? [], true);
  if (input !== "none" && !parent.length && !project) return readJobChecklist(home, job);
  const projectItems = input === "none" || !project ? [] : projectSnapshot ?? readProjectChecklist(home, project);
  if (!parent.length && !projectItems.length) return readJobChecklist(home, job);
  const db = writable(home);
  return transaction(home, db, () => {
    if (jobRows(db, job).length) return jobRows(db, job);
    insertItems(db, job, [
      ...projectItems.map((item) => ({ text: item.text, required: item.required, source: "project", status: "open" })),
      ...parent.map((item) => ({ ...item, source: "parent", status: "open" }))
    ], by, Date.now(), 0);
    return jobRows(db, job);
  });
}
function requireIds(items, ids, allowed, what) {
  if (ids.length > CHECKLIST_LIMITS.batch) bad(`At most ${CHECKLIST_LIMITS.batch} items per call.`);
  return ids.map((id) => {
    const item = items.find((i) => i.id === id);
    if (!item) bad(`No checklist item ${JSON.stringify(id)}.`);
    if (!allowed(item)) bad(`${item.id} is ${item.status}: it cannot be ${what}.`);
    return item;
  });
}
function changeJobChecklistAsJob(home, job, change) {
  const updates = change.update ?? [], proposals = change.propose ?? [];
  if (!updates.length && !proposals.length) return { items: readJobChecklist(home, job), blocked: [], proposed: [] };
  const clean = proposals.map((p) => ({ text: cleanText(p.text, "A proposed item", CHECKLIST_LIMITS.text), why: p.why === void 0 ? "" : cleanText(p.why, "A reason", CHECKLIST_LIMITS.note, true) }));
  const db = writable(home);
  return transaction(home, db, () => {
    const items = jobRows(db, job);
    const targets = requireIds(items, updates.map((u) => u.id), (i) => ACTIVE.has(i.status), "updated by the job");
    const now = Date.now(), blocked = [];
    const update = db.prepare("UPDATE job_checklist SET status=?, note=?, updated_at=?, updated_by=? WHERE job=? AND id=?");
    updates.forEach((u, index) => {
      if (!JOB_ITEM_STATUSES.includes(u.status)) bad(`A job sets in_progress, done, blocked or skipped, not ${JSON.stringify(u.status)}.`);
      const item = targets[index];
      const note = u.note === void 0 ? item.note : cleanText(u.note, "A note", CHECKLIST_LIMITS.note, true);
      if (u.status === "skipped" && item.required && !note) bad(`${item.id} is required: skipping it needs a note saying why.`);
      if (u.status === "blocked" && item.status !== "blocked") blocked.push({ ...item, status: "blocked", note });
      update.run(u.status, note, now, job, job, item.id);
    });
    const pending = items.filter((i) => i.status === "proposed").length;
    if (pending + clean.length > CHECKLIST_LIMITS.proposals) bad(`At most ${CHECKLIST_LIMITS.proposals} proposals can wait for the supervisor at once.`);
    const proposed = clean.length ? insertItems(db, job, clean.map((p) => ({ ...p, required: false, source: "job", status: "proposed" })), job, now, 0) : [];
    return { items: jobRows(db, job), blocked, proposed };
  });
}
function accessJobChecklist(home, job, change, by, authorize) {
  if (changesJobChecklist(change)) return superviseJobChecklist(home, job, change, by, authorize);
  authorize();
  const db = readable(home);
  if (!db) return [];
  return transaction(home, db, () => {
    authorize();
    return jobRows(db, job);
  });
}
function superviseJobChecklist(home, job, change, by, authorize) {
  authorize?.();
  const db = writable(home);
  return transaction(home, db, () => {
    authorize?.();
    const now = Date.now(), note = change.note === void 0 ? void 0 : cleanText(change.note, "A note", CHECKLIST_LIMITS.note, true);
    const set = (id, fields) => {
      const keys = Object.keys(fields);
      db.prepare(`UPDATE job_checklist SET ${keys.map((k) => `${k}=?`).join(", ")}, updated_at=?, updated_by=?, supervisor_rev=? WHERE job=? AND id=?`).run(...keys.map((k) => fields[k]), now, by, now, job, id);
    };
    const current = () => jobRows(db, job);
    const changeable = (i) => ACTIVE.has(i.status) || i.status === "proposed";
    for (const edit of change.edit ?? []) {
      if (edit.text === void 0 && edit.required === void 0) bad(`Edit of ${edit.id} changes nothing: give text, required or both.`);
      const [item] = requireIds(current(), [edit.id], changeable, "edited");
      set(item.id, { ...edit.text !== void 0 ? { text: cleanText(edit.text, "A checklist item", CHECKLIST_LIMITS.text) } : {}, ...edit.required !== void 0 ? { required: edit.required ? 1 : 0 } : {} });
    }
    for (const item of requireIds(current(), change.require ?? [], changeable, "required")) set(item.id, { required: 1 });
    for (const item of requireIds(current(), change.unrequire ?? [], changeable, "made optional")) set(item.id, { required: 0 });
    for (const item of requireIds(current(), change.close ?? [], (i) => ACTIVE.has(i.status), "closed")) set(item.id, { status: "closed", ...note !== void 0 ? { note } : {} });
    for (const item of requireIds(current(), change.approve ?? [], (i) => i.status === "proposed", "approved")) set(item.id, { status: "open", ...note !== void 0 ? { note } : {} });
    for (const item of requireIds(current(), change.reject ?? [], (i) => i.status === "proposed", "rejected")) set(item.id, { status: "rejected", ...note !== void 0 ? { note } : {} });
    if (change.add?.length) insertItems(db, job, cleanChecklistInputs(change.add, true).map((i) => ({ ...i, source: "parent", status: "open" })), by, now, now);
    return current();
  });
}
var toProjectItem = (row) => ({
  id: String(row.id),
  text: String(row.text),
  required: Number(row.required) === 1,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  updatedBy: String(row.updated_by),
  removedAt: row.removed_at === null ? null : Number(row.removed_at)
});
var projectRows = (db, project) => db.prepare("SELECT * FROM project_checklist WHERE project=? ORDER BY seq").all(project).map(toProjectItem);
function readProjectChecklist(home, project, withRemoved = false) {
  const db = readable(home);
  if (!db) return [];
  const rows = projectRows(db, project);
  return withRemoved ? rows : rows.filter((row) => row.removedAt === null);
}
function changeProjectChecklist(home, project, change, by) {
  const set = change.set ? cleanChecklistInputs(change.set, true) : void 0, add = cleanChecklistInputs(change.add ?? [], true);
  const db = writable(home);
  return transaction(home, db, () => {
    const now = Date.now();
    const remove = db.prepare("UPDATE project_checklist SET removed_at=?, updated_at=?, updated_by=? WHERE project=? AND id=? AND removed_at IS NULL");
    for (const id of change.remove ?? []) {
      if (!projectRows(db, project).some((row) => row.id === id && row.removedAt === null)) bad(`No project checklist item ${JSON.stringify(id)}.`);
      remove.run(now, now, by, project, id);
    }
    if (set) {
      for (const row of projectRows(db, project)) if (row.removedAt === null) remove.run(now, now, by, project, row.id);
    }
    const rows = projectRows(db, project), items = [...set ?? [], ...add];
    if (rows.length + items.length > CHECKLIST_LIMITS.projectRows) bad(`A project keeps at most ${CHECKLIST_LIMITS.projectRows} checklist rows.`);
    if (rows.filter((row) => row.removedAt === null).length + items.length > CHECKLIST_LIMITS.projectItems) bad(`A project checklist has at most ${CHECKLIST_LIMITS.projectItems} items.`);
    let seq = rows.reduce((max, row) => Math.max(max, Number(row.id.slice(1)) || 0), 0);
    const insert = db.prepare("INSERT INTO project_checklist (project,id,seq,text,required,created_at,updated_at,updated_by,removed_at) VALUES (?,?,?,?,?,?,?,?,NULL)");
    for (const item of items) {
      seq++;
      insert.run(project, `p${seq}`, seq, item.text, item.required ? 1 : 0, now, now, by);
    }
    return projectRows(db, project).filter((row) => row.removedAt === null);
  });
}
function checklistSummary(items) {
  const count = (status) => items.filter((i) => i.status === status).length;
  return {
    total: items.filter((i) => ACTIVE.has(i.status) && i.status !== "skipped").length,
    done: count("done"),
    skipped: count("skipped"),
    blocked: count("blocked"),
    inProgress: count("in_progress"),
    open: count("open"),
    proposed: count("proposed"),
    requiredOpen: items.filter((i) => i.required && (i.status === "open" || i.status === "in_progress" || i.status === "blocked")).length
  };
}
function summaryText(s) {
  return [`${s.done}/${s.total} done`, s.skipped ? `${s.skipped} skipped` : "", s.blocked ? `${s.blocked} blocked` : "", s.proposed ? `${s.proposed} proposed` : ""].filter(Boolean).join(", ");
}
function peersChecklistText(s) {
  return `checklist ${summaryText(s)}${s.requiredOpen ? `; ${s.requiredOpen} required open` : ""}`;
}
function formatChecklistItem(item) {
  return `- ${item.id} [${item.status}] ${item.required ? "required" : "optional"}, ${item.source}: ${JSON.stringify(item.text)}` + (item.note ? ` (note: ${JSON.stringify(item.note)})` : "") + (item.status === "proposed" && item.why ? ` (why: ${JSON.stringify(item.why)})` : "");
}
function formatChecklist(items, all = false) {
  const shown = all ? items : items.filter((i) => ACTIVE.has(i.status) || i.status === "proposed");
  return shown.length ? shown.map(formatChecklistItem).join("\n") : "(no items)";
}
var UPDATE_CALL = 'checklist({ update: [{ id: "c1", status: "done", note: "\u2026" }] })';
var PROPOSE_CALL = 'checklist({ propose: [{ text: "\u2026", why: "\u2026" }] })';
function checklistBrief(items, toolAvailable) {
  if (!items.some((i) => ACTIVE.has(i.status) || i.status === "proposed")) return null;
  const how = toolAvailable ? `Tick items as you go with the checklist tool of the agent-bridge MCP server: ${UPDATE_CALL}; status is in_progress, done, blocked or skipped. Skip a required item only with a note saying why. Marking an item blocked notifies your supervisor; other ticks are quiet. If an item is missing, propose it: ${PROPOSE_CALL}; it joins only when your supervisor approves. You cannot add, delete or un-require items. ` : "The checklist tool is not available in this run: report each item's state in your final message. ";
  const changes = toolAvailable ? "Your supervisor may change the list while you work: call checklist() to see changes. " : "";
  return `(agent-bridge checklist: your supervisor tracks this task with the checklist below. ${how}${changes}Required items still open when you finish mark your result incomplete; it is reported, not blocked.
${formatChecklist(items)})`;
}
function checklistReport(items) {
  if (!items.some((i) => ACTIVE.has(i.status) || i.status === "proposed")) return null;
  const s = checklistSummary(items);
  return [
    `Checklist: ${summaryText(s)}.`,
    s.requiredOpen ? `incomplete: ${s.requiredOpen} required item${s.requiredOpen === 1 ? "" : "s"} open` : "",
    formatChecklist(items)
  ].filter(Boolean).join("\n");
}
var projections = /* @__PURE__ */ new Map();
function projectionSignature(file) {
  return [file, `${file}-wal`].map((path) => {
    try {
      const s = statSync(path, { bigint: true });
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch (error) {
      if (error.code === "ENOENT") return "-";
      throw error;
    }
  }).join("/");
}
function readChecklists(home, jobs) {
  const names = [...new Set(jobs)].filter(Boolean).sort();
  const out = /* @__PURE__ */ new Map();
  if (!names.length) return out;
  const file = join(resolve(home), "bridge.db"), requested = JSON.stringify(names);
  let db;
  try {
    const signature = projectionSignature(file), saved = projections.get(file);
    if (saved?.signature === signature && saved.names === requested) return structuredClone(saved.value);
    physicalMetadataPath(file);
    if (!signature.startsWith("-/")) {
      db = new DatabaseSync(file, { readOnly: true, timeout: 1e3 });
      db.exec("BEGIN");
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bridge_components','job_checklist','project_checklist')").all();
      const admitted = tables.length === 3 && Number(db.prepare("SELECT version FROM bridge_components WHERE name='checklists'").get()?.version) === 1;
      for (let at = 0; admitted && at < names.length; at += 400) {
        const chunk = names.slice(at, at + 400);
        const grouped = /* @__PURE__ */ new Map();
        for (const row of db.prepare(`SELECT * FROM job_checklist WHERE job IN (${chunk.map(() => "?").join(",")}) ORDER BY job, seq`).all(...chunk)) {
          const job = String(row.job), list = grouped.get(job) ?? [];
          list.push(toItem(row));
          grouped.set(job, list);
        }
        for (const [name, items] of grouped) if (items.some((i) => ACTIVE.has(i.status) || i.status === "proposed")) out.set(name, { summary: checklistSummary(items), items });
      }
      db.exec("COMMIT");
    }
    if (projectionSignature(file) === signature) {
      projections.delete(file);
      projections.set(file, { signature, names: requested, value: structuredClone(out) });
      if (projections.size > 8) projections.delete(projections.keys().next().value);
    }
  } catch {
  } finally {
    db?.close();
  }
  return out;
}

export {
  STARTUP_CAPACITY,
  STARTUP_RESOURCE,
  STARTUP_ROW_SEPARATOR,
  acquireStartup,
  CHECKLIST_LIMITS,
  JOB_ITEM_STATUSES,
  jobChecklistRequestSchema,
  readChecklistAuthority,
  projectChecklistKey,
  readJobChecklist,
  supervisorRevision,
  cleanChecklistInputs,
  seedJobChecklist,
  changeJobChecklistAsJob,
  accessJobChecklist,
  readProjectChecklist,
  changeProjectChecklist,
  checklistSummary,
  summaryText,
  peersChecklistText,
  formatChecklist,
  checklistBrief,
  checklistReport,
  readChecklists
};
