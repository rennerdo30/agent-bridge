import type { SQLInputValue } from "node:sqlite";

export type StoredRow = Record<string, SQLInputValue>;
export interface StoredCell { type: "null" | "text" | "blob" | "int" | "real"; value: SQLInputValue; encoding?: string }
// Witnesses are not row columns: user columns may have any name, and archive JSON stays unchanged.
const witnesses = Symbol("SQL stored-cell witnesses");
type WitnessedRow = StoredRow & { [witnesses]?: ReadonlyMap<string, StoredCell> };
export function witnessRow(row: StoredRow, cells: ReadonlyMap<string, StoredCell>): StoredRow {
  // Enumerable symbols survive object spread/assign while staying out of SQL columns and JSON.
  Object.defineProperty(row, witnesses, { value: cells, enumerable: true }); return row;
}
export function plainCell(value: SQLInputValue | undefined): StoredCell {
  value ??= null;
  return { type: value === null ? "null" : value instanceof Uint8Array ? "blob" : typeof value === "bigint" ? "int" : typeof value === "number" ? "real" : "text", value, ...(typeof value === "string" ? { encoding: "UTF-8" } : {}) };
}
export function storedCell(row: StoredRow, name: string): StoredCell { return (row as WitnessedRow)[witnesses]?.get(name) ?? plainCell(row[name]); }
export function cellBytes(cell: StoredCell): Buffer { return cell.value instanceof Uint8Array ? Buffer.from(cell.value) : Buffer.from(String(cell.value), "utf8"); }
export function sameCell(a: StoredCell, b: StoredCell): boolean {
  return a.type === b.type && a.encoding === b.encoding && (a.type === "text" || a.type === "blob" ? cellBytes(a).equals(cellBytes(b)) : a.value === b.value);
}

/** Existing archive format. SQL INTEGER reads are bigint; every native number is REAL, including 1.0. */
export function encodeAbsorbedRow(row: StoredRow, columns: readonly string[]): string {
  return JSON.stringify({ columns, values: columns.map(c => {
    const v = row[c] ?? null;
    if (!sameCell(storedCell(row, c), plainCell(v))) throw new Error(`Cannot preserve stored type/bytes of ${c} in absorbed row`);
    if (v === null) return null;
    if (typeof v === "bigint") return { i: v.toString() };
    if (typeof v === "number") return { r: v };
    if (typeof v === "string") return { t: v };
    return { b: Buffer.from(v).toString("base64") };
  }) });
}

/** Strict existing-format decoder: malformed receipts never establish surviving data. */
export function decodeAbsorbedRow(json: string): Record<string, bigint | number | string | Buffer | null> {
  const data: unknown = JSON.parse(json);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid absorbed row");
  const { columns, values } = data as { columns?: unknown; values?: unknown };
  if (!Array.isArray(columns) || !columns.every(c => typeof c === "string") || new Set(columns).size !== columns.length || !Array.isArray(values) || values.length !== columns.length) throw new Error("Invalid absorbed columns/values");
  return Object.fromEntries(columns.map((c: string, n: number) => {
    const v: unknown = values[n];
    if (v === null) return [c, null];
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 1) throw new Error("Invalid absorbed value");
    const tag = v as { i?: unknown; r?: unknown; t?: unknown; b?: unknown };
    if (typeof tag.i === "string" && /^-?(0|[1-9]\d*)$/.test(tag.i) && BigInt(tag.i).toString() === tag.i) return [c, BigInt(tag.i)];
    if (typeof tag.r === "number" && Number.isFinite(tag.r)) return [c, tag.r];
    if (typeof tag.t === "string" && Buffer.from(tag.t, "utf8").toString("utf8") === tag.t) return [c, tag.t];
    if (typeof tag.b === "string" && Buffer.from(tag.b, "base64").toString("base64") === tag.b) return [c, Buffer.from(tag.b, "base64")];
    throw new Error("Invalid absorbed value tag");
  }));
}
