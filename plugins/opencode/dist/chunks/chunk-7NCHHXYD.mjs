import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/file-cache.ts
import { readFileSync, statSync } from "node:fs";
var MAX_BYTES = 16 * 1024 * 1024;
var MAX_ENTRIES = 2048;
var cache = /* @__PURE__ */ new Map();
var damaged = /* @__PURE__ */ new Map();
var bytes = 0;
function estimatedJsonBytes(value, limit = MAX_BYTES) {
  const pending = [value];
  let total = 0;
  while (pending.length && total <= limit) {
    const item = pending.pop();
    if (typeof item === "string") total += 32 + item.length * 2;
    else if (Array.isArray(item)) {
      total += 64 + item.length * 16;
      for (const child of item) pending.push(child);
    } else if (item !== null && typeof item === "object") {
      total += 64;
      for (const key of Object.keys(item)) {
        total += 64 + key.length * 2;
        pending.push(item[key]);
      }
    } else total += 16;
  }
  return total;
}
function cloneJson(value) {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (value !== null && typeof value === "object") {
    const copied = {};
    for (const key of Object.keys(value)) {
      const item = cloneJson(value[key]);
      if (key === "__proto__") Object.defineProperty(copied, key, { value: item, writable: true, configurable: true, enumerable: true });
      else copied[key] = item;
    }
    return copied;
  }
  return value;
}
var fileTimeMs = (ms, ns) => ns === void 0 ? Number(ms) : Number(ns / 1000000n) + Number(ns % 1000000n) / 1e6;
function fileSignature(st) {
  for (const id of [st.dev, st.ino]) {
    if (typeof id === "number" && !Number.isSafeInteger(id))
      throw new Error("file identity changed or unverifiable; rescan with bigint stat");
  }
  return `fs2:${st.dev}:${st.ino}:${fileTimeMs(st.birthtimeMs, st.birthtimeNs)}:${fileTimeMs(st.ctimeMs, st.ctimeNs)}:${fileTimeMs(st.mtimeMs, st.mtimeNs)}:${st.size}`;
}
function readJsonSnapshot(file, scan) {
  if (scan && scan.file !== file) throw new Error("JSON snapshot scan belongs to another file");
  const st = scan?.stat ?? statSync(file, { bigint: true }), signature = fileSignature(st);
  const failure = damaged.get(file);
  if (failure?.signature === signature) throw failure.error;
  damaged.delete(file);
  const saved = cache.get(file);
  if (saved?.signature === signature) {
    if (scan && fileSignature(statSync(file, { bigint: true })) !== signature)
      throw new Error("JSON snapshot identity changed before cache reuse");
    cache.delete(file);
    cache.set(file, saved);
    return saved;
  }
  if (saved) {
    cache.delete(file);
    bytes -= saved.bytes;
  }
  let value;
  try {
    if (!scan) value = JSON.parse(readFileSync(file, "utf8"));
    else {
      const raw = readFileSync(file, "utf8");
      const after = statSync(file, { bigint: true });
      if (!after.isFile() || fileSignature(after) !== signature)
        throw new Error("JSON snapshot identity changed during read");
      value = JSON.parse(raw);
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      damaged.set(file, { signature, error });
      if (damaged.size > 128) damaged.delete(damaged.keys().next().value);
    }
    throw error;
  }
  const next = { signature, value, bytes: estimatedJsonBytes(value) };
  if (next.bytes <= MAX_BYTES) {
    cache.set(file, next);
    bytes += next.bytes;
    while (bytes > MAX_BYTES || cache.size > MAX_ENTRIES) {
      const first = cache.keys().next().value;
      bytes -= cache.get(first).bytes;
      cache.delete(first);
    }
  }
  return next;
}

// src/core/conversation-text.ts
var CONVERSATION_BYTES = 64 * 1024;
function indexedConversationText(raw) {
  const text = raw.toString("utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const lines = text.trim().split("\n");
    if (lines.length > 1 && lines.every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    })) return lines.map((line) => indexedConversationText(Buffer.from(line))).join("\n");
    return text;
  }
  const found = [];
  const visit = (item, depth = 0) => {
    if (depth > 8 || found.join("\n").length >= CONVERSATION_BYTES) return;
    if (Array.isArray(item)) {
      for (const v of item.slice(0, 100)) visit(v, depth + 1);
    } else if (item && typeof item === "object") for (const [key, v] of Object.entries(item)) {
      if (["text", "body", "content", "summary", "prompt", "title", "topic", "description", "note", "reason", "detail", "question", "answer"].includes(key) && typeof v === "string") found.push(v);
      else if (["message", "payload", "content", "parts", "output", "data"].includes(key)) visit(v, depth + 1);
    }
  };
  visit(value);
  return found.join("\n").slice(0, CONVERSATION_BYTES);
}
function conversationBodyText(body, raw) {
  if (body === null || body === void 0) return raw.toString("utf8");
  return String(body) || indexedConversationText(raw);
}

