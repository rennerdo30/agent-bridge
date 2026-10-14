import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import * as zlib from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { conversationBodyText } from "./conversation-text.js";

/** Lossless per-value compression for history store v2. The codec is stored next to every value,
 * so plain legacy rows (codec 0 or no codec column) stay readable and the codec can change later. */
export const CODEC_PLAIN = 0;
export const CODEC_ZSTD = 1;
export const CODEC_BROTLI = 2;
/** Small values compress poorly and cost a decode on every read. */
const MIN_COMPRESS_BYTES = 256;

type Zstd = { zstdCompressSync(b: Buffer, o?: object): Buffer; zstdDecompressSync(b: Buffer): Buffer };
const zstd = typeof (zlib as unknown as Partial<Zstd>).zstdCompressSync === "function" ? zlib as unknown as Zstd : null;

function compress(bytes: Buffer): { value: Buffer; codec: number } {
  if (bytes.length < MIN_COMPRESS_BYTES) return { value: bytes, codec: CODEC_PLAIN };
  const value = zstd
    ? zstd.zstdCompressSync(bytes, { params: { [(constants as Record<string, number>).ZSTD_c_compressionLevel!]: 6 } })
    : brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } });
  return value.length < bytes.length ? { value, codec: zstd ? CODEC_ZSTD : CODEC_BROTLI } : { value: bytes, codec: CODEC_PLAIN };
}

function decompress(bytes: Buffer, codec: number): Buffer {
  if (codec === CODEC_ZSTD) {
    if (!zstd) throw new Error("History value uses zstd, which this Node runtime cannot decode; data is retained");
    return zstd.zstdDecompressSync(bytes);
  }
  if (codec === CODEC_BROTLI) return brotliDecompressSync(bytes);
  throw new Error(`Unknown history codec ${codec}; data is retained`);
}

const asBuffer = (value: unknown): Buffer => value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(String(value ?? ""), "utf8");
const codecOf = (codec: unknown): number => codec === undefined || codec === null ? CODEC_PLAIN : Number(codec);

/** Bytes stay bytes: raw transcript records may hold arbitrary data. */
export function encodeBytes(bytes: Buffer): { value: Buffer; codec: number } { return compress(bytes); }
export function decodeBytes(value: unknown, codec?: unknown): Buffer {
  const c = codecOf(codec);
  return c === CODEC_PLAIN ? asBuffer(value) : decompress(asBuffer(value), c);
}

/** Text compresses to a BLOB; uncompressed text stays TEXT so plain rows remain readable anywhere. */
export function encodeText(text: string): { value: Buffer | string; codec: number } {
  const encoded = compress(Buffer.from(text, "utf8"));
  return encoded.codec === CODEC_PLAIN ? { value: text, codec: CODEC_PLAIN } : encoded;
}
export function decodeText(value: unknown, codec?: unknown): string {
  const c = codecOf(codec);
  if (c === CODEC_PLAIN) return typeof value === "string" ? value : asBuffer(value).toString("utf8");
  return decompress(asBuffer(value), c).toString("utf8");
}

/** SQL access for every connection that reads or writes v2 history text, including the FTS content view
 * and our own viewer: ab_text(value, codec) returns text, ab_raw(value, codec) returns the original bytes, ab_json is ab_text for JSON functions. */
export function registerHistoryFunctions(db: DatabaseSync): void {
  db.function("ab_text", { deterministic: true }, (value, codec) => value === null ? null : decodeText(value, codec));
  db.function("ab_raw", { deterministic: true }, (value, codec) => value === null ? null : decodeBytes(value, codec));
  // Decoded text for SQLite's JSON functions, e.g. json_extract(ab_json(raw, raw_codec), '$.type').
  db.function("ab_json", { deterministic: true }, (value, codec) => value === null ? null : decodeText(value, codec));
  // The text a transcript record stands for: ab_body(body, raw, raw_codec) resolves body NULL and body ''.
  db.function("ab_body", { deterministic: true }, (body, raw, codec) => raw === null ? body : conversationBodyText(body, decodeBytes(raw, codec)));
}
