export interface KnownFlakyEntry {
  file: string;
  test?: string;
  pattern?: string;
  wholeFile?: true;
  issue: string;
  owner: string;
  added: string;
  recheckBy: string;
  seen?: string;
  regex?: RegExp;
}
export interface KnownFlakyDocument {
  comment?: string;
  entries: KnownFlakyEntry[];
}
export const KNOWN_FLAKY_PATH: string;
export const RECHECK_MAX_DAYS: number;
export const MODES: readonly ["exclude", "only", "off"];
export function knownFlakyMode(value: string | undefined): "exclude" | "only" | "off";
export function readKnownFlaky(root?: string): KnownFlakyDocument;
export function todayUtc(now?: Date): string;
export function describeEntry(entry: Partial<KnownFlakyEntry>): string;
export function validateKnownFlaky(doc: unknown, options?: { root?: string; today?: string }): string[];
export function knownFlakyEntries(root?: string): KnownFlakyEntry[];
export function entryMatches(entry: KnownFlakyEntry, file: string, name: string): boolean;
export function listedFiles(entries: KnownFlakyEntry[]): string[];
export function reportKnownFlaky(entries: KnownFlakyEntry[], dir: string): {
  lanes: string[];
  rows: { entry: KnownFlakyEntry; matched: { lane: string; file: string; name: string; state: string }[]; outcome: string }[];
};