// src/core/history-codec.ts
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import * as zlib from "node:zlib";
var CODEC_PLAIN = 0;
var CODEC_ZSTD = 1;
var CODEC_BROTLI = 2;
var MIN_COMPRESS_BYTES = 256;
var zstd = typeof zlib.zstdCompressSync === "function" ? zlib : null;
function compress(bytes2) {
  if (bytes2.length < MIN_COMPRESS_BYTES) return { value: bytes2, codec: CODEC_PLAIN };
  const value = zstd ? zstd.zstdCompressSync(bytes2, { params: { [constants.ZSTD_c_compressionLevel]: 6 } }) : brotliCompressSync(bytes2, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: bytes2.length } });
  return value.length < bytes2.length ? { value, codec: zstd ? CODEC_ZSTD : CODEC_BROTLI } : { value: bytes2, codec: CODEC_PLAIN };
}
function decompress(bytes2, codec) {
  if (codec === CODEC_ZSTD) {
    if (!zstd) throw new Error("History value uses zstd, which this Node runtime cannot decode; data is retained");
    return zstd.zstdDecompressSync(bytes2);
  }
  if (codec === CODEC_BROTLI) return brotliDecompressSync(bytes2);
  throw new Error(`Unknown history codec ${codec}; data is retained`);
}
var asBuffer = (value) => value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(String(value ?? ""), "utf8");
var codecOf = (codec) => codec === void 0 || codec === null ? CODEC_PLAIN : Number(codec);
function encodeBytes(bytes2) {
  return compress(bytes2);
}
function decodeBytes(value, codec) {
  const c = codecOf(codec);
  return c === CODEC_PLAIN ? asBuffer(value) : decompress(asBuffer(value), c);
}
function encodeText(text) {
  const encoded = compress(Buffer.from(text, "utf8"));
  return encoded.codec === CODEC_PLAIN ? { value: text, codec: CODEC_PLAIN } : encoded;
}
function decodeText(value, codec) {
  const c = codecOf(codec);
  if (c === CODEC_PLAIN) return typeof value === "string" ? value : asBuffer(value).toString("utf8");
  return decompress(asBuffer(value), c).toString("utf8");
}
function registerHistoryFunctions(db) {
  db.function("ab_text", { deterministic: true }, (value, codec) => value === null ? null : decodeText(value, codec));
  db.function("ab_raw", { deterministic: true }, (value, codec) => value === null ? null : decodeBytes(value, codec));
  db.function("ab_json", { deterministic: true }, (value, codec) => value === null ? null : decodeText(value, codec));
  db.function("ab_body", { deterministic: true }, (body, raw, codec) => raw === null ? body : conversationBodyText(body, decodeBytes(raw, codec)));
}

