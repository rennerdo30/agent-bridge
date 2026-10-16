import { realpathSync } from "node:fs";
import { discoverDriveAliases, type DriveMapping } from "../core/display-paths.js";
import { neutralizeMarkup } from "./format.js";

/**
 * AB-404: one MCP tool result (or hook context) stays below this many UTF-8 bytes of its serialized content array,
 * `JSON.stringify([{ type: "text", text }, ...])`. The margin leaves room for the JSON-RPC envelope and fields
 * added after bounding (request id, isError, structuredContent).
 */
export const MCP_RESULT_MAX_BYTES = 180_000;
export const MCP_RESULT_MARGIN_BYTES = 4_096;
export const MCP_RESULT_BUDGET_BYTES = MCP_RESULT_MAX_BYTES - MCP_RESULT_MARGIN_BYTES;

/** Serialized size of a result's text content, exactly as the transport writes it. */
export function mcpContentBytes(texts: readonly string[]): number {
  return Buffer.byteLength(JSON.stringify(texts.map((text) => ({ type: "text", text }))), "utf8");
}

export function fitsMcpResult(texts: readonly string[] | string, budget = MCP_RESULT_BUDGET_BYTES): boolean {
  const list = typeof texts === "string" ? [texts] : texts;
  // A UTF-16 unit costs at most six bytes as escaped JSON; skip the exact count for clearly small results.
  if (list.reduce((sum, text) => sum + text.length, 0) * 6 + 64 * (list.length + 1) < budget) return true;
  return mcpContentBytes(list) <= budget;
}

/** Bytes one line adds inside a JSON string, including its joining newline (escaped, two bytes). */
function lineBytes(line: string): number { return Buffer.byteLength(JSON.stringify(line), "utf8"); }

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** A slice that never separates the halves of a surrogate pair (a start inside a pair moves back to include it). */
export function sliceWhole(value: string, start: number, end = value.length): string {
  start = Math.max(0, Math.min(start, value.length));
  end = Math.max(start, Math.min(end, value.length));
  if (start > 0 && start < value.length && isLow(value.charCodeAt(start)) && isHigh(value.charCodeAt(start - 1))) start--;
  if (end > start && end < value.length && isHigh(value.charCodeAt(end - 1)) && isLow(value.charCodeAt(end))) end--;
  return value.slice(start, end);
}

/** Longest whole-character prefix length of `value` for which `fits` holds (binary search, O(log n) checks). */
export function longestFittingPrefix(value: string, fits: (prefix: string) => boolean): number {
  let low = 0, high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(sliceWhole(value, 0, mid))) low = mid; else high = mid - 1;
  }
  return sliceWhole(value, 0, low).length;
}

const DEFAULT_HINT = "Narrow the query or request a smaller page.";

/**
 * Last-resort bound for a finished result. A JSON array keeps its shape: whole leading items, then a separate text
 * item that says how many were shown and how to get the rest. Other JSON becomes
 * `{ truncated, totalCharacters, hint, preview }`; plain text keeps a shortened-output note with the hint.
 */
export function boundMcpTexts(texts: readonly string[], hint = DEFAULT_HINT, budget = MCP_RESULT_BUDGET_BYTES): string[] {
  if (fitsMcpResult(texts, budget)) return [...texts];
  const value = texts.join("\n");
  const trimmed = value.trimStart();
  let parsed: unknown, isJson = false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { parsed = JSON.parse(value); isJson = true; } catch { isJson = false; }
  }
  if (isJson && Array.isArray(parsed)) {
    const items = parsed;
    const render = (count: number) => [JSON.stringify(items.slice(0, count)),
      `[Result shortened: showing ${count} of ${items.length} items to stay within the MCP result limit. ${hint}]`];
    let low = 0, high = items.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fitsMcpResult(render(mid), budget)) low = mid; else high = mid - 1;
    }
    if (low > 0) return render(low);
  }
  if (isJson) {
    const wrap = (preview: string) => JSON.stringify({ truncated: true, totalCharacters: value.length, hint, preview });
    return [wrap(sliceWhole(value, 0, longestFittingPrefix(value, (prefix) => fitsMcpResult(wrap(prefix), budget))))];
  }
  const note = (shown: number) => `\n[Output shortened from ${value.length} to ${shown} characters to stay within the MCP result limit. ${hint}]`;
  const length = longestFittingPrefix(value, (prefix) => fitsMcpResult(prefix + note(value.length), budget));
  return [sliceWhole(value, 0, length) + note(length)];
}

export function boundMcpText(value: string, hint = DEFAULT_HINT, budget = MCP_RESULT_BUDGET_BYTES): string {
  return boundMcpTexts([value], hint, budget).join("\n");
}

