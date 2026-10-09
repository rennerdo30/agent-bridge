import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MAX_NETWORK_FRAME_BYTES,
  NETWORK_NAME_PATTERN,
  OWNER_DIR_MODE,
  OWNER_FILE_MODE
} from "./chunk-S5K6II4C.mjs";
import {
  AGENT_KINDS,
  TRANSFER_PROGRESS_PREFIX
} from "./chunk-L3WJOWYS.mjs";
import {
  external_exports
} from "./chunk-RVGYULDQ.mjs";

// src/network/files.ts
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { basename, join, parse, resolve, sep } from "node:path";
var MAX_TRANSFER_BYTES = 1024 * 1024;
var MAX_TRANSFER_ENTRIES = 128;
var MAX_TRANSFER_DEPTH = 16;
var MAX_PATH_CHARS = 1024;
var MAX_COMPONENT_CHARS = 255;
var MAX_ID_CHARS = 128;
var MAX_BASE64_CHARS = Math.ceil(MAX_TRANSFER_BYTES / 3) * 4;
var pathSchema = external_exports.string().min(1).max(MAX_PATH_CHARS);
var entrySchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("directory"), path: pathSchema }),
  external_exports.object({ kind: external_exports.literal("file"), path: pathSchema, data: external_exports.string().max(MAX_BASE64_CHARS), sha256: external_exports.string().regex(/^[0-9a-f]{64}$/) })
]);
var transferSchema = external_exports.object({
  id: external_exports.uuid(),
  to: external_exports.string().regex(NETWORK_NAME_PATTERN),
  from: external_exports.object({ id: external_exports.string().min(1).max(MAX_ID_CHARS), name: external_exports.string().regex(NETWORK_NAME_PATTERN), agent: external_exports.enum(AGENT_KINDS) }),
  entries: external_exports.array(entrySchema).min(1).max(MAX_TRANSFER_ENTRIES)
});
var transferResultSchema = external_exports.object({ id: external_exports.uuid(), inbox: external_exports.string().max(MAX_PATH_CHARS), files: external_exports.number().int().nonnegative().max(MAX_TRANSFER_ENTRIES), bytes: external_exports.number().int().nonnegative().max(MAX_TRANSFER_BYTES) });
function checksum(data) {
  return createHash("sha256").update(data).digest("hex");
}
function assertTransferPath(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new Error("file transfer does not follow symlinks or junctions");
  }
}
function ensureTransferDirectory(path) {
  if (!existsSync(path)) {
    const parent = resolve(path, "..");
    ensureTransferDirectory(parent);
    mkdirSync(path, { mode: OWNER_DIR_MODE });
  }
  assertTransferPath(path);
  if (!lstatSync(path).isDirectory()) throw new Error("transfer directory is not a directory");
}
function safeTransferPath(path) {
  const components = path.split("/");
  return path.length <= MAX_PATH_CHARS && components.length <= MAX_TRANSFER_DEPTH && components.every((part) => part.length > 0 && part.length <= MAX_COMPONENT_CHARS && part !== "." && part !== ".." && !/[<>:"\\|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part));
}
function collectTransfer(paths, cwd, to, from) {
  if (!paths.length || paths.length > MAX_TRANSFER_ENTRIES) throw new Error("invalid number of transfer paths");
  const entries = [];
  let bytes = 0;
  const walk = (source, path) => {
    if (!safeTransferPath(path)) throw new Error("unsafe or too deep transfer path");
    if (entries.length >= MAX_TRANSFER_ENTRIES) throw new Error("too many transfer entries");
    assertTransferPath(source);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error("file transfer does not follow symlinks or junctions");
    if (stat.isDirectory()) {
      entries.push({ kind: "directory", path });
      for (const name of readdirSync(source).sort()) walk(join(source, name), `${path}/${name}`);
    } else if (stat.isFile()) {
      if (stat.size > MAX_TRANSFER_BYTES - bytes) throw new Error("transfer exceeds size limit");
      const data = readFileSync(source);
      bytes += data.length;
      if (bytes > MAX_TRANSFER_BYTES) throw new Error("transfer exceeds size limit");
      entries.push({ kind: "file", path, data: data.toString("base64"), sha256: checksum(data) });
    } else throw new Error("only regular files and directories can be transferred");
  };
  for (const path of paths) {
    const source = resolve(cwd, path);
    walk(source, basename(source));
  }
  const transfer = transferSchema.parse({ id: randomUUID(), to, from, entries });
  validateEntries(transfer);
  return transfer;
}
function validateEntries(transfer) {
  const kinds = /* @__PURE__ */ new Map();
  let bytes = 0;
  let files = 0;
  const entries = transfer.entries.map((entry) => {
    const path = entry.path;
    const key = path.toLowerCase();
    if (!safeTransferPath(path) || kinds.has(key)) throw new Error("unsafe or duplicate transfer path");
    kinds.set(key, entry.kind);
    if (entry.kind === "directory") return { path, data: null };
    const data = Buffer.from(entry.data, "base64");
    if (data.toString("base64") !== entry.data || checksum(data) !== entry.sha256) throw new Error("file checksum or encoding mismatch");
    bytes += data.length;
    files++;
    if (bytes > MAX_TRANSFER_BYTES) throw new Error("transfer exceeds size limit");
    return { path, data };
  });
  for (const entry of entries) {
    const parts = entry.path.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) if (kinds.get(parts.slice(0, i).join("/")) !== "directory") throw new Error("missing directory or file used as parent");
  }
  return { entries, bytes, files };
}
function receiveTransfer(home, input) {
  const transfer = transferSchema.parse(input);
  const { entries, bytes, files } = validateEntries(transfer);
  assertTransferPath(home);
  const disk = statfsSync(home, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(bytes)) throw new Error("insufficient free disk space for transfer");
  const inbox = join(home, "inbox");
  ensureTransferDirectory(inbox);
  if (lstatSync(inbox).isSymbolicLink()) throw new Error("inbox cannot be a symlink");
  assertTransferPath(inbox);
  const final = join(inbox, transfer.id);
  if (existsSync(final)) throw new Error("transfer already received");
  const staging = mkdtempSync(join(inbox, ".partial-"));
  try {
    for (const entry of entries.filter((e) => e.data === null).sort((a, b) => a.path.length - b.path.length)) mkdirSync(join(staging, ...entry.path.split("/")), { mode: OWNER_DIR_MODE });
    for (const entry of entries) if (entry.data !== null) writeFileSync(join(staging, ...entry.path.split("/")), entry.data, { flag: "wx", mode: OWNER_FILE_MODE });
    renameSync(staging, final);
    return { id: transfer.id, inbox: final, files, bytes };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

// src/network/transfers.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { constants, existsSync as existsSync2, lstatSync as lstatSync2, mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { open, link, unlink, statfs, lstat, opendir } from "node:fs/promises";
import { basename as basename2, dirname, isAbsolute, join as join2, relative, resolve as resolve2, sep as sep2 } from "node:path";
var FILE_STREAM_CAPABILITY = "file-stream-v1";
var FILE_STREAM_WINDOW_CAPABILITY = "file-stream-window-v1";
var TRANSFER_CHUNK_BYTES = 256 * 1024;
var TRANSFER_WINDOW_CHUNKS = 8;
var DEFAULT_MAX_STREAM_BYTES = 8 * 1024 * 1024 * 1024;
var MAX_STREAM_ENTRIES = 4096;
var MAX_ACTIVE_TRANSFERS = 4;
var MAX_TRANSFER_HISTORY = 200;
var TRANSFER_REQUEST_TIMEOUT_MS = 3e4;
var TRANSFER_HEARTBEAT_MS = 5e3;
var TRANSFER_RETRY_MS = 2e3;
var TRANSFER_PROGRESS_MS = 1e3;
var SHA_RECORD_BYTES = 65;
var MAX_PATH_CHARS2 = 1024;
var MAX_SENDER_ID_CHARS = 128;
var MAX_ERROR_CHARS = 512;
var MIN_TRANSFER_FREE_BYTES = 16 * 1024 * 1024;
var SHA_PATTERN = /^[0-9a-f]{64}$/;
var RETRYABLE_TRANSFER_ERROR = /^(network link closed|network write limit reached|paired instance is not connected|file transfer request timed out|sender not advertised by paired instance|file (source peer|recipient|sender) is not online|transfer operation already in progress|too many active file transfers)$/;
var TERMINAL = /* @__PURE__ */ new Set(["completed", "cancelled", "failed"]);
var senderSchema = external_exports.object({ id: external_exports.string().min(1).max(MAX_SENDER_ID_CHARS), name: external_exports.string().regex(NETWORK_NAME_PATTERN), agent: external_exports.enum(AGENT_KINDS) });
var entrySchema2 = external_exports.object({ path: external_exports.string().min(1).max(MAX_PATH_CHARS2), kind: external_exports.enum(["file", "directory"]), size: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
var base = { id: external_exports.uuid(), rid: external_exports.uuid(), kind: external_exports.literal("request") };
var fileStreamRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ ...base, op: external_exports.literal("offer"), from: senderSchema, to: external_exports.string().regex(NETWORK_NAME_PATTERN), entries: external_exports.array(entrySchema2).min(1).max(MAX_STREAM_ENTRIES) }),
  external_exports.object({ ...base, op: external_exports.literal("chunk"), index: external_exports.number().int().nonnegative().max(MAX_STREAM_ENTRIES - 1), offset: external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), data: external_exports.string().max(Math.ceil(TRANSFER_CHUNK_BYTES / 3) * 4), sha256: external_exports.string().regex(SHA_PATTERN) }),
  external_exports.object({ ...base, op: external_exports.literal("finish-file"), index: external_exports.number().int().nonnegative().max(MAX_STREAM_ENTRIES - 1), sha256: external_exports.string().regex(SHA_PATTERN) }),
  external_exports.object({ ...base, op: external_exports.literal("finish") }),
  external_exports.object({ ...base, op: external_exports.literal("cancel") }),
  external_exports.object({ ...base, op: external_exports.literal("abort"), error: external_exports.string().min(1).max(MAX_ERROR_CHARS) }),
  external_exports.object({ ...base, op: external_exports.literal("fetch"), from: senderSchema, source: external_exports.string().regex(NETWORK_NAME_PATTERN), paths: external_exports.array(external_exports.string().min(1).max(MAX_PATH_CHARS2)).min(1).max(MAX_STREAM_ENTRIES) })
]);
var responseSchema = external_exports.object({ kind: external_exports.literal("response"), rid: external_exports.uuid(), id: external_exports.uuid(), error: external_exports.string().max(MAX_ERROR_CHARS).optional(), data: external_exports.object({ offsets: external_exports.array(external_exports.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).max(MAX_STREAM_ENTRIES).optional(), status: external_exports.enum(["queued", "preparing", "running", "paused", "completed", "cancelled", "failed"]).optional() }).default({}) });
var RemoteTransferError = class extends Error {
};
function digest(data) {
  return createHash2("sha256").update(data).digest("hex");
}
function transferSummary(home, state) {
  const bytes = state.entries.reduce((sum, entry) => sum + entry.offset, 0);
  return {
    id: state.id,
    direction: state.direction,
    peer: state.peer,
    status: state.status,
    bytes,
    totalBytes: state.totalBytes,
    files: state.entries.filter((entry) => entry.kind === "file" && entry.complete).length,
    totalFiles: state.entries.filter((entry) => entry.kind === "file").length,
    percent: state.status === "completed" ? 100 : state.totalBytes ? Math.floor(bytes / state.totalBytes * 100) : 0,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...state.direction === "receive" ? { inbox: join2(home, "inbox", state.id) } : {},
    ...state.error ? { error: state.error } : {}
  };
}
function persistTransfer(root, state) {
  assertTransferPath(root);
  state.updatedAt = Date.now();
  const file = join2(root, `${state.id}.json`);
  if (existsSync2(file)) assertTransferPath(file);
  const temp = `${file}.${randomUUID2()}.tmp`;
  writeFileSync2(temp, JSON.stringify(state), { flag: "wx", mode: OWNER_FILE_MODE, flush: true });
  renameSync2(temp, file);
}
function cancelStoredTransfer(home, id) {
  external_exports.uuid().parse(id);
  const root = join2(home, "network", "transfers");
  const path = join2(root, `${id}.json`);
  if (!existsSync2(path)) throw new Error("unknown transfer");
  assertTransferPath(path);
  const state = JSON.parse(readFileSync2(path, "utf8"));
  if (state.version !== 1 || state.id !== id) throw new Error("invalid persisted transfer");
  if (state.status === "completed" || state.status === "failed" || state.legacySent) return { id, cancelled: false };
  state.status = "cancelled";
  state.cancelPending = !state.legacy;
  persistTransfer(root, state);
  return { id, cancelled: true };
}
function readTransferHistory(home) {
  const root = join2(home, "network", "transfers");
  if (!existsSync2(root)) return [];
  assertTransferPath(root);
  return readdirSync2(root).filter((file) => /^[0-9a-f-]{36}\.json$/.test(file)).map((file) => {
    const path = join2(root, file);
    assertTransferPath(path);
    return { path, mtime: statSync(path).mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_TRANSFER_HISTORY).map(({ path }) => {
    const state = JSON.parse(readFileSync2(path, "utf8"));
    if (state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > MAX_STREAM_ENTRIES) throw new Error("invalid persisted transfer");
    return transferSummary(home, state);
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}
function allowedFetchPath(path, cwd, roots) {
  const source = resolve2(cwd, path);
  assertTransferPath(source);
  if (!roots.some((root) => {
    if (!isAbsolute(root)) return false;
    assertTransferPath(root);
    const rel = relative(resolve2(root), source);
    return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep2}`);
  })) throw new Error("fetch is disabled or path is outside allowed fetch roots");
  return source;
}
async function writeAll(file, data, position) {
  let written = 0;
  while (written < data.length) {
    const result = await file.write(data, written, data.length - written, position + written);
    if (!result.bytesWritten) throw new Error("file write made no progress");
    written += result.bytesWritten;
  }
}
var TransferManager = class {
  constructor(home, transport, log, options = {}) {
    this.home = home;
    this.transport = transport;
    this.log = log;
    this.options = options;
    assertTransferPath(home);
    this.root = join2(home, "network", "transfers");
    ensureTransferDirectory(this.root);
    assertTransferPath(this.root);
    for (const file of readdirSync2(this.root).filter((file2) => /^[0-9a-f-]{36}\.json$/.test(file2))) {
      const state = this.read(file.slice(0, -5));
      if (state && (!TERMINAL.has(state.status) || state.cancelPending || state.abortPending)) {
        if (this.states.size >= MAX_ACTIVE_TRANSFERS) {
          this.log.warn("transfer recovery limit reached", { id: state.id });
          continue;
        }
        state.status = TERMINAL.has(state.status) ? state.status : "paused";
        this.save(state);
      }
    }
    this.timer = setInterval(() => this.resume(), TRANSFER_RETRY_MS);
    this.timer.unref();
  }
  home;
  transport;
  log;
  options;
  states = /* @__PURE__ */ new Map();
  active = /* @__PURE__ */ new Set();
  receiving = /* @__PURE__ */ new Set();
  receiveQueues = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  notified = /* @__PURE__ */ new Map();
  timer;
  closed = false;
  root;
  read(id) {
    const file = join2(this.root, `${id}.json`);
    if (!existsSync2(file)) return void 0;
    assertTransferPath(file);
    const state = JSON.parse(readFileSync2(file, "utf8"));
    if (state.version !== 1 || state.id !== id || !Array.isArray(state.entries) || state.entries.length > MAX_STREAM_ENTRIES) throw new Error("invalid persisted transfer");
    return state;
  }
  get(id) {
    return this.states.get(id) ?? this.read(id);
  }
  save(state) {
    persistTransfer(this.root, state);
    if (!TERMINAL.has(state.status) || state.cancelPending || state.abortPending) this.states.set(state.id, state);
    else this.states.delete(state.id);
  }
  summary(state) {
    return transferSummary(this.home, state);
  }
  list() {
    return readTransferHistory(this.home);
  }
  recordLegacy(transfer, remote, peer) {
    const entries = transfer.entries.map((entry) => ({
      kind: entry.kind,
      path: entry.path,
      size: entry.kind === "file" ? Buffer.byteLength(entry.data, "base64") : 0,
      offset: entry.kind === "file" ? Buffer.byteLength(entry.data, "base64") : 0,
      complete: true,
      ...entry.kind === "file" ? { sha256: entry.sha256 } : {}
    }));
    this.save({
      version: 1,
      id: transfer.id,
      direction: "receive",
      remote,
      peer,
      from: transfer.from,
      to: transfer.to,
      paths: [],
      cwd: "",
      entries,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      status: "completed",
      legacy: true,
      initialized: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }
  report(state, force = false) {
    if (this.closed) return;
    const now = Date.now();
    if (!force && now - (this.notified.get(state.id) ?? 0) < TRANSFER_PROGRESS_MS) return;
    this.notified.set(state.id, now);
    const progress = this.summary(state);
    this.log.info("file transfer progress", { ...progress });
    const recipient = state.direction === "send" ? state.from.name : state.to;
    const from = state.direction === "receive" ? { ...state.from, id: `${state.remote}/${state.from.id}`, name: `${state.peer.split("/")[0]}/${state.from.name}` } : { id: `files-${state.id}`, name: "files", agent: "other" };
    this.transport.notify({
      id: state.direction === "receive" && state.status === "completed" ? state.id : randomUUID2(),
      from,
      to: recipient,
      recipient,
      conversationId: TERMINAL.has(state.status) ? state.id : `${TRANSFER_PROGRESS_PREFIX}${state.id}`,
      replyTo: null,
      hop: 0,
      createdAt: now,
      readAt: null,
      body: `files: ${progress.percent}% \xB7 ${progress.bytes} / ${progress.totalBytes} bytes \xB7 ${state.status} \xB7 ${state.id}${progress.inbox ? ` \xB7 ${progress.inbox}` : ""}${state.error ? ` \xB7 ${state.error}` : ""}`
    });
    if (TERMINAL.has(state.status)) this.notified.delete(state.id);
  }
  ensureCapacity() {
    if (this.states.size >= MAX_ACTIVE_TRANSFERS) throw new Error("too many active file transfers");
  }
  start(remote, peer, to, paths, cwd, from, pull = false, id = randomUUID2(), legacy = false) {
    this.ensureCapacity();
    const state = {
      version: 1,
      id,
      direction: pull ? "receive" : "send",
      remote,
      peer,
      to,
      paths,
      cwd,
      from,
      status: "queued",
      entries: [],
      totalBytes: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...pull ? { pull: true } : {},
      ...legacy ? { legacy: true } : {}
    };
    this.save(state);
    this.report(state, true);
    setImmediate(() => this.resume());
    return { id, status: "queued" };
  }
  resume() {
    if (this.closed) return;
    for (const state of this.states.values()) {
      if (this.active.has(state.id) || !state.legacy && !this.transport.supports(state.remote)) continue;
      if (state.cancelPending || state.abortPending) {
        this.active.add(state.id);
        void this.rpc(state.remote, state.id, state.cancelPending ? { op: "cancel" } : { op: "abort", error: state.error ?? "transfer failed" }).then(() => {
          state.cancelPending = false;
          state.abortPending = false;
          this.save(state);
        }).catch(() => {
        }).finally(() => this.active.delete(state.id));
      } else if (!TERMINAL.has(state.status) && (state.direction === "send" || state.pull && !state.entries.length)) {
        this.active.add(state.id);
        void this.run(state).finally(() => this.active.delete(state.id));
      }
    }
  }
  disconnected(remote) {
    for (const [rid, pending] of this.pending) if (pending.remote === remote) {
      clearTimeout(pending.timer);
      this.pending.delete(rid);
      pending.reject(new Error("network link closed"));
    }
    for (const state of this.states.values()) if (state.remote === remote && !TERMINAL.has(state.status)) {
      state.status = "paused";
      this.save(state);
      this.report(state, true);
    }
  }
  rpc(remote, id, fields) {
    if (this.closed) return Promise.reject(new Error("transfer manager closed"));
    const rid = randomUUID2();
    return new Promise((resolve3, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error("file transfer request timed out"));
      }, TRANSFER_REQUEST_TIMEOUT_MS);
      this.pending.set(rid, { remote, id, resolve: resolve3, reject, timer });
      void Promise.resolve().then(() => this.transport.send(remote, { kind: "request", rid, id, ...fields })).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(error);
      });
    });
  }
  async handle(payload, remote, remoteName) {
    if (payload.kind === "heartbeat") {
      const heartbeat2 = external_exports.object({ id: external_exports.uuid(), rid: external_exports.uuid() }).parse(payload);
      const pending = this.pending.get(heartbeat2.rid);
      if (pending?.remote === remote && pending.id === heartbeat2.id) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          this.pending.delete(heartbeat2.rid);
          pending.reject(new Error("file transfer request timed out"));
        }, TRANSFER_REQUEST_TIMEOUT_MS);
      }
      return;
    }
    if (payload.kind === "response") {
      const response = responseSchema.parse(payload);
      const pending = this.pending.get(response.rid);
      if (!pending || pending.remote !== remote || pending.id !== response.id) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.rid);
      if (response.error) pending.reject(new RemoteTransferError(response.error));
      else pending.resolve(response.data);
      return;
    }
    const request = fileStreamRequestSchema.parse(payload);
    let data = {};
    let error;
    let heartbeatSending = false;
    const heartbeat = setInterval(() => {
      if (this.closed || heartbeatSending) return;
      heartbeatSending = true;
      void Promise.resolve().then(() => this.transport.send(remote, { kind: "heartbeat", rid: request.rid, id: request.id })).catch(() => {
      }).finally(() => {
        heartbeatSending = false;
      });
    }, TRANSFER_HEARTBEAT_MS);
    heartbeat.unref();
    const key = `${remote}/${request.id}`;
    const queue = this.receiveQueues.get(key) ?? { tail: Promise.resolve(), count: 0 };
    if (queue.count >= TRANSFER_WINDOW_CHUNKS + 2) {
      clearInterval(heartbeat);
      throw new Error("too many queued file transfer operations");
    }
    const previous = queue.tail;
    let release;
    queue.tail = new Promise((resolve3) => {
      release = resolve3;
    });
    queue.count++;
    this.receiveQueues.set(key, queue);
    try {
      await previous;
      data = await this.receive(request, remote, remoteName);
    } catch (err) {
      error = err.message.slice(0, MAX_ERROR_CHARS);
      this.log.warn("file transfer rejected", { id: request.id, remote, error });
      const state = this.get(request.id);
      if (state?.remote === remote && state.direction === "receive" && !TERMINAL.has(state.status) && /checksum|encoding mismatch|insufficient free disk|invalid initial|EACCES|ENOSPC|EEXIST|ENOENT|symlinks or junctions/.test(error)) {
        state.status = "failed";
        state.error = error;
        this.save(state);
        this.report(state, true);
      }
    } finally {
      clearInterval(heartbeat);
      release();
      if (--queue.count === 0) this.receiveQueues.delete(key);
    }
    await this.transport.send(remote, { kind: "response", rid: request.rid, id: request.id, data, ...error ? { error } : {} });
  }
  validateEntries(entries) {
    const kinds = /* @__PURE__ */ new Map();
    let total = 0;
    for (const entry of entries) {
      const key = entry.path.toLowerCase();
      if (!safeTransferPath(entry.path) || kinds.has(key)) throw new Error("unsafe or duplicate transfer path");
      kinds.set(key, entry.kind);
      if (entry.kind === "directory" && entry.size !== 0) throw new Error("invalid directory size");
      total += entry.size;
      if (!Number.isSafeInteger(total) || total > (this.options.maxBytes ?? DEFAULT_MAX_STREAM_BYTES)) throw new Error("transfer exceeds size limit");
    }
    for (const key of kinds.keys()) {
      const parts = key.split("/");
      for (let i = 1; i < parts.length; i++) if (kinds.get(parts.slice(0, i).join("/")) !== "directory") throw new Error("missing directory or file used as parent");
    }
    if (Buffer.byteLength(JSON.stringify(entries.map(({ path, kind, size }) => ({ path, kind, size })))) > MAX_NETWORK_FRAME_BYTES / 2) throw new Error("transfer manifest exceeds network frame limit");
    return total;
  }
  async collect(state) {
    const entries = [];
    let total = 0;
    const walk = async (source, path) => {
      if (this.closed || state.status === "cancelled") throw new Error("transfer cancelled");
      if (!safeTransferPath(path) || path.split("/").length > MAX_TRANSFER_DEPTH || entries.length >= MAX_STREAM_ENTRIES) throw new Error("unsafe or too many transfer entries");
      assertTransferPath(source);
      const st = await lstat(source);
      if (st.isDirectory()) {
        entries.push({ kind: "directory", path, size: 0, offset: 0 });
        const dir = await opendir(source);
        const names = [];
        for await (const child of dir) {
          if (names.length + entries.length >= MAX_STREAM_ENTRIES) throw new Error("too many transfer entries");
          names.push(child.name);
        }
        for (const name of names.sort()) await walk(join2(source, name), `${path}/${name}`);
      } else if (st.isFile()) {
        total += st.size;
        if (total > (this.options.maxBytes ?? DEFAULT_MAX_STREAM_BYTES)) throw new Error("transfer exceeds size limit");
        entries.push({ kind: "file", path, size: st.size, offset: 0, source, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev });
      } else throw new Error("only regular files and directories can be transferred");
    };
    for (const path of state.paths) {
      const source = resolve2(state.cwd, path);
      await walk(source, basename2(source));
    }
    this.validateEntries(entries);
    return entries;
  }
  async source(state, entry) {
    if (state.fetched) allowedFetchPath(entry.source, state.cwd, this.options.fetchRoots ?? []);
    assertTransferPath(entry.source);
    const file = await open(entry.source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const st = await file.stat();
      if (!st.isFile() || st.size !== entry.size || st.mtimeMs !== entry.mtimeMs || st.ino !== entry.ino || st.dev !== entry.dev) throw new RemoteTransferError("source file changed since transfer started");
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  stopped(state) {
    return state.status === "cancelled" || state.status === "failed" || this.closed;
  }
  async run(state) {
    try {
      if (state.direction === "send" || state.pull) {
        const sender = this.transport.localPeer(state.from.name);
        if (!sender) throw new Error("file sender is not online");
        if (sender.agent !== state.from.agent) throw new RemoteTransferError("file sender agent changed");
        state.from = { id: sender.id, name: sender.name, agent: sender.agent };
      }
      if (state.fetched) for (const path of state.paths) allowedFetchPath(path, state.cwd, this.options.fetchRoots ?? []);
      if (state.legacy) {
        if (state.legacySent) throw new RemoteTransferError("legacy transfer interrupted; delivery may have occurred");
        state.status = "running";
        const transfer = { ...collectTransfer(state.paths, state.cwd, state.to, state.from), id: state.id };
        state.entries = transfer.entries.map((entry) => ({ kind: entry.kind, path: entry.path, size: entry.kind === "file" ? Buffer.byteLength(entry.data, "base64") : 0, offset: 0 }));
        state.totalBytes = this.validateEntries(state.entries);
        state.legacySent = true;
        this.save(state);
        const result = await this.transport.legacy(state.remote, transfer);
        if (this.stopped(state)) return;
        state.status = "completed";
        for (const entry of state.entries) {
          entry.offset = entry.size;
          entry.complete = true;
        }
        this.save(state);
        this.report(state, true);
        this.log.info("legacy file transfer complete", result);
        return;
      }
      if (state.pull && !state.entries.length) {
        await this.rpc(state.remote, state.id, { op: "fetch", from: state.from, source: state.to, paths: state.paths });
        if (!TERMINAL.has(state.status) && !state.entries.length) {
          state.status = "paused";
          this.save(state);
        }
        return;
      }
      if (!state.entries.length) {
        state.status = "preparing";
        this.save(state);
        state.entries = await this.collect(state);
        state.totalBytes = this.validateEntries(state.entries);
        this.save(state);
      }
      if (this.stopped(state)) return;
      const reply = await this.rpc(state.remote, state.id, { op: "offer", from: state.from, to: state.to, entries: state.entries.map(({ path, kind, size }) => ({ path, kind, size })) });
      if (this.stopped(state)) return;
      if (reply.status === "completed") {
        state.status = "completed";
        for (const entry of state.entries) {
          entry.offset = entry.size;
          entry.complete = true;
        }
        this.save(state);
        this.report(state, true);
        return;
      }
      if (!reply.offsets || reply.offsets.length !== state.entries.length) throw new RemoteTransferError("invalid resume offsets");
      state.status = "running";
      delete state.error;
      this.save(state);
      this.report(state, true);
      for (let index = 0; index < state.entries.length; index++) {
        const entry = state.entries[index];
        if (entry.kind !== "file") continue;
        const offset = reply.offsets[index];
        if (offset > entry.size || offset !== entry.size && offset % TRANSFER_CHUNK_BYTES !== 0) throw new RemoteTransferError("invalid resume offset");
        entry.offset = offset;
        const file = await this.source(state, entry);
        const hash = createHash2("sha256");
        const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES);
        const window = Math.max(1, Math.min(TRANSFER_WINDOW_CHUNKS, this.transport.window?.(state.remote) ?? 1));
        const inFlight = [];
        let acknowledgements = 0;
        const acknowledge = async () => {
          const result = await inFlight.shift();
          if (result.error) throw result.error;
          if (this.stopped(state)) return;
          entry.offset = result.end;
          if (++acknowledgements % window === 0 || entry.offset === entry.size) this.save(state);
          this.report(state);
        };
        try {
          for (let position = 0; position < entry.size; ) {
            if (this.stopped(state)) return;
            const length = Math.min(TRANSFER_CHUNK_BYTES, entry.size - position);
            const { bytesRead } = await file.read(buffer, 0, length, position);
            if (bytesRead !== length) throw new RemoteTransferError("source file changed while reading");
            const chunk = buffer.subarray(0, length);
            hash.update(chunk);
            if (position >= offset) {
              const end = position + length;
              inFlight.push(this.rpc(state.remote, state.id, { op: "chunk", index, offset: position, data: chunk.toString("base64"), sha256: digest(chunk) }).then(() => ({ end }), (error) => ({ end, error })));
              if (inFlight.length >= window) await acknowledge();
            }
            position += length;
          }
          while (inFlight.length) await acknowledge();
          const st = await file.stat();
          if (st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) throw new RemoteTransferError("source file changed while reading");
        } finally {
          await Promise.all(inFlight);
          await file.close();
        }
        entry.sha256 = hash.digest("hex");
        await this.rpc(state.remote, state.id, { op: "finish-file", index, sha256: entry.sha256 });
        if (this.stopped(state)) return;
        entry.complete = true;
        this.save(state);
      }
      await this.rpc(state.remote, state.id, { op: "finish" });
      if (!this.stopped(state)) {
        state.status = "completed";
        this.save(state);
        this.report(state, true);
      }
    } catch (error) {
      if (this.stopped(state)) return;
      state.status = state.legacy || !RETRYABLE_TRANSFER_ERROR.test(error.message) ? "failed" : "paused";
      state.error = error.message.slice(0, MAX_ERROR_CHARS);
      state.abortPending = state.status === "failed" && !state.legacy;
      this.save(state);
      this.report(state, true);
    }
  }
  part(state, index) {
    return join2(this.root, state.id, `${index}.part`);
  }
  verified(state, index) {
    return join2(this.root, state.id, `${index}.verified`);
  }
  target(state, entry) {
    return join2(this.home, "inbox", state.id, ...entry.path.split("/"));
  }
  async freeDisk(bytes) {
    const disk = await statfs(this.home, { bigint: true });
    const reserved = [...this.states.values()].filter((state) => state.direction === "receive" && !TERMINAL.has(state.status)).reduce((sum, state) => sum + BigInt(state.totalBytes) - BigInt(this.summary(state).bytes) + BigInt(Math.ceil(state.totalBytes / TRANSFER_CHUNK_BYTES)) * BigInt(SHA_RECORD_BYTES) + BigInt(MAX_NETWORK_FRAME_BYTES), 0n);
    if (disk.bavail * disk.bsize < BigInt(bytes + MIN_TRANSFER_FREE_BYTES) + reserved) throw new Error("insufficient free disk space for transfer");
  }
  async hashFile(path, state) {
    assertTransferPath(path);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const hash = createHash2("sha256");
    const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES);
    try {
      for (; ; ) {
        if (this.closed || state && this.stopped(state)) throw new Error("transfer cancelled or manager closed");
        const { bytesRead } = await file.read(buffer);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await file.close();
    }
    return hash.digest("hex");
  }
  async recover(state, entry, index) {
    if (entry.kind !== "file") return;
    const target = this.target(state, entry);
    if (entry.complete || entry.sha256 && existsSync2(target)) {
      if (await this.hashFile(target, state) !== entry.sha256) throw new Error("completed file checksum mismatch");
      entry.complete = true;
      entry.offset = entry.size;
      const part = this.part(state, index);
      if (existsSync2(part)) {
        assertTransferPath(part);
        await unlink(part);
      }
      const verified2 = this.verified(state, index);
      if (existsSync2(verified2)) {
        assertTransferPath(verified2);
        await unlink(verified2);
      }
      return;
    }
    const verifiedPath = this.verified(state, index);
    if (entry.sha256 && existsSync2(verifiedPath)) {
      if (await this.hashFile(verifiedPath, state) !== entry.sha256) throw new Error("verified file checksum mismatch");
      assertTransferPath(dirname(target));
      await link(verifiedPath, target);
      await unlink(verifiedPath);
      entry.complete = true;
      entry.offset = entry.size;
      return;
    }
    const path = this.part(state, index);
    assertTransferPath(path);
    assertTransferPath(`${path}.sha256`);
    const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    let journal;
    const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES);
    const record = Buffer.alloc(SHA_RECORD_BYTES);
    let verified = 0;
    let chunks = 0;
    try {
      journal = await open(`${path}.sha256`, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      while (verified < entry.offset) {
        if (this.stopped(state)) throw new Error("transfer cancelled or manager closed");
        const length = Math.min(TRANSFER_CHUNK_BYTES, entry.size - verified);
        const a = await file.read(buffer, 0, length, verified);
        const b = await journal.read(record, 0, SHA_RECORD_BYTES, chunks * SHA_RECORD_BYTES);
        if (a.bytesRead !== length || b.bytesRead !== SHA_RECORD_BYTES || record.toString() !== `${digest(buffer.subarray(0, length))}
`) break;
        verified += length;
        chunks++;
      }
      await file.truncate(verified);
      await journal.truncate(chunks * SHA_RECORD_BYTES);
      await file.sync();
      await journal.sync();
      entry.offset = verified;
    } finally {
      try {
        await file.close();
      } finally {
        await journal?.close();
      }
    }
  }
  initialize(state) {
    const inbox = join2(this.home, "inbox");
    ensureTransferDirectory(inbox);
    const final = join2(inbox, state.id);
    const parts = join2(this.root, state.id);
    for (const dir of [final, parts]) {
      if (!existsSync2(dir)) mkdirSync2(dir, { mode: OWNER_DIR_MODE });
      assertTransferPath(dir);
      if (!lstatSync2(dir).isDirectory()) throw new Error("transfer directory is not a directory");
    }
    for (const entry of state.entries.filter((entry2) => entry2.kind === "directory").sort((a, b) => a.path.length - b.path.length)) {
      const dir = this.target(state, entry);
      assertTransferPath(dirname(dir));
      if (!existsSync2(dir)) mkdirSync2(dir, { mode: OWNER_DIR_MODE });
      assertTransferPath(dir);
      if (!lstatSync2(dir).isDirectory()) throw new Error("transfer directory is not a directory");
    }
    for (let i = 0; i < state.entries.length; i++) if (state.entries[i].kind === "file") {
      for (const file of [this.part(state, i), `${this.part(state, i)}.sha256`]) {
        assertTransferPath(dirname(file));
        if (!existsSync2(file)) writeFileSync2(file, "", { flag: "wx", mode: OWNER_FILE_MODE, flush: true });
        assertTransferPath(file);
        if (!lstatSync2(file).isFile() || lstatSync2(file).size !== 0) throw new Error("invalid initial partial file");
      }
    }
    state.initialized = true;
    this.save(state);
  }
  async receive(request, remote, remoteName) {
    let state = this.get(request.id);
    if (state && state.remote !== remote) throw new Error("transfer belongs to another paired instance");
    if (request.op === "abort") {
      if (!state) {
        state = {
          version: 1,
          id: request.id,
          direction: "receive",
          remote,
          peer: remoteName,
          from: { id: "files", name: "files", agent: "other" },
          to: "files",
          status: "failed",
          error: request.error,
          paths: [],
          cwd: "",
          entries: [],
          totalBytes: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        this.save(state);
        this.log.warn("remote file transfer failed", { id: state.id, remote, error: request.error });
      } else if (!TERMINAL.has(state.status)) {
        state.status = "failed";
        state.error = request.error;
        state.abortPending = false;
        this.save(state);
        this.report(state, true);
        for (const [rid, pending] of this.pending) if (pending.id === state.id) {
          clearTimeout(pending.timer);
          this.pending.delete(rid);
          pending.reject(new RemoteTransferError(request.error));
        }
      }
      return { status: state.status };
    }
    if (request.op === "cancel") {
      if (!state) {
        this.save({
          version: 1,
          id: request.id,
          direction: "receive",
          remote,
          peer: remoteName,
          from: { id: "files", name: "files", agent: "other" },
          to: "files",
          status: "cancelled",
          paths: [],
          cwd: "",
          entries: [],
          totalBytes: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        return { status: "cancelled" };
      }
      await this.cancel(request.id, false);
      return { status: state.status };
    }
    if (state?.status === "cancelled" || state?.status === "failed") throw new Error(`transfer ${state.status}`);
    if (request.op === "fetch") {
      if (!this.transport.validSender(remote, request.from)) throw new Error("sender not advertised by paired instance");
      const source = this.transport.localPeer(request.source);
      if (!source) throw new Error("file source peer is not online");
      if (!this.options.fetchRoots?.length) throw new Error("fetch is disabled or path is outside allowed fetch roots");
      const paths = request.paths.map((path) => allowedFetchPath(path, source.cwd, this.options.fetchRoots));
      if (state && (state.direction !== "send" || state.to !== request.from.name || state.from.name !== request.source || JSON.stringify(state.paths) !== JSON.stringify(paths))) throw new Error("fetch request changed");
      if (!state) {
        this.start(remote, `${remoteName}/${request.from.name}`, request.from.name, paths, source.cwd, source, false, request.id);
        const fetched = this.get(request.id);
        fetched.fetched = true;
        this.save(fetched);
      }
      return { status: state?.status ?? "queued" };
    }
    if (request.op === "offer") {
      if (!this.transport.validSender(remote, request.from)) throw new Error("sender not advertised by paired instance");
      if (!this.transport.localPeer(request.to)) throw new Error("file recipient is not online");
      const entries = request.entries.map((entry) => ({ ...entry, offset: 0 }));
      const totalBytes = this.validateEntries(entries);
      if (state?.pull && !state.entries.length) {
        if (state.to !== request.from.name || state.from.name !== request.to) throw new Error("pull offer does not match request");
        state.from = request.from;
        state.to = request.to;
        state.pull = false;
      } else if (state && (state.direction !== "receive" || JSON.stringify(state.entries.map(({ path, kind, size }) => ({ path, kind, size }))) !== JSON.stringify(request.entries) || state.from.name !== request.from.name || state.from.agent !== request.from.agent || state.to !== request.to)) throw new Error("transfer manifest changed");
      if (state) state.from = request.from;
      if (this.receiving.has(request.id)) throw new Error("transfer operation already in progress");
      this.receiving.add(request.id);
      try {
        if (!state || !state.entries.length) {
          if (!state) this.ensureCapacity();
          const inbox = join2(this.home, "inbox");
          ensureTransferDirectory(inbox);
          if (existsSync2(join2(inbox, request.id)) || existsSync2(join2(this.root, request.id))) throw new Error("transfer destination already exists");
          const receiving = {
            version: 1,
            id: request.id,
            direction: "receive",
            remote,
            peer: `${remoteName}/${request.from.name}`,
            from: request.from,
            to: request.to,
            paths: [],
            cwd: "",
            status: "preparing",
            entries,
            totalBytes,
            createdAt: state?.createdAt ?? Date.now(),
            updatedAt: Date.now()
          };
          state = state ? Object.assign(state, receiving, { pull: false }) : receiving;
          this.save(state);
          await this.freeDisk(0);
          if (this.stopped(state)) throw new Error("transfer cancelled");
        }
        if (!state.initialized) this.initialize(state);
        else {
          for (let i = 0; i < state.entries.length; i++) await this.recover(state, state.entries[i], i);
          await this.freeDisk(0);
        }
        if (this.stopped(state)) throw new Error("transfer cancelled");
        if (state.status !== "completed") {
          state.status = "running";
          delete state.error;
        }
        this.save(state);
        this.report(state, true);
        return { offsets: state.entries.map((entry) => entry.offset), status: state.status };
      } finally {
        this.receiving.delete(request.id);
      }
    }
    if (!state || state.direction !== "receive") throw new Error("unknown receiving transfer");
    if (this.receiving.has(state.id)) throw new Error("transfer operation already in progress");
    this.receiving.add(state.id);
    try {
      if (request.op === "finish") {
        if (state.entries.some((entry2) => entry2.kind === "file" && !entry2.complete)) throw new Error("transfer has incomplete files");
        if (state.status !== "completed") {
          state.status = "completed";
          this.save(state);
          this.report(state, true);
        }
        return { status: state.status };
      }
      const entry = state.entries[request.index];
      if (!entry || entry.kind !== "file") throw new Error("invalid file index");
      if (request.op === "finish-file") {
        if (entry.offset !== entry.size) throw new Error("file is incomplete");
        if (entry.complete) {
          if (entry.sha256 !== request.sha256) throw new Error("file checksum mismatch");
          return {};
        }
        const part = this.part(state, request.index);
        if (await this.hashFile(part, state) !== request.sha256) throw new Error("file checksum mismatch");
        if (this.stopped(state)) throw new Error("transfer cancelled");
        entry.sha256 = request.sha256;
        this.save(state);
        const target = this.target(state, entry);
        assertTransferPath(dirname(target));
        assertTransferPath(part);
        const verified = this.verified(state, request.index);
        if (existsSync2(verified)) throw new Error("verified file already exists");
        renameSync2(part, verified);
        await link(verified, target);
        await unlink(verified);
        entry.complete = true;
        this.save(state);
        return {};
      }
      if (entry.complete || request.offset !== entry.offset) throw new Error("chunk offset mismatch");
      const data = Buffer.from(request.data, "base64");
      if (!data.length || data.length !== Math.min(TRANSFER_CHUNK_BYTES, entry.size - entry.offset) || data.toString("base64") !== request.data || digest(data) !== request.sha256) throw new Error("chunk checksum or encoding mismatch");
      await this.freeDisk(0);
      if (this.stopped(state)) throw new Error("transfer cancelled or manager closed");
      const path = this.part(state, request.index);
      assertTransferPath(path);
      assertTransferPath(`${path}.sha256`);
      const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      let journal;
      try {
        journal = await open(`${path}.sha256`, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        await writeAll(file, data, entry.offset);
        await file.sync();
        const record = Buffer.from(`${request.sha256}
`);
        await writeAll(journal, record, Math.floor(entry.offset / TRANSFER_CHUNK_BYTES) * SHA_RECORD_BYTES);
        await journal.sync();
      } finally {
        try {
          await file.close();
        } finally {
          await journal?.close();
        }
      }
      entry.offset += data.length;
      if (!this.stopped(state)) state.status = "running";
      this.save(state);
      this.report(state);
      return {};
    } finally {
      this.receiving.delete(state.id);
    }
  }
  async cancel(id, notifyRemote = true) {
    const state = this.get(external_exports.uuid().parse(id));
    if (!state) throw new Error("unknown transfer");
    if (state.status === "completed" || state.status === "failed") return { id, cancelled: false };
    if (state.legacySent) return { id, cancelled: false };
    state.status = "cancelled";
    state.cancelPending = notifyRemote && !state.legacy;
    this.save(state);
    this.report(state, true);
    for (const [rid, pending] of this.pending) if (pending.id === id) {
      clearTimeout(pending.timer);
      this.pending.delete(rid);
      pending.reject(new Error("transfer cancelled"));
    }
    if (notifyRemote) this.resume();
    return { id, cancelled: true };
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const state of this.states.values()) if (!TERMINAL.has(state.status)) {
      state.status = "paused";
      this.save(state);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("transfer manager closed"));
    }
    this.pending.clear();
  }
};

export {
  transferSchema,
  transferResultSchema,
  collectTransfer,
  receiveTransfer,
  FILE_STREAM_CAPABILITY,
  FILE_STREAM_WINDOW_CAPABILITY,
  TRANSFER_WINDOW_CHUNKS,
  MAX_STREAM_ENTRIES,
  cancelStoredTransfer,
  readTransferHistory,
  TransferManager
};