// src/core/storage-preservation.ts
import { closeSync, constants as constants2, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
var sidecarSuffixes = ["-wal", "-shm", "-journal"];
var samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
var fail = () => new Error("Storage archive path or identity is unsafe or unavailable; all originals are retained.");
function entry(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
function regular(st) {
  if (!st?.isFile() || st.isSymbolicLink() || st.nlink !== 1n || st.ino <= 0n || st.dev < 0n) throw fail();
}
var identical = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
function ancestors(path) {
  const witnessed = [];
  for (let at = dirname(resolve(path)); ; at = dirname(at)) {
    const st = entry(at);
    if (!st?.isDirectory() || st.isSymbolicLink() || st.ino <= 0n || st.dev < 0n) throw fail();
    witnessed.push([at, st]);
    if (dirname(at) === at) break;
  }
  return () => {
    for (const [at, before] of witnessed) {
      const now = entry(at);
      if (!now?.isDirectory() || now.isSymbolicLink() || !identical(before, now)) throw fail();
    }
  };
}
function preserveArchiveTarget(path, home) {
  const checkParents = ancestors(path), canonicalHome = realpathSync.native(home);
  const canonicalPath = join(canonicalHome, "archive.db");
  if (!samePath(realpathSync.native(dirname(path)), canonicalHome) || !samePath(resolve(path), join(resolve(home), "archive.db")) || canonicalHome.split(/[\\/]/).some((part) => [".migration-snapshots", "backups", "cold-storage", "archive"].includes(part.toLowerCase()))) throw fail();
  const before = entry(path);
  if (before) regular(before);
  const sidecars = /* @__PURE__ */ new Map();
  const checkSidecars = () => {
    for (const suffix of sidecarSuffixes) {
      const side = canonicalPath + suffix, now = entry(side), prior = sidecars.get(side);
      if (!now) {
        if (prior) throw fail();
        continue;
      }
      regular(now);
      if (!samePath(realpathSync.native(side), side) || prior && !identical(prior, now)) throw fail();
      sidecars.set(side, now);
    }
  };
  checkParents();
  checkSidecars();
  if (!before && sidecars.size) throw fail();
  if (before && !samePath(realpathSync.native(path), canonicalPath)) throw fail();
  const fd = openSync(canonicalPath, before ? constants2.O_RDONLY | (constants2.O_NOFOLLOW ?? 0) : constants2.O_RDWR | constants2.O_CREAT | constants2.O_EXCL | (constants2.O_NOFOLLOW ?? 0), 384);
  try {
    const owned = fstatSync(fd, { bigint: true });
    regular(owned);
    if (before && !identical(before, owned)) throw fail();
    const check = () => {
      checkParents();
      if (!samePath(realpathSync.native(home), canonicalHome)) throw fail();
      const now = entry(canonicalPath), held = fstatSync(fd, { bigint: true });
      regular(now);
      regular(held);
      if (!identical(owned, now) || !identical(owned, held) || !samePath(realpathSync.native(canonicalPath), canonicalPath)) throw fail();
      checkSidecars();
    };
    check();
    return { path: canonicalPath, created: !before, check, close: () => closeSync(fd) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function candidateReadProblem(path) {
  let fd;
  try {
    const checkParents = ancestors(path), before = entry(path);
    regular(before);
    if (sidecarSuffixes.some((suffix) => entry(path + suffix))) return "candidate has sidecars; retained without a SQLite open";
    fd = openSync(path, constants2.O_RDONLY | (constants2.O_NOFOLLOW ?? 0));
    const held = fstatSync(fd, { bigint: true });
    regular(held);
    if (!identical(before, held)) throw fail();
    const header = Buffer.alloc(100), n = readSync(fd, header, 0, header.length, 0);
    checkParents();
    const after = entry(path);
    regular(after);
    if (!identical(held, after) || sidecarSuffixes.some((suffix) => entry(path + suffix))) throw fail();
    if (n !== 100 || !header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) return "candidate header is unavailable; retained without a SQLite open";
    if (header[18] === 2 || header[19] === 2) return "candidate uses WAL; retained without a SQLite open";
    if (header[18] !== 1 || header[19] !== 1) return "candidate header is unsupported; retained without a SQLite open";
  } catch {
    return "candidate path or identity is unsafe or unavailable; retained without a SQLite open";
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function openPreservedReader(path, timeout = 1e3) {
  const problem = candidateReadProblem(path);
  if (problem) throw new Error(`${path}: ${problem}; proof input unavailable`);
  const db = new DatabaseSync(path, { readOnly: true, timeout });
  try {
    registerHistoryFunctions(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function preservedReadProblems(paths, optional = []) {
  return paths.flatMap((path) => {
    try {
      if (!entry(path) && optional.includes(path)) return [];
      const problem = candidateReadProblem(path);
      return problem ? [`${path}: ${problem}; proof input unavailable`] : [];
    } catch {
      return [`${path}: path inspection unavailable; retained without a SQLite open`];
    }
  });
}

export {
  estimatedJsonBytes,
  cloneJson,
  fileTimeMs,
  fileSignature,
  readJsonSnapshot,
  CONVERSATION_BYTES,
  indexedConversationText,
  conversationBodyText,
  encodeBytes,
  decodeBytes,
  encodeText,
  decodeText,
  registerHistoryFunctions,
  preserveArchiveTarget,
  openPreservedReader,
  preservedReadProblems
};