/** A listing line: always-shown information, a category header (shown with its entries) or a pageable entry. */
export type ListingLine =
  | { info: string }
  | { header: string; category: string }
  | { entry: string; category: string };

export interface ListingPage { text: string; shown: number; total: number; nextOffset: number | null }

/**
 * Page only the entries of a listing; information lines stay on every page and a header appears with its entries.
 * Entries keep the caller's deterministic order, so `offset` addresses the same entry on every call. Without
 * limit/offset a listing that fits is returned whole with no paging note; with them it keeps the same full format.
 * Sizes are added up per line against the serialized result, so building a page is linear in the listing.
 */
export function pageListing(lines: readonly ListingLine[], options: { offset?: number; limit?: number; hint: string },
  budget = MCP_RESULT_BUDGET_BYTES): ListingPage {
  const entries = lines.flatMap((line, index) => "entry" in line ? [index] : []);
  const total = entries.length, offset = Math.min(Math.max(0, options.offset ?? 0), total);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const render = (selected: ReadonlySet<number>, footer: string | null, shortened?: ReadonlyMap<number, string>) => {
    const categories = new Set([...selected].map((index) => (lines[index] as { category: string }).category));
    const out: string[] = [];
    lines.forEach((line, index) => {
      if ("info" in line) out.push(line.info);
      else if ("header" in line) { if (categories.has(line.category)) out.push(line.header); }
      else if (selected.has(index)) out.push(shortened?.get(index) ?? line.entry);
    });
    if (footer) out.push(footer);
    return out.join("\n");
  };
  const footer = (shown: number) => {
    const next = offset + shown < total ? offset + shown : null;
    if (next === null && offset === 0 && options.limit === undefined) return null;
    return `[Showing entries ${shown ? offset + 1 : offset}-${offset + shown} of ${total}; ` +
      `${next === null ? "last page" : `next page: offset=${next}`}. ${options.hint}]`;
  };
  // A header costs bytes only with the first selected entry of its category.
  const headerOf = new Map<string, string>();
  for (const line of lines) if ("header" in line && !headerOf.has(line.category)) headerOf.set(line.category, line.header);
  const longestFooter = `[Showing entries ${total}-${total} of ${total}; next page: offset=${total}. ${options.hint}]`;
  let bytes = mcpContentBytes([render(new Set(), longestFooter)]);
  const selected = new Set<number>(), seen = new Set<string>();
  let shortened: Map<number, string> | undefined;
  for (let i = offset; i < total && selected.size < limit; i++) {
    const index = entries[i]!, line = lines[index] as { entry: string; category: string };
    const header = !seen.has(line.category) ? headerOf.get(line.category) : undefined;
    const headerBytes = header === undefined ? 0 : lineBytes(header);
    let cost = headerBytes + lineBytes(line.entry);
    if (bytes + cost > budget) {
      if (selected.size > 0) break;
      // A single entry too large for any page is shortened (with a marker) instead of blocking every later page.
      const marker = " [entry shortened]", room = budget - bytes - headerBytes;
      const length = longestFittingPrefix(line.entry, (prefix) => lineBytes(prefix + marker) <= room);
      const short = sliceWhole(line.entry, 0, length) + marker;
      shortened = new Map([[index, short]]);
      cost = headerBytes + lineBytes(short);
    }
    selected.add(index);
    seen.add(line.category);
    bytes += cost;
  }
  let text = render(selected, footer(selected.size), shortened);
  // The information lines alone may still exceed the budget.
  if (!fitsMcpResult(text, budget)) text = boundMcpText(text, options.hint, budget);
  const shown = selected.size;
  return { text, shown, total, nextOffset: offset + shown < total ? offset + shown : null };
}

export interface DeliverySelection<T> { shown: T[]; oversized: T[]; deferred: T[] }

/**
 * Choose the messages that can be shown in full within the budget, keeping their order. A message that cannot fit
 * even alone is `oversized` (listed by id instead and left unread); it never blocks the messages after it. Once a
 * fitting message no longer fits, it and every later message are `deferred` (left unread for the next call).
 * Each message is measured once and the final rendering is checked once, so selection is linear.
 *
 * `standalone` renders without a one-time prefix (for example parent-link messages that come only once). Whether a
 * message is oversized is decided with it, so a large prefix never makes a normal message count as oversized for
 * good; a message that only the prefix pushes over the budget is deferred to the next call instead.
 */
