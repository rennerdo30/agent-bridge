import { en, type MessageKey } from "./messages.js";

export type { MessageKey };

export type Params = Record<string, string | number>;

/**
 * Look up a user-facing message and fill its `{name}` placeholders. All UI text lives in
 * messages.ts; the project ships English only.
 */
export function t(key: MessageKey, params: Params = {}): string {
  const nf = new Intl.NumberFormat();
  return en[key].replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === "number" ? nf.format(value) : value;
  });
}

/** Locale-aware date/time formatting for user-facing output. */
export function formatDateTime(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" }).format(new Date(epochMs));
}
