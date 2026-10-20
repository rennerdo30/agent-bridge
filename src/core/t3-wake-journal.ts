import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { JSON_STORE_VERSION, writeJsonStore } from "./json-store.js";
import { metadataFileLease } from "./metadata-file-lease.js";
import { sameFrontend, t3BindingSchema, type T3Binding } from "./t3-identity.js";
import type { T3Host } from "./t3-host.js";

export const T3_WAKE_MESSAGE_LIMIT = 2000;
const MAX_BYTES = 8 * 1024 * 1024;
const id = z.string().min(1).max(512);
const receipt = z.object({ threadId: id, delivery: z.enum(["started", "queued", "steered", "restarted"]),
  messageId: id, runId: id, status: id, taskId: id.nullable().optional() }).strict();
const operation = z.object({
  clientRequestId: z.string().regex(/^bridge-wake-[a-f0-9]{64}$/),
  messageIds: z.array(id).min(1).max(100), message: z.string().min(1).max(64_000),
  mode: z.literal("queue"), createdAt: z.number().int().nonnegative(),
}).strict();
export type T3WakeOperation = z.infer<typeof operation>;
const retained = z.discriminatedUnion("state", [
  operation.extend({ state: z.literal("submitted") }),
  operation.extend({ state: z.literal("accepted"), receipt }),
  operation.extend({ state: z.literal("unknown"), failureStage: z.enum(["refused", "unavailable", "unknown"]) }),
]);
const document = z.object({ version: z.literal(JSON_STORE_VERSION), contractVersion: z.literal(1),
  binding: t3BindingSchema, operations: z.array(retained).max(T3_WAKE_MESSAGE_LIMIT) }).strict();
type Document = z.infer<typeof document>;
export type T3WakeOutcome = { state: "accepted"; receipt: Awaited<ReturnType<T3Host["send"]>>["receipt"] } |
  { state: "unknown"; failureStage: "refused" | "unavailable" | "unknown" };

export class T3WakeJournalError extends Error {
  constructor(readonly reason: "unavailable" | "invalid" | "full") {
    super(`T3 wake journal ${reason}; automatic dispatch refused. Retained operations are preserved; repair or review the journal before restarting wake delivery.`);
  }
}

function makeOperation(binding: T3Binding, ids: string[], createdAt: number): T3WakeOperation {
  const messageIds = [...new Set(ids)].sort();
  return operation.parse({ clientRequestId: `bridge-wake-${createHash("sha256").update(JSON.stringify([binding, messageIds])).digest("hex")}`,
    messageIds, createdAt, mode: "queue", message:
      `agent-bridge: unread mail is waiting in your existing Bridge inbox. Call agent-bridge inbox to read it and use send to answer where needed. Bridge message IDs: ${messageIds.join(", ")}. This pointer is a wake request, not the message contents or a read receipt.` });
}

/** Immutable admission before any effect. Submitted (including a crash) is never automatically retried. */
export class T3WakeJournal {
  readonly file: string;
  private readonly binding: T3Binding;
  constructor(home: string, binding: T3Binding) {
    this.binding = t3BindingSchema.parse(binding);
    this.file = join(home, `t3-wakes-${createHash("sha256").update(JSON.stringify(this.binding)).digest("hex")}.json`);
  }

  private read(): Document {
    let fd: number;
    try {
      const entry = lstatSync(this.file);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new T3WakeJournalError("invalid");
      fd = openSync(this.file, "r");
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: JSON_STORE_VERSION, contractVersion: 1, binding: this.binding, operations: [] };
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new T3WakeJournalError("invalid");
      // readJsonStore's corrupt-file recovery returns an empty store. A wake journal must instead
      // keep the canonical file and refuse, so lost/unsupported history can never authorize replay.
      const parsed = document.parse(JSON.parse(readFileSync(fd, "utf8")));
      if (!sameFrontend({ frontend: parsed.binding }, { frontend: this.binding })) throw new T3WakeJournalError("invalid");
      const members = new Set<string>();
      for (const record of parsed.operations) {
        const expected = makeOperation(this.binding, record.messageIds, record.createdAt);
        if (record.clientRequestId !== expected.clientRequestId || record.message !== expected.message ||
          JSON.stringify(record.messageIds) !== JSON.stringify(expected.messageIds) ||
          record.state === "accepted" && record.receipt.threadId !== this.binding.threadId) throw new T3WakeJournalError("invalid");
        for (const messageId of record.messageIds) {
          if (members.has(messageId)) throw new T3WakeJournalError("invalid");
          members.add(messageId);
        }
      }
      if (members.size > T3_WAKE_MESSAGE_LIMIT) throw new T3WakeJournalError("invalid");
      return parsed;
    } finally { closeSync(fd); }
  }

  private locked<T>(fn: () => T): T {
    try {
      // Same protected file-lease/atomic JSON discipline as existing ownership journals.
      // Zero wait: a live writer blocks this admission without an unbounded retry or second effect.
      const release = metadataFileLease(`${this.file}.lock`, 0, true);
      try { return fn(); } finally { release(); }
    } catch (error) {
      throw error instanceof T3WakeJournalError ? error : new T3WakeJournalError(error instanceof z.ZodError || error instanceof SyntaxError ? "invalid" : "unavailable");
    }
  }

  admit(candidates: string[]): T3WakeOperation | undefined {
    return this.locked(() => {
      const previous = this.read(), members = new Set(previous.operations.flatMap(record => record.messageIds));
      const ids = [...new Set(candidates)].filter(messageId => !members.has(messageId)).slice(0, 100);
      if (!ids.length) return undefined;
      if (members.size + ids.length > T3_WAKE_MESSAGE_LIMIT) throw new T3WakeJournalError("full");
      const admitted = makeOperation(this.binding, ids, Date.now());
      const next: Document = { ...previous, operations: [...previous.operations, { ...admitted, state: "submitted" }] };
      writeJsonStore(this.file, next, previous);
      return admitted;
    });
  }

  complete(admitted: T3WakeOperation, outcome: T3WakeOutcome): void {
    this.locked(() => {
      const previous = this.read(), index = previous.operations.findIndex(record => record.clientRequestId === admitted.clientRequestId);
      const current = previous.operations[index];
      if (!current || current.state !== "submitted" || JSON.stringify(operation.strip().parse(current)) !== JSON.stringify(admitted)) throw new T3WakeJournalError("invalid");
      const operations = [...previous.operations];
      operations[index] = retained.parse({ ...admitted, ...outcome });
      writeJsonStore(this.file, { ...previous, operations }, previous);
    });
  }
}
