export interface KnownFlakyEntry {
  file: string;
  test: string;
  issue: string;
  owner: string;
  added: string;
  recheckBy: string;
  seen?: string;
}
export interface KnownFlakyDocument {
  comment?: string;
  entries: KnownFlakyEntry[];
}
export interface KnownFlakyDecision {
  name: string;
  userAllows: boolean;
  listed: boolean;
  run: boolean;
}
export interface KnownFlakyFileFilter {
  file: string;
  mode: "exclude" | "only";
  user: RegExp | undefined;
  listedNames: Set<string>;
  decisions: KnownFlakyDecision[];
  matcher: { [Symbol.match](name: string): RegExpMatchArray | null; source: string; toString(): string };
}
export const KNOWN_FLAKY_PATH: string;
export const RECHECK_MAX_DAYS: number;
export const MODES: readonly ["exclude", "only", "off"];
export const MATCH_EVERYTHING_SOURCE: string;
export const SKIPS_DIR: string;
export function knownFlakyMode(value: string | undefined): "exclude" | "only" | "off";
export function readKnownFlaky(root?: string): KnownFlakyDocument;
export function todayUtc(now?: Date): string;
export function describeEntry(entry: Partial<KnownFlakyEntry>): string;
export function validateKnownFlaky(doc: unknown, options?: { root?: string; today?: string }): string[];
export function knownFlakyEntries(root?: string): KnownFlakyEntry[];
export function entryMatches(entry: KnownFlakyEntry, file: string, name: string): boolean;
export function listedFiles(entries: KnownFlakyEntry[]): string[];
export function createFileFilter(entries: KnownFlakyEntry[], file: string, mode: "exclude" | "only" | "off", user?: RegExp): KnownFlakyFileFilter | undefined;
export function verifyFileDecisions(filter: KnownFlakyFileFilter, tests: { name: string; mode: string }[]): string[];
export function skippedByList(filter: KnownFlakyFileFilter): string[];
export function writeSkipRecord(dir: string, lane: string, file: string, skipped: string[]): void;
export function checkSkips(entries: KnownFlakyEntry[], dir: string): {
  lanes: { lane: string; skipped: number; expected: number }[];
  problems: string[];
};
export function reportKnownFlaky(entries: KnownFlakyEntry[], dir: string): {
  lanes: string[];
  rows: { entry: KnownFlakyEntry; matched: { lane: string; file: string; name: string; state: string }[]; outcome: string }[];
};
