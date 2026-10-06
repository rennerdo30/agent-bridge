import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { AGENT_KINDS } from "../core/protocol.js";
import { NETWORK_NAME_PATTERN, OWNER_DIR_MODE, OWNER_FILE_MODE } from "./constants.js";

export const MAX_TRANSFER_BYTES = 1024 * 1024;
export const MAX_TRANSFER_ENTRIES = 128;
export const MAX_TRANSFER_DEPTH = 16;
const MAX_PATH_CHARS = 1_024;
const MAX_COMPONENT_CHARS = 255;
const MAX_ID_CHARS = 128;
const MAX_BASE64_CHARS = Math.ceil(MAX_TRANSFER_BYTES / 3) * 4;
const pathSchema = z.string().min(1).max(MAX_PATH_CHARS);
const entrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: pathSchema }),
  z.object({ kind: z.literal("file"), path: pathSchema, data: z.string().max(MAX_BASE64_CHARS), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
]);
export const transferSchema = z.object({
  id: z.uuid(), to: z.string().regex(NETWORK_NAME_PATTERN),
  from: z.object({ id: z.string().min(1).max(MAX_ID_CHARS), name: z.string().regex(NETWORK_NAME_PATTERN), agent: z.enum(AGENT_KINDS) }),
  entries: z.array(entrySchema).min(1).max(MAX_TRANSFER_ENTRIES),
});
export type FileTransfer = z.infer<typeof transferSchema>;
export const transferResultSchema = z.object({ id: z.uuid(), inbox: z.string().max(MAX_PATH_CHARS), files: z.number().int().nonnegative().max(MAX_TRANSFER_ENTRIES), bytes: z.number().int().nonnegative().max(MAX_TRANSFER_BYTES) });
export type TransferResult = z.infer<typeof transferResultSchema>;

function checksum(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }

/** Portable names also exclude Windows alternate streams, device names and case aliases. */
export function safeTransferPath(path: string): boolean {
  const components = path.split("/");
  return path.length <= MAX_PATH_CHARS && components.length <= MAX_TRANSFER_DEPTH && components.every((part) =>
    part.length > 0 && part.length <= MAX_COMPONENT_CHARS && part !== "." && part !== ".." && !/[<>:"\\|?*\x00-\x1f]/.test(part)
    && !/[. ]$/.test(part) && !/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part));
}

export function collectTransfer(paths: string[], cwd: string, to: string, from: FileTransfer["from"]): FileTransfer {
  if (!paths.length || paths.length > MAX_TRANSFER_ENTRIES) throw new Error("invalid number of transfer paths");
  const entries: FileTransfer["entries"] = [];
  let bytes = 0;
  const walk = (source: string, path: string) => {
    if (!safeTransferPath(path)) throw new Error("unsafe or too deep transfer path");
    if (entries.length >= MAX_TRANSFER_ENTRIES) throw new Error("too many transfer entries");
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
  for (const path of paths) { const source = resolve(cwd, path); walk(source, basename(source)); }
  const transfer = transferSchema.parse({ id: randomUUID(), to, from, entries });
  validateEntries(transfer);
  return transfer;
}

function validateEntries(transfer: FileTransfer): { entries: { path: string; data: Buffer | null }[]; bytes: number; files: number } {
  const kinds = new Map<string, string>();
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

/** Validate the entire manifest first, then publish a fresh inbox directory atomically. Never overwrite. */
export function receiveTransfer(home: string, input: FileTransfer): TransferResult {
  const transfer = transferSchema.parse(input);
  const { entries, bytes, files } = validateEntries(transfer);
  const inbox = join(home, "inbox");
  mkdirSync(inbox, { recursive: true, mode: OWNER_DIR_MODE });
  if (lstatSync(inbox).isSymbolicLink()) throw new Error("inbox cannot be a symlink");
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