export function selectForDelivery<T>(messages: readonly T[], render: (shown: T[], oversized: T[], deferred: T[]) => string,
  measure: (message: T) => string, budget = MCP_RESULT_BUDGET_BYTES,
  standalone: (shown: T[], oversized: T[], deferred: T[]) => string = render): DeliverySelection<T> {
  const shown: T[] = [], oversized: T[] = [], deferred: T[] = [];
  let bytes = mcpContentBytes([render([], [], [...messages])]), full = false;
  const empty = mcpContentBytes([standalone([], [], [])]);
  // Render a message alone only when it is near or over the budget by itself (rare), never for every message.
  const fitsAlone = (message: T, cost: number) => empty + cost <= budget - 4_096 || mcpContentBytes([standalone([message], [], [])]) <= budget;
  for (const message of messages) {
    const cost = lineBytes(measure(message)) + 16;
    if (!full && bytes + cost <= budget) { shown.push(message); bytes += cost; continue; }
    if (fitsAlone(message, cost)) { deferred.push(message); full = true; }
    else oversized.push(message);
  }
  // Notes and reply hints are outside the per-message estimate: confirm, and defer from the end if needed.
  while (shown.length && !fitsMcpResult(render(shown, oversized, deferred), budget)) {
    const last = shown.pop()!;
    if (shown.length) { deferred.unshift(last); continue; }
    // The first message does not fit even alone with the fixed notes: page it instead of deferring it forever,
    // unless only the one-time prefix is in the way (the next call, without it, shows the message).
    if (fitsMcpResult(standalone([last], oversized, deferred), budget)) deferred.unshift(last); else oversized.unshift(last);
  }
  return { shown, oversized, deferred };
}

/** Notes for messages that stay unread because they were not shown in full. */
export function unshownMessageNotes(oversized: readonly { id: string; from: { name: string }; body: string }[], deferred: number,
  pageCall: (id: string) => string): string[] {
  // The sender's name and the id come from a peer: no agent-bridge markup may pass through them (AB-404).
  const notes = oversized.map((m) => neutralizeMarkup(`[agent-bridge] Message ${m.id} from ${m.from.name} (${m.body.length} characters) is too large to show in one result; ` +
    `it stays unread. Read it in pages with ${pageCall(m.id)}.`));
  if (deferred > 0) notes.push(`[agent-bridge] ${deferred} more unread message(s) did not fit this result; they stay unread for the next call.`);
  return notes;
}

/** The largest page of one message body from `offset` that fits; `end` is where the next page starts. */
export function messageBodyPage(body: string, offset: number, render: (slice: string, start: number, end: number) => string,
  budget = MCP_RESULT_BUDGET_BYTES): { text: string; start: number; end: number } {
  const start = body.length - sliceWhole(body, offset).length;
  const rest = body.slice(start);
  const length = longestFittingPrefix(rest, (prefix) => fitsMcpResult(render(prefix, start, start + prefix.length), budget));
  const end = start + length;
  return { text: render(body.slice(start, end), start, end), start, end };
}

/** Comparable physical spelling of a path: subst drive aliases (E: = D:), separators and case unify. */
export function projectPathKey(path: string, canonical: (path: string) => string = realpathSync.native,
  mappings: readonly DriveMapping[] = discoverDriveAliases(), platform: string = process.platform): string {
  let value = path.trim();
  try { value = canonical(value); }
  catch {
    // A folder that no longer exists still maps through the verified drive aliases.
    const drive = /^[a-z]:/i.exec(value)?.[0]?.toUpperCase();
    const mapping = drive ? mappings.find((m) => m.alias.slice(0, 2).toUpperCase() === drive) : undefined;
    if (mapping) value = mapping.real.slice(0, 2) + value.slice(2);
  }
  value = value.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? value.toLowerCase() : value;
}

/**
 * The peers `project` filter: an absolute path matches that folder and everything below it by physical identity;
 * other text is a case-insensitive substring of the normalized or the original path.
 */
export function projectFilter(filter: string | undefined, key: (path: string) => string = projectPathKey):
  ((paths: readonly (string | null | undefined)[]) => boolean) | null {
  if (!filter) return null;
  const cache = new Map<string, string>();
  const keyOf = (path: string) => { let k = cache.get(path); if (k === undefined) { k = key(path); cache.set(path, k); } return k; };
  const absolute = /^(?:[a-z]:(?:[\\/]|$)|\/|\\\\)/i.test(filter);
  const wanted = absolute ? key(filter) : filter.replace(/\\/g, "/").toLowerCase();
  return (paths) => paths.some((path) => {
    if (!path) return false;
    const k = keyOf(path);
    if (absolute) return k === wanted || k.startsWith(`${wanted}/`);
    return k.toLowerCase().includes(wanted) || path.replace(/\\/g, "/").toLowerCase().includes(wanted);
  });
}
