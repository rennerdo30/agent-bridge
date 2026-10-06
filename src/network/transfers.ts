import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { open, link, unlink, statfs, lstat, opendir, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Logger } from "../core/logger.js";
import { AGENT_KINDS, TRANSFER_PROGRESS_PREFIX, type BridgeMessage } from "../core/protocol.js";
import { OWNER_DIR_MODE, OWNER_FILE_MODE, NETWORK_NAME_PATTERN, MAX_NETWORK_FRAME_BYTES } from "./constants.js";
import { assertTransferPath, ensureTransferDirectory, safeTransferPath, MAX_TRANSFER_DEPTH, collectTransfer, type FileTransfer, type TransferResult } from "./files.js";

export const FILE_STREAM_CAPABILITY = "file-stream-v1";
export const TRANSFER_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_MAX_STREAM_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_STREAM_ENTRIES = 4_096;
export const MAX_ACTIVE_TRANSFERS = 4;
export const MAX_TRANSFER_HISTORY = 200;
const TRANSFER_REQUEST_TIMEOUT_MS = 30_000;
const TRANSFER_HEARTBEAT_MS = 5_000;
const TRANSFER_RETRY_MS = 2_000;
const TRANSFER_PROGRESS_MS = 1_000;
const SHA_RECORD_BYTES = 65;
const MAX_PATH_CHARS = 1_024;
const MAX_SENDER_ID_CHARS = 128;
const MAX_ERROR_CHARS = 512;
const MIN_TRANSFER_FREE_BYTES = 16 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const RETRYABLE_TRANSFER_ERROR = /^(network link closed|network write limit reached|paired instance is not connected|file transfer request timed out|sender not advertised by paired instance|file (source peer|recipient|sender) is not online|transfer operation already in progress|too many active file transfers)$/;
const TERMINAL = new Set<TransferStatus>(["completed", "cancelled", "failed"]);
export type TransferStatus = "queued" | "preparing" | "running" | "paused" | "completed" | "cancelled" | "failed";
export interface TransferProgress {
  id: string; direction: "send" | "receive"; peer: string; status: TransferStatus;
  bytes: number; totalBytes: number; files: number; totalFiles: number; percent: number;
  createdAt: number; updatedAt: number; inbox?: string; error?: string;
}
export interface TransferStarted { id: string; status: "queued" }
const senderSchema = z.object({ id: z.string().min(1).max(MAX_SENDER_ID_CHARS), name: z.string().regex(NETWORK_NAME_PATTERN), agent: z.enum(AGENT_KINDS) });
type Sender = z.infer<typeof senderSchema>;
const entrySchema = z.object({ path: z.string().min(1).max(MAX_PATH_CHARS), kind: z.enum(["file", "directory"]), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
type Entry = z.infer<typeof entrySchema> & { source?: string; mtimeMs?: number; ino?: number; dev?: number; offset: number; sha256?: string; complete?: boolean };
const base = { id: z.uuid(), rid: z.uuid(), kind: z.literal("request") };
export const fileStreamRequestSchema = z.discriminatedUnion("op", [
  z.object({ ...base, op: z.literal("offer"), from: senderSchema, to: z.string().regex(NETWORK_NAME_PATTERN), entries: z.array(entrySchema).min(1).max(MAX_STREAM_ENTRIES) }),
  z.object({ ...base, op: z.literal("chunk"), index: z.number().int().nonnegative().max(MAX_STREAM_ENTRIES - 1), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), data: z.string().max(Math.ceil(TRANSFER_CHUNK_BYTES / 3) * 4), sha256: z.string().regex(SHA_PATTERN) }),
  z.object({ ...base, op: z.literal("finish-file"), index: z.number().int().nonnegative().max(MAX_STREAM_ENTRIES - 1), sha256: z.string().regex(SHA_PATTERN) }),
  z.object({ ...base, op: z.literal("finish") }),
  z.object({ ...base, op: z.literal("cancel") }),
  z.object({ ...base, op: z.literal("abort"), error: z.string().min(1).max(MAX_ERROR_CHARS) }),
  z.object({ ...base, op: z.literal("fetch"), from: senderSchema, source: z.string().regex(NETWORK_NAME_PATTERN), paths: z.array(z.string().min(1).max(MAX_PATH_CHARS)).min(1).max(MAX_STREAM_ENTRIES) }),
]);
type Request = z.infer<typeof fileStreamRequestSchema>;
const responseSchema = z.object({ kind: z.literal("response"), rid: z.uuid(), id: z.uuid(), error: z.string().max(MAX_ERROR_CHARS).optional(), data: z.object({ offsets: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).max(MAX_STREAM_ENTRIES).optional(), status: z.enum(["queued", "preparing", "running", "paused", "completed", "cancelled", "failed"]).optional() }).default({}) });
type Reply = z.infer<typeof responseSchema>["data"];
interface State {
  version: 1; id: string; direction: "send" | "receive"; remote: string; peer: string;
  from: Sender; to: string; status: TransferStatus; createdAt: number; updatedAt: number;
  paths: string[]; cwd: string; entries: Entry[]; totalBytes: number; error?: string;
  pull?: boolean; cancelPending?: boolean; abortPending?: boolean; legacy?: boolean; legacySent?: boolean; fetched?: boolean; initialized?: boolean;
}
interface TransferTransport {
  supports(remote: string): boolean;
  send(remote: string, payload: Record<string, unknown>): Promise<void>;
  validSender(remote: string, sender: Sender): boolean;
  localPeer(name: string): (Sender & { cwd: string }) | undefined;
  notify(message: BridgeMessage): void;
  legacy(remote: string, transfer: FileTransfer): Promise<TransferResult>;
}
interface Pending { remote: string; id: string; resolve: (value: Reply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
class RemoteTransferError extends Error {}
function digest(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }

function transferSummary(home: string, state: State): TransferProgress {
  const bytes = state.entries.reduce((sum, entry) => sum + entry.offset, 0);
  return { id: state.id, direction: state.direction, peer: state.peer, status: state.status, bytes, totalBytes: state.totalBytes,
    files: state.entries.filter((entry) => entry.kind === "file" && entry.complete).length,
    totalFiles: state.entries.filter((entry) => entry.kind === "file").length,
    percent: state.status === "completed" ? 100 : state.totalBytes ? Math.floor(bytes / state.totalBytes * 100) : 0,
    createdAt: state.createdAt, updatedAt: state.updatedAt,
    ...(state.direction === "receive" ? { inbox: join(home, "inbox", state.id) } : {}), ...(state.error ? { error: state.error } : {}) };
}
function persistTransfer(root: string, state: State): void {
  assertTransferPath(root); state.updatedAt = Date.now();
  const file = join(root, `${state.id}.json`);
  if (existsSync(file)) assertTransferPath(file);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { flag: "wx", mode: OWNER_FILE_MODE, flush: true });
  renameSync(temp, file);
}
export function cancelStoredTransfer(home: string, id: string): { id: string; cancelled: boolean } {
  z.uuid().parse(id);
  const root = join(home, "network", "transfers"); const path = join(root, `${id}.json`);
  if (!existsSync(path)) throw new Error("unknown transfer");
  assertTransferPath(path);
  const state = JSON.parse(readFileSync(path, "utf8")) as State;
  if (state.version !== 1 || state.id !== id) throw new Error("invalid persisted transfer");
  if (state.status === "completed" || state.status === "failed" || state.legacySent) return { id, cancelled: false };
  state.status = "cancelled"; state.cancelPending = !state.legacy;
  persistTransfer(root, state); return { id, cancelled: true };
}
/** Read history even when networking is disabled; dashboard reads never create transfer directories. */
export function readTransferHistory(home: string): TransferProgress[] {
  const root = join(home, "network", "transfers");
  if (!existsSync(root)) return [];
  assertTransferPath(root);
  return readdirSync(root).filter((file) => /^[0-9a-f-]{36}\.json$/.test(file))
    .map((file) => { const path = join(root, file); assertTransferPath(path); return { path, mtime: statSync(path).mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime).slice(0, MAX_TRANSFER_HISTORY)
    .map(({ path }) => {
      const state = JSON.parse(readFileSync(path, "utf8")) as State;
      if (state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > MAX_STREAM_ENTRIES) throw new Error("invalid persisted transfer");
      return transferSummary(home, state);
    }).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function allowedFetchPath(path: string, cwd: string, roots: string[]): string {
  const source = resolve(cwd, path);
  assertTransferPath(source);
  if (!roots.some((root) => {
    if (!isAbsolute(root)) return false;
    assertTransferPath(root);
    const rel = relative(resolve(root), source);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  })) throw new Error("fetch is disabled or path is outside allowed fetch roots");
  return source;
}
async function writeAll(file: FileHandle, data: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const result = await file.write(data, written, data.length - written, position + written);
    if (!result.bytesWritten) throw new Error("file write made no progress");
    written += result.bytesWritten;
  }
}

/** One chunk per transfer in flight. Chunk digests live on disk, never in an expanding RAM array. */
export class TransferManager {
  private readonly states = new Map<string, State>();
  private readonly active = new Set<string>();
  private readonly receiving = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly notified = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  private readonly root: string;

  constructor(private readonly home: string, private readonly transport: TransferTransport, private readonly log: Logger,
    private readonly options: { maxBytes?: number; fetchRoots?: string[] } = {}) {
    assertTransferPath(home);
    this.root = join(home, "network", "transfers");
    ensureTransferDirectory(this.root);
    assertTransferPath(this.root);
    for (const file of readdirSync(this.root).filter((file) => /^[0-9a-f-]{36}\.json$/.test(file))) {
      const state = this.read(file.slice(0, -5));
      if (state && (!TERMINAL.has(state.status) || state.cancelPending || state.abortPending)) {
        if (this.states.size >= MAX_ACTIVE_TRANSFERS) { this.log.warn("transfer recovery limit reached", { id: state.id }); continue; }
        state.status = TERMINAL.has(state.status) ? state.status : "paused";
        this.save(state);
      }
    }
    this.timer = setInterval(() => this.resume(), TRANSFER_RETRY_MS);
    this.timer.unref();
  }

  private read(id: string): State | undefined {
    const file = join(this.root, `${id}.json`);
    if (!existsSync(file)) return undefined;
    assertTransferPath(file);
    const state = JSON.parse(readFileSync(file, "utf8")) as State;
    if (state.version !== 1 || state.id !== id || !Array.isArray(state.entries) || state.entries.length > MAX_STREAM_ENTRIES) throw new Error("invalid persisted transfer");
    return state;
  }
  private get(id: string): State | undefined { return this.states.get(id) ?? this.read(id); }
  private save(state: State): void {
    persistTransfer(this.root, state);
    if (!TERMINAL.has(state.status) || state.cancelPending || state.abortPending) this.states.set(state.id, state);
    else this.states.delete(state.id);
  }
  private summary(state: State): TransferProgress {
    return transferSummary(this.home, state);
  }
  list(): TransferProgress[] { return readTransferHistory(this.home); }
  recordLegacy(transfer: FileTransfer, remote: string, peer: string): void {
    const entries: Entry[] = transfer.entries.map((entry) => ({ kind: entry.kind, path: entry.path, size: entry.kind === "file" ? Buffer.byteLength(entry.data, "base64") : 0,
      offset: entry.kind === "file" ? Buffer.byteLength(entry.data, "base64") : 0, complete: true, ...(entry.kind === "file" ? { sha256: entry.sha256 } : {}) }));
    this.save({ version: 1, id: transfer.id, direction: "receive", remote, peer, from: transfer.from, to: transfer.to,
      paths: [], cwd: "", entries, totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0), status: "completed", legacy: true, initialized: true, createdAt: Date.now(), updatedAt: Date.now() });
  }
  private report(state: State, force = false): void {
    if (this.closed) return;
    const now = Date.now();
    if (!force && now - (this.notified.get(state.id) ?? 0) < TRANSFER_PROGRESS_MS) return;
    this.notified.set(state.id, now);
    const progress = this.summary(state);
    this.log.info("file transfer progress", { ...progress });
    const recipient = state.direction === "send" ? state.from.name : state.to;
    const from = state.direction === "receive" ? { ...state.from, id: `${state.remote}/${state.from.id}`, name: `${state.peer.split("/")[0]}/${state.from.name}` } : { id: `files-${state.id}`, name: "files", agent: "other" as const };
    this.transport.notify({ id: state.direction === "receive" && state.status === "completed" ? state.id : randomUUID(), from, to: recipient, recipient,
      conversationId: TERMINAL.has(state.status) ? state.id : `${TRANSFER_PROGRESS_PREFIX}${state.id}`, replyTo: null, hop: 0, createdAt: now, readAt: null,
      body: `files: ${progress.percent}% · ${progress.bytes} / ${progress.totalBytes} bytes · ${state.status} · ${state.id}${progress.inbox ? ` · ${progress.inbox}` : ""}${state.error ? ` · ${state.error}` : ""}` });
    if (TERMINAL.has(state.status)) this.notified.delete(state.id);
  }
  private ensureCapacity(): void {
    if (this.states.size >= MAX_ACTIVE_TRANSFERS) throw new Error("too many active file transfers");
  }
  start(remote: string, peer: string, to: string, paths: string[], cwd: string, from: Sender, pull = false, id: string = randomUUID(), legacy = false): TransferStarted {
    this.ensureCapacity();
    const state: State = { version: 1, id, direction: pull ? "receive" : "send", remote, peer, to, paths, cwd, from,
      status: "queued", entries: [], totalBytes: 0, createdAt: Date.now(), updatedAt: Date.now(), ...(pull ? { pull: true } : {}), ...(legacy ? { legacy: true } : {}) };
    this.save(state); this.report(state, true);
    setImmediate(() => this.resume());
    return { id, status: "queued" };
  }
  resume(): void {
    if (this.closed) return;
    for (const state of this.states.values()) {
      if (this.active.has(state.id) || (!state.legacy && !this.transport.supports(state.remote))) continue;
      if (state.cancelPending || state.abortPending) {
        this.active.add(state.id);
        void this.rpc(state.remote, state.id, state.cancelPending ? { op: "cancel" } : { op: "abort", error: state.error ?? "transfer failed" })
          .then(() => { state.cancelPending = false; state.abortPending = false; this.save(state); }).catch(() => {}).finally(() => this.active.delete(state.id));
      }
      else if (!TERMINAL.has(state.status) && (state.direction === "send" || (state.pull && !state.entries.length))) {
        this.active.add(state.id);
        void this.run(state).finally(() => this.active.delete(state.id));
      }
    }
  }
  disconnected(remote: string): void {
    for (const [rid, pending] of this.pending) if (pending.remote === remote) { clearTimeout(pending.timer); this.pending.delete(rid); pending.reject(new Error("network link closed")); }
    for (const state of this.states.values()) if (state.remote === remote && !TERMINAL.has(state.status)) { state.status = "paused"; this.save(state); this.report(state, true); }
  }
  private rpc(remote: string, id: string, fields: Record<string, unknown>): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error("transfer manager closed"));
    const rid = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error("file transfer request timed out")); }, TRANSFER_REQUEST_TIMEOUT_MS);
      this.pending.set(rid, { remote, id, resolve, reject, timer });
      void Promise.resolve().then(() => this.transport.send(remote, { kind: "request", rid, id, ...fields })).catch((error: Error) => {
        clearTimeout(timer); this.pending.delete(rid); reject(error);
      });
    });
  }
  async handle(payload: Record<string, unknown>, remote: string, remoteName: string): Promise<void> {
    if (payload.kind === "heartbeat") {
      const heartbeat = z.object({ id: z.uuid(), rid: z.uuid() }).parse(payload);
      const pending = this.pending.get(heartbeat.rid);
      if (pending?.remote === remote && pending.id === heartbeat.id) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => { this.pending.delete(heartbeat.rid); pending.reject(new Error("file transfer request timed out")); }, TRANSFER_REQUEST_TIMEOUT_MS);
      }
      return;
    }
    if (payload.kind === "response") {
      const response = responseSchema.parse(payload);
      const pending = this.pending.get(response.rid);
      if (!pending || pending.remote !== remote || pending.id !== response.id) return;
      clearTimeout(pending.timer); this.pending.delete(response.rid);
      if (response.error) pending.reject(new RemoteTransferError(response.error)); else pending.resolve(response.data);
      return;
    }
    const request = fileStreamRequestSchema.parse(payload);
    let data: Reply = {};
    let error: string | undefined;
    let heartbeatSending = false;
    const heartbeat = setInterval(() => {
      if (this.closed || heartbeatSending) return;
      heartbeatSending = true;
      void Promise.resolve().then(() => this.transport.send(remote, { kind: "heartbeat", rid: request.rid, id: request.id })).catch(() => {}).finally(() => { heartbeatSending = false; });
    }, TRANSFER_HEARTBEAT_MS);
    heartbeat.unref();
    try { data = await this.receive(request, remote, remoteName); }
    catch (err) {
      error = (err as Error).message.slice(0, MAX_ERROR_CHARS); this.log.warn("file transfer rejected", { id: request.id, remote, error });
      const state = this.get(request.id);
      if (state?.remote === remote && state.direction === "receive" && !TERMINAL.has(state.status) && /checksum|encoding mismatch|insufficient free disk|invalid initial|EACCES|ENOSPC|EEXIST|ENOENT|symlinks or junctions/.test(error)) {
        state.status = "failed"; state.error = error; this.save(state); this.report(state, true);
      }
    } finally { clearInterval(heartbeat); }
    await this.transport.send(remote, { kind: "response", rid: request.rid, id: request.id, data, ...(error ? { error } : {}) });
  }
  private validateEntries(entries: Entry[]): number {
    const kinds = new Map<string, string>();
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
  private async collect(state: State): Promise<Entry[]> {
    const entries: Entry[] = [];
    let total = 0;
    const walk = async (source: string, path: string): Promise<void> => {
      if (this.closed || state.status === "cancelled") throw new Error("transfer cancelled");
      if (!safeTransferPath(path) || path.split("/").length > MAX_TRANSFER_DEPTH || entries.length >= MAX_STREAM_ENTRIES) throw new Error("unsafe or too many transfer entries");
      assertTransferPath(source);
      const st = await lstat(source);
      if (st.isDirectory()) {
        entries.push({ kind: "directory", path, size: 0, offset: 0 });
        const dir = await opendir(source); const names: string[] = [];
        for await (const child of dir) {
          if (names.length + entries.length >= MAX_STREAM_ENTRIES) throw new Error("too many transfer entries");
          names.push(child.name);
        }
        for (const name of names.sort()) await walk(join(source, name), `${path}/${name}`);
      } else if (st.isFile()) {
        total += st.size;
        if (total > (this.options.maxBytes ?? DEFAULT_MAX_STREAM_BYTES)) throw new Error("transfer exceeds size limit");
        entries.push({ kind: "file", path, size: st.size, offset: 0, source, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev });
      } else throw new Error("only regular files and directories can be transferred");
    };
    for (const path of state.paths) { const source = resolve(state.cwd, path); await walk(source, basename(source)); }
    this.validateEntries(entries);
    return entries;
  }
  private async source(state: State, entry: Entry) {
    if (state.fetched) allowedFetchPath(entry.source!, state.cwd, this.options.fetchRoots ?? []);
    assertTransferPath(entry.source!);
    const file = await open(entry.source!, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = await file.stat();
    if (!st.isFile() || st.size !== entry.size || st.mtimeMs !== entry.mtimeMs || st.ino !== entry.ino || st.dev !== entry.dev) { await file.close(); throw new RemoteTransferError("source file changed since transfer started"); }
    return file;
  }
  private stopped(state: State): boolean { return state.status === "cancelled" || state.status === "failed" || this.closed; }
  private async run(state: State): Promise<void> {
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
        state.totalBytes = this.validateEntries(state.entries); state.legacySent = true; this.save(state);
        const result = await this.transport.legacy(state.remote, transfer);
        if (this.stopped(state)) return;
        state.status = "completed"; for (const entry of state.entries) { entry.offset = entry.size; entry.complete = true; }
        this.save(state); this.report(state, true); this.log.info("legacy file transfer complete", result); return;
      }
      if (state.pull && !state.entries.length) {
        await this.rpc(state.remote, state.id, { op: "fetch", from: state.from, source: state.to, paths: state.paths });
        if (!TERMINAL.has(state.status) && !state.entries.length) { state.status = "paused"; this.save(state); }
        return;
      }
      if (!state.entries.length) { state.status = "preparing"; this.save(state); state.entries = await this.collect(state); state.totalBytes = this.validateEntries(state.entries); this.save(state); }
      if (this.stopped(state)) return;
      const reply = await this.rpc(state.remote, state.id, { op: "offer", from: state.from, to: state.to, entries: state.entries.map(({ path, kind, size }) => ({ path, kind, size })) });
      if (this.stopped(state)) return;
      if (reply.status === "completed") { state.status = "completed"; for (const entry of state.entries) { entry.offset = entry.size; entry.complete = true; } this.save(state); this.report(state, true); return; }
      if (!reply.offsets || reply.offsets.length !== state.entries.length) throw new RemoteTransferError("invalid resume offsets");
      state.status = "running"; delete state.error; this.save(state); this.report(state, true);
      for (let index = 0; index < state.entries.length; index++) {
        const entry = state.entries[index]!;
        if (entry.kind !== "file") continue;
        const offset = reply.offsets[index]!;
        if (offset > entry.size || (offset !== entry.size && offset % TRANSFER_CHUNK_BYTES !== 0)) throw new RemoteTransferError("invalid resume offset");
        entry.offset = offset;
        const file = await this.source(state, entry);
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES);
        try {
          for (let position = 0; position < entry.size;) {
            if (this.stopped(state)) return;
            const length = Math.min(TRANSFER_CHUNK_BYTES, entry.size - position);
            const { bytesRead } = await file.read(buffer, 0, length, position);
            if (bytesRead !== length) throw new RemoteTransferError("source file changed while reading");
            const chunk = buffer.subarray(0, length); hash.update(chunk);
            if (position >= offset) {
              await this.rpc(state.remote, state.id, { op: "chunk", index, offset: position, data: chunk.toString("base64"), sha256: digest(chunk) });
              if (this.stopped(state)) return;
              entry.offset = position + length; this.save(state); this.report(state);
            }
            position += length;
          }
          const st = await file.stat();
          if (st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) throw new RemoteTransferError("source file changed while reading");
        } finally { await file.close(); }
        entry.sha256 = hash.digest("hex");
        await this.rpc(state.remote, state.id, { op: "finish-file", index, sha256: entry.sha256 });
        if (this.stopped(state)) return;
        entry.complete = true; this.save(state);
      }
      await this.rpc(state.remote, state.id, { op: "finish" });
      if (!this.stopped(state)) { state.status = "completed"; this.save(state); this.report(state, true); }
    } catch (error) {
      if (this.stopped(state)) return;
      state.status = state.legacy || !RETRYABLE_TRANSFER_ERROR.test((error as Error).message) ? "failed" : "paused";
      state.error = (error as Error).message.slice(0, MAX_ERROR_CHARS);
      state.abortPending = state.status === "failed" && !state.legacy;
      this.save(state); this.report(state, true);
    }
  }
  private part(state: State, index: number): string { return join(this.root, state.id, `${index}.part`); }
  private verified(state: State, index: number): string { return join(this.root, state.id, `${index}.verified`); }
  private target(state: State, entry: Entry): string { return join(this.home, "inbox", state.id, ...entry.path.split("/")); }
  private async freeDisk(bytes: number): Promise<void> {
    const disk = await statfs(this.home, { bigint: true });
    const reserved = [...this.states.values()].filter((state) => state.direction === "receive" && !TERMINAL.has(state.status)).reduce((sum, state) =>
      sum + BigInt(state.totalBytes) - BigInt(this.summary(state).bytes) + BigInt(Math.ceil(state.totalBytes / TRANSFER_CHUNK_BYTES)) * BigInt(SHA_RECORD_BYTES) + BigInt(MAX_NETWORK_FRAME_BYTES), 0n);
    if (disk.bavail * disk.bsize < BigInt(bytes + MIN_TRANSFER_FREE_BYTES) + reserved) throw new Error("insufficient free disk space for transfer");
  }
  private async hashFile(path: string, state?: State): Promise<string> {
    assertTransferPath(path);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const hash = createHash("sha256"); const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES);
    try { for (;;) { if (this.closed || (state && this.stopped(state))) throw new Error("transfer cancelled or manager closed"); const { bytesRead } = await file.read(buffer); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); } }
    finally { await file.close(); }
    return hash.digest("hex");
  }
  private async recover(state: State, entry: Entry, index: number): Promise<void> {
    if (entry.kind !== "file") return;
    const target = this.target(state, entry);
    if (entry.complete || (entry.sha256 && existsSync(target))) {
      if (await this.hashFile(target, state) !== entry.sha256) throw new Error("completed file checksum mismatch");
      entry.complete = true; entry.offset = entry.size;
      const part = this.part(state, index); if (existsSync(part)) { assertTransferPath(part); await unlink(part); }
      const verified = this.verified(state, index); if (existsSync(verified)) { assertTransferPath(verified); await unlink(verified); }
      return;
    }
    const verifiedPath = this.verified(state, index);
    if (entry.sha256 && existsSync(verifiedPath)) {
      if (await this.hashFile(verifiedPath, state) !== entry.sha256) throw new Error("verified file checksum mismatch");
      assertTransferPath(dirname(target)); await link(verifiedPath, target); await unlink(verifiedPath);
      entry.complete = true; entry.offset = entry.size; return;
    }
    const path = this.part(state, index); assertTransferPath(path); assertTransferPath(`${path}.sha256`);
    const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)); const journal = await open(`${path}.sha256`, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES); const record = Buffer.alloc(SHA_RECORD_BYTES);
    let verified = 0; let chunks = 0;
    try {
      while (verified < entry.offset) {
        if (this.stopped(state)) throw new Error("transfer cancelled or manager closed");
        const length = Math.min(TRANSFER_CHUNK_BYTES, entry.size - verified);
        const a = await file.read(buffer, 0, length, verified); const b = await journal.read(record, 0, SHA_RECORD_BYTES, chunks * SHA_RECORD_BYTES);
        if (a.bytesRead !== length || b.bytesRead !== SHA_RECORD_BYTES || record.toString() !== `${digest(buffer.subarray(0, length))}\n`) break;
        verified += length; chunks++;
      }
      await file.truncate(verified); await journal.truncate(chunks * SHA_RECORD_BYTES); await file.sync(); await journal.sync();
      entry.offset = verified;
    } finally { await file.close(); await journal.close(); }
  }
  private initialize(state: State): void {
    const inbox = join(this.home, "inbox"); ensureTransferDirectory(inbox);
    const final = join(inbox, state.id); const parts = join(this.root, state.id);
    for (const dir of [final, parts]) {
      if (!existsSync(dir)) mkdirSync(dir, { mode: OWNER_DIR_MODE });
      assertTransferPath(dir);
      if (!lstatSync(dir).isDirectory()) throw new Error("transfer directory is not a directory");
    }
    for (const entry of state.entries.filter((entry) => entry.kind === "directory").sort((a, b) => a.path.length - b.path.length)) {
      const dir = this.target(state, entry); assertTransferPath(dirname(dir));
      if (!existsSync(dir)) mkdirSync(dir, { mode: OWNER_DIR_MODE });
      assertTransferPath(dir);
      if (!lstatSync(dir).isDirectory()) throw new Error("transfer directory is not a directory");
    }
    for (let i = 0; i < state.entries.length; i++) if (state.entries[i]!.kind === "file") {
      for (const file of [this.part(state, i), `${this.part(state, i)}.sha256`]) {
        assertTransferPath(dirname(file));
        if (!existsSync(file)) writeFileSync(file, "", { flag: "wx", mode: OWNER_FILE_MODE, flush: true });
        assertTransferPath(file);
        if (!lstatSync(file).isFile() || lstatSync(file).size !== 0) throw new Error("invalid initial partial file");
      }
    }
    state.initialized = true; this.save(state);
  }
  private async receive(request: Request, remote: string, remoteName: string): Promise<Reply> {
    let state = this.get(request.id);
    if (state && state.remote !== remote) throw new Error("transfer belongs to another paired instance");
    if (request.op === "abort") {
      if (!state) {
        state = { version: 1, id: request.id, direction: "receive", remote, peer: remoteName, from: { id: "files", name: "files", agent: "other" }, to: "files",
          status: "failed", error: request.error, paths: [], cwd: "", entries: [], totalBytes: 0, createdAt: Date.now(), updatedAt: Date.now() };
        this.save(state); this.log.warn("remote file transfer failed", { id: state.id, remote, error: request.error });
      } else if (!TERMINAL.has(state.status)) {
        state.status = "failed"; state.error = request.error; state.abortPending = false; this.save(state); this.report(state, true);
        for (const [rid, pending] of this.pending) if (pending.id === state.id) { clearTimeout(pending.timer); this.pending.delete(rid); pending.reject(new RemoteTransferError(request.error)); }
      }
      return { status: state.status };
    }
    if (request.op === "cancel") {
      if (!state) {
        this.save({ version: 1, id: request.id, direction: "receive", remote, peer: remoteName, from: { id: "files", name: "files", agent: "other" }, to: "files",
          status: "cancelled", paths: [], cwd: "", entries: [], totalBytes: 0, createdAt: Date.now(), updatedAt: Date.now() });
        return { status: "cancelled" };
      }
      await this.cancel(request.id, false); return { status: state.status };
    }
    if (state?.status === "cancelled" || state?.status === "failed") throw new Error(`transfer ${state.status}`);
    if (request.op === "fetch") {
      if (!this.transport.validSender(remote, request.from)) throw new Error("sender not advertised by paired instance");
      const source = this.transport.localPeer(request.source);
      if (!source) throw new Error("file source peer is not online");
      if (!this.options.fetchRoots?.length) throw new Error("fetch is disabled or path is outside allowed fetch roots");
      const paths = request.paths.map((path) => allowedFetchPath(path, source.cwd, this.options.fetchRoots!));
      if (state && (state.direction !== "send" || state.to !== request.from.name || state.from.name !== request.source || JSON.stringify(state.paths) !== JSON.stringify(paths))) throw new Error("fetch request changed");
      if (!state) {
        this.start(remote, `${remoteName}/${request.from.name}`, request.from.name, paths, source.cwd, source, false, request.id);
        const fetched = this.get(request.id)!; fetched.fetched = true; this.save(fetched);
      }
      return { status: state?.status ?? "queued" };
    }
    if (request.op === "offer") {
      if (!this.transport.validSender(remote, request.from)) throw new Error("sender not advertised by paired instance");
      if (!this.transport.localPeer(request.to)) throw new Error("file recipient is not online");
      const entries: Entry[] = request.entries.map((entry) => ({ ...entry, offset: 0 }));
      const totalBytes = this.validateEntries(entries);
      if (state?.pull && !state.entries.length) {
        if (state.to !== request.from.name || state.from.name !== request.to) throw new Error("pull offer does not match request");
        state.from = request.from; state.to = request.to; state.pull = false;
      } else if (state && (state.direction !== "receive" || JSON.stringify(state.entries.map(({ path, kind, size }) => ({ path, kind, size }))) !== JSON.stringify(request.entries) || state.from.name !== request.from.name || state.from.agent !== request.from.agent || state.to !== request.to)) throw new Error("transfer manifest changed");
      if (state) state.from = request.from;
      if (this.receiving.has(request.id)) throw new Error("transfer operation already in progress");
      this.receiving.add(request.id);
      try {
        if (!state || !state.entries.length) {
          if (!state) this.ensureCapacity();
          const inbox = join(this.home, "inbox"); ensureTransferDirectory(inbox);
          if (existsSync(join(inbox, request.id)) || existsSync(join(this.root, request.id))) throw new Error("transfer destination already exists");
          const receiving: State = { version: 1, id: request.id, direction: "receive", remote, peer: `${remoteName}/${request.from.name}`, from: request.from, to: request.to,
            paths: [], cwd: "", status: "preparing", entries, totalBytes, createdAt: state?.createdAt ?? Date.now(), updatedAt: Date.now() };
          state = state ? Object.assign(state, receiving, { pull: false }) : receiving;
          this.save(state);
          await this.freeDisk(0);
          if (this.stopped(state)) throw new Error("transfer cancelled");
        }
        if (!state.initialized) this.initialize(state);
        else {
          for (let i = 0; i < state.entries.length; i++) await this.recover(state, state.entries[i]!, i);
          await this.freeDisk(0);
        }
        if (this.stopped(state)) throw new Error("transfer cancelled");
        if (state.status !== "completed") { state.status = "running"; delete state.error; }
        this.save(state); this.report(state, true);
        return { offsets: state.entries.map((entry) => entry.offset), status: state.status };
      } finally { this.receiving.delete(request.id); }
    }
    if (!state || state.direction !== "receive") throw new Error("unknown receiving transfer");
    if (this.receiving.has(state.id)) throw new Error("transfer operation already in progress");
    this.receiving.add(state.id);
    try {
      if (request.op === "finish") {
        if (state.entries.some((entry) => entry.kind === "file" && !entry.complete)) throw new Error("transfer has incomplete files");
        if (state.status !== "completed") { state.status = "completed"; this.save(state); this.report(state, true); }
        return { status: state.status };
      }
      const entry = state.entries[request.index];
      if (!entry || entry.kind !== "file") throw new Error("invalid file index");
      if (request.op === "finish-file") {
        if (entry.offset !== entry.size) throw new Error("file is incomplete");
        if (entry.complete) { if (entry.sha256 !== request.sha256) throw new Error("file checksum mismatch"); return {}; }
        const part = this.part(state, request.index);
        if (await this.hashFile(part, state) !== request.sha256) throw new Error("file checksum mismatch");
        if (this.stopped(state)) throw new Error("transfer cancelled");
        entry.sha256 = request.sha256; this.save(state);
        const target = this.target(state, entry); assertTransferPath(dirname(target)); assertTransferPath(part);
        const verified = this.verified(state, request.index);
        if (existsSync(verified)) throw new Error("verified file already exists");
        renameSync(part, verified);
        // Publishing uses an atomic no-replace move. A direct rename could overwrite a target.
        await link(verified, target); await unlink(verified);
        entry.complete = true; this.save(state); return {};
      }
      if (entry.complete || request.offset !== entry.offset) throw new Error("chunk offset mismatch");
      const data = Buffer.from(request.data, "base64");
      if (!data.length || data.length !== Math.min(TRANSFER_CHUNK_BYTES, entry.size - entry.offset) || data.toString("base64") !== request.data || digest(data) !== request.sha256) throw new Error("chunk checksum or encoding mismatch");
      await this.freeDisk(0);
      if (this.stopped(state)) throw new Error("transfer cancelled or manager closed");
      const path = this.part(state, request.index); assertTransferPath(path); assertTransferPath(`${path}.sha256`);
      const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)); const journal = await open(`${path}.sha256`, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        await writeAll(file, data, entry.offset); await file.sync();
        const record = Buffer.from(`${request.sha256}\n`); await writeAll(journal, record, Math.floor(entry.offset / TRANSFER_CHUNK_BYTES) * SHA_RECORD_BYTES); await journal.sync();
      } finally { await file.close(); await journal.close(); }
      entry.offset += data.length;
      if (!this.stopped(state)) state.status = "running";
      this.save(state); this.report(state); return {};
    } finally { this.receiving.delete(state.id); }
  }
  async cancel(id: string, notifyRemote = true): Promise<{ id: string; cancelled: boolean }> {
    const state = this.get(z.uuid().parse(id));
    if (!state) throw new Error("unknown transfer");
    if (state.status === "completed" || state.status === "failed") return { id, cancelled: false };
    if (state.legacySent) return { id, cancelled: false };
    state.status = "cancelled"; state.cancelPending = notifyRemote && !state.legacy; this.save(state); this.report(state, true);
    for (const [rid, pending] of this.pending) if (pending.id === id) { clearTimeout(pending.timer); this.pending.delete(rid); pending.reject(new Error("transfer cancelled")); }
    if (notifyRemote) this.resume();
    return { id, cancelled: true };
  }
  close(): void {
    this.closed = true; clearInterval(this.timer);
    for (const state of this.states.values()) if (!TERMINAL.has(state.status)) { state.status = "paused"; this.save(state); }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("transfer manager closed")); }
    this.pending.clear();
  }
}
