import type { Question, Job, Session, ChatItem } from "./client";
import type { Snapshot } from "../../../src/mobile/contract";
import { strings as copyStrings } from "./strings";
export type Draft = {
  option: string | null;
  text: string;
};
export const emptyDraft = (): Draft => ({ option: null, text: "" });
export class AnswerLatch {
  busy = false;
  take() {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }
  release() {
    this.busy = false;
  }
}
export type ChatGroup =
  | {
      kind: "steps";
      id: string;
      items: ChatItem[];
    }
  | {
      kind: "message";
      id: string;
      item: ChatItem;
    };
export function chatGroups(items: ChatItem[]): ChatGroup[] {
  const output: ChatGroup[] = [];
  for (const item of mergeChat([], items)) {
    const last = output[output.length - 1];
    if (item.kind === "tool") {
      if (last?.kind === "steps") last.items.push(item);
      else output.push({ kind: "steps", id: item.id, items: [item] });
    } else output.push({ kind: "message", id: item.id, item });
  }
  return output;
}
export function markdownBlocks(text: string): {
  kind: "code" | "heading" | "paragraph";
  text: string;
}[] {
  const output: ReturnType<typeof markdownBlocks> = [];
  let code: string[] | null = null;
  for (const line of text.split("\n")) {
    if (/^```/.test(line)) {
      if (code) {
        output.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else code = [];
    } else if (code) code.push(line);
    else output.push({ kind: /^#{1,3} /.test(line) ? "heading" : "paragraph", text: line.replace(/^#{1,3} /, "") });
  }
  if (code) output.push({ kind: "code", text: code.join("\n") });
  return output;
}
export const draftKey = (s: Pick<Snapshot, "pcId" | "epoch">, q: Question) =>
  JSON.stringify([s.pcId, s.epoch, q.id, q.version]);
export function retainDrafts(drafts: Record<string, Draft>, snapshot: Snapshot | null) {
  const valid = new Set(snapshot?.questions.map((q) => draftKey(snapshot, q)) ?? []);
  return Object.fromEntries(Object.entries(drafts).filter(([key]) => valid.has(key)));
}
export function mayReview(
  q: Question | undefined,
  draft: Draft,
  allowed: boolean,
  pending: boolean,
  unconfirmed: boolean
) {
  return !!q && q.status === "open" && allowed && !pending && !unconfirmed && !!choice(draft);
}
export function choose(
  draft: Draft,
  change:
    | {
        option: string;
      }
    | {
        text: string;
      }
): Draft {
  return "option" in change ? { option: change.option, text: "" } : { option: null, text: change.text.slice(0, 8000) };
}
export function choice(d: Draft):
  | {
      option: string;
    }
  | {
      text: string;
    }
  | null {
  return d.option ? { option: d.option } : d.text.trim() ? { text: d.text } : null;
}
export function stillConfirmed(
  key: string,
  snapshot: Snapshot | null,
  q: Question | undefined,
  allowed: boolean
): boolean {
  return !!snapshot && !!q && q.status === "open" && allowed && draftKey(snapshot, q) === key;
}
export function questionList(items: Question[], history: boolean) {
  return items
    .filter((q) => (q.status !== "open") === history)
    .sort(
      history
        ? (a, b) => (b.answer?.at ?? b.dismissal?.at ?? b.askedAt) - (a.answer?.at ?? a.dismissal?.at ?? a.askedAt)
        : (a, b) =>
            Number(b.urgency === "urgent") - Number(a.urgency === "urgent") ||
            Number(b.blocking) - Number(a.blocking) ||
            a.askedAt - b.askedAt ||
            a.id.localeCompare(b.id)
    );
}
export type JobFilter = "all" | "working" | "failed" | "done";
export const filterJobs = (items: Job[], filter: JobFilter) =>
  items
    .filter((j) => filter === "all" || j.status === (filter === "working" ? "running" : filter))
    .sort(
      (a, b) =>
        Number(b.status === "running") - Number(a.status === "running") ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id)
    );
export function groups(items: Session[], search: string) {
  const grouped = new Map<string, Session[]>();
  const keys = [...new Set(items.map((s) => s.projectId).filter((v): v is string => !!v))].sort();
  for (const s of items.filter((s) => `${s.name} ${s.agent}`.toLowerCase().includes(search.toLowerCase()))) {
    const title = s.projectId ? copyStrings.labels.project(keys.indexOf(s.projectId) + 1) : copyStrings.labels.sessions;
    grouped.set(title, [...(grouped.get(title) ?? []), s]);
  }
  return [...grouped].map(([title, sessions]) => ({
    title,
    sessions: sessions.sort(
      (a, b) => Number(b.activity === "busy") - Number(a.activity === "busy") || a.name.localeCompare(b.name)
    ),
  }));
}
export function stats(sessions: Session[], jobs: Job[], bounded: boolean) {
  return [
    {
      value: jobs.filter((j) => j.status === "running").length,
      label: copyStrings.labels.stats.working[bounded ? "loaded" : "all"],
      tone: "accent" as const,
    },
    {
      value: sessions.length,
      label: copyStrings.labels.stats.sessions[bounded ? "loaded" : "all"],
      tone: "text" as const,
    },
    {
      value: jobs.filter((j) => j.status === "failed").length,
      label: copyStrings.labels.stats.failed[bounded ? "loaded" : "all"],
      tone: "bad" as const,
    },
  ];
}
export function mergeChat(prior: ChatItem[], incoming: ChatItem[]) {
  return [...new Map([...prior, ...incoming].map((i) => [i.id, i])).values()].slice(-3000);
}
export function eta(at: number | null, now = Date.now()) {
  if (!at) return copyStrings.relativeTime.etaNotReported;
  const minutes = Math.ceil((at - now) / 60000);
  return minutes <= 0
    ? copyStrings.relativeTime.etaPassed
    : minutes < 90
      ? copyStrings.relativeTime.minutesLeft(minutes)
      : copyStrings.relativeTime.hoursLeft((minutes / 60).toFixed(1));
}
export function age(at: number, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  return minutes < 1
    ? copyStrings.relativeTime.now
    : minutes < 60
      ? copyStrings.relativeTime.minutes(minutes)
      : minutes < 1440
        ? copyStrings.relativeTime.hours(Math.floor(minutes / 60))
        : new Date(at).toLocaleDateString();
}
