import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { listRunsResponsive, readDashboard, type DashboardReadContext } from "../core/dashboard-read.js";
import { normalizeProject } from "../core/decisions.js";
import { ownerQuestionVersion, type OwnerQuestion, type OwnerQuestionStore } from "../core/owner-questions.js";
import type { PeerInfo } from "../core/protocol.js";
import type { ChatItem, Job, Question, Session } from "./contract.js";
import { MobileFault } from "./store.js";

export interface SourceView { sessions: Session[]; jobs: Job[]; questions: Question[]; sampledAt: number; sourceState: "ready" | "offline" | "slow" | "unavailable" }
export interface ContentPage<T> { items: T[]; next: string | null; generation: string; reset: boolean }
export type MobileQuestionStore = Pick<OwnerQuestionStore, "get" | "list" | "answerMobile">;
export interface MobileSource {
  snapshot(): Promise<SourceView>;
  chat(id: string, cursor: string | undefined, limit: number): Promise<ContentPage<ChatItem>>;
  steps(id: string, cursor: string | undefined, limit: number): Promise<ContentPage<{ id: string; text: string; at: number | null }>>;
  answer(id: string, body: { expectedVersion: string; option?: string; text?: string }, deviceId: string, key: string): Promise<Question>;
  /** Only the current questions: no peers, runs or job project discovery (AB-434). */
  questionView?(): Question[];
  /** Local folder of each opaque project id from the latest snapshot, for the desktop owner only; never part of a snapshot. */
  projectFolders?(): ReadonlyMap<string, string>;
}
export const opaqueId = (kind: string, parts: unknown[]): string => createHash("sha256").update(JSON.stringify([kind, ...parts])).digest("base64url");
const version = (value: unknown): string => opaqueId("version", [value]);
export function projectQuestion(q: OwnerQuestion, pcId: string): Question {
  return { id: q.id, kind: "question", pcId, projectId: opaqueId("project", [pcId, normalizeProject(q.project)]), title: q.title, context: q.context, topic: q.topic,
    options: q.options.map(o => ({ id: o.id, label: o.label, consequence: o.consequence, recommended: o.recommended })),
    links: q.links.map(l => ({ kind: l.kind, display: l.kind === "issue" && /^[\w-]{1,100}$/.test(l.value) ? l.value : `${l.kind} reference` })),
    blocking: q.blocking, blocks: q.blocks, meanwhile: q.meanwhile, destructive: q.destructive, authorization: q.authorization, urgency: q.urgency,
    declaredDefault: q.default ? { option: q.default.option, deadline: q.default.deadline } : null, status: q.status, askedAt: q.askedAt, version: ownerQuestionVersion(q),
    answer: q.answer ? { text: q.answer.text, ...(q.answer.option ? { option: q.answer.option } : {}), at: q.answer.at, source: q.answer.source, authorLabel: q.answer.source === "owner" ? "Owner" : "Declared default" } : null,
    deliveries: q.deliveries.map(d => ({ recipientLabel: d.recipient, state: d.state, consumedAt: d.readAt })),
    dismissal: q.dismissal ? { reason: q.dismissal.reason, at: q.dismissal.at, ...(q.dismissal.supersededBy ? { replacementId: q.dismissal.supersededBy } : {}) } : null };
}
interface Binding { kind: "session" | "job"; nativeName: string; generation: string }
/** Fixed local adapter. No caller-controlled upstream path/host/broker opcode. */
export class LocalMobileSource implements MobileSource {
  private bindings = new Map<string, Binding>();
  private folders: ReadonlyMap<string, string> = new Map();
  constructor(private readonly ctx: DashboardReadContext, private readonly questions: MobileQuestionStore,
    readonly pcId: string, private readonly ready: () => boolean, private readonly completeAnswer?: (q: OwnerQuestion) => void,
    private readonly listQuestions: () => OwnerQuestion[] = () => questions.list()) {}
  async snapshot(): Promise<SourceView> {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    const sampledAt = Date.now();
    const peers = (await this.ctx.peers()).filter(p => !p.name.includes("/"));
    const runs = await listRunsResponsive(this.ctx.home);
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    const bindings = new Map<string, Binding>(), folders = new Map<string, string>();
    const project = (folder: string): string => { const id = opaqueId("project", [this.pcId, normalizeProject(folder)]); if (!folders.has(id)) folders.set(id, folder); return id; };
    const sessions = peers.slice(0, 10_000).map((p: PeerInfo): Session => {
      const generation = opaqueId("generation", [p.id, p.sessionId ?? null]), id = opaqueId("session", [this.pcId, p.id, generation]), chatId = opaqueId("chat", [id]);
      if (p.sessionId) bindings.set(chatId, { kind: "session", nativeName: p.name, generation });
      const state = { id, pcId: this.pcId, generation, name: p.name.slice(0, 160), agent: p.agent, projectId: project(p.projectRoot ?? p.cwd), activity: p.activity === "busy" || p.activity === "idle" ? p.activity : "unknown" as const,
        connection: p.unavailable ? "unavailable" as const : "connected" as const, parentId: null, chatId: p.sessionId ? chatId : null, sendSupported: false as const };
      return { ...state, sampledAt, version: version(state) };
    });
    const jobs = runs.slice(0, 10_000).map((r): Job => {
      const id = opaqueId("job", [this.pcId, r.name, r.startedAt]), generation = opaqueId("run", [r.name, r.startedAt]), chatId = opaqueId("chat", [id]);
      bindings.set(id, { kind: "job", nativeName: r.name, generation });
      bindings.set(chatId, { kind: "job", nativeName: r.name, generation });
      // A removed worktree no longer resolves to its checkout; its retained repository root keeps the job in that project.
      const folder = r.workdir && (!r.repoRoot || existsSync(r.workdir)) ? r.workdir : r.repoRoot ?? r.workdir;
      const state = { id, pcId: this.pcId, projectId: folder ? project(folder) : null, parentId: null, title: (r.title ?? r.job ?? r.name).slice(0, 160), status: r.status,
        progress: { percent: typeof r.percent === "number" ? r.percent : null, note: r.progressNote?.slice(0, 500) ?? null, at: r.updatedAt ?? null, etaAt: r.etaAt ?? null, etaReportedAt: r.etaReportedAt ?? null },
        chatId, hasSteps: r.hasLog !== false, archived: r.archived ?? false, recovered: r.recovered ?? false };
      return { ...state, sampledAt, version: version(state) };
    });
    this.bindings = bindings;
    const questions = this.listQuestions().slice(0, 10_000).map(q => { const projected = projectQuestion(q, this.pcId); if (!folders.has(projected.projectId)) folders.set(projected.projectId, q.project); return projected; });
    this.folders = folders;
    return { sessions, jobs, questions, sampledAt, sourceState: "ready" };
  }
  questionView(): Question[] {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    return this.listQuestions().slice(0, 10_000).map(q => projectQuestion(q, this.pcId));
  }
  projectFolders(): ReadonlyMap<string, string> { return this.folders; }
  private async read(binding: Binding, suffix: string, cursor?: string): Promise<unknown> {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    let context = this.ctx;
    const validateRun = async (): Promise<void> => {
      const run = (await listRunsResponsive(this.ctx.home)).find(r => r.name === binding.nativeName);
      if (!run || opaqueId("run", [run.name, run.startedAt]) !== binding.generation) throw new MobileFault(410, "snapshot_required");
    };
    if (binding.kind === "session") {
      const peers = await this.ctx.peers(), peer = peers.find(p => p.name === binding.nativeName && !p.name.includes("/"));
      if (!peer || opaqueId("generation", [peer.id, peer.sessionId ?? null]) !== binding.generation) throw new MobileFault(410, "snapshot_required");
      // Pin the resolved native identity, so a recycled name cannot redirect a granted chat.
      context = { ...this.ctx, peers: () => [peer] };
    } else await validateRun();
    const path = binding.kind === "session" ? `/api/sessions/${encodeURIComponent(binding.nativeName)}/chat` : `/api/runs/${encodeURIComponent(binding.nativeName)}${suffix}`;
    const result = await readDashboard(context, { path, ...(cursor ? { query: { from: cursor } } : {}) });
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    if (binding.kind === "job") await validateRun();
    if (result.status !== 200) throw new MobileFault(result.status === 409 ? 409 : result.status === 404 ? 404 : 503, "source_unavailable");
    return result.body;
  }
  async chat(id: string, cursor: string | undefined, limit: number): Promise<ContentPage<ChatItem>> {
    const binding = this.bindings.get(id); if (!binding) throw new MobileFault(404, "unsupported");
    const result = await this.read(binding, "/chat", cursor ?? "tail") as { items: { id?: string; kind: ChatItem["kind"]; at: number; text?: string; tool?: string; summary?: string }[]; next: string };
    // Bound by bytes in readDashboard; preserve the whole native page in the gateway paging layer.
    const items = result.items.map((item, index): ChatItem => ({ id: item.id ?? opaqueId("item", [id, binding.generation, cursor ?? "tail", index, item.at]), kind: item.kind, at: item.at,
      ...(item.text !== undefined ? { text: item.text.slice(0, 16_000) } : {}), ...(item.tool !== undefined ? { tool: item.tool.slice(0, 160) } : {}), ...(item.summary !== undefined ? { summary: item.summary.slice(0, 1200) } : {}),
      version: version(item), truncated: (item.text?.length ?? 0) > 16_000 || (item.summary?.length ?? 0) > 1200 }));
    return { items, next: result.next && result.next !== cursor ? result.next : null, generation: binding.generation, reset: false };
  }
  async steps(id: string, cursor: string | undefined, limit: number): Promise<ContentPage<{ id: string; text: string; at: number | null }>> {
    const binding = this.bindings.get(id); if (!binding || binding.kind !== "job") throw new MobileFault(404, "unsupported");
    const result = await this.read(binding, "", cursor ?? "0") as { text?: string; next?: number; size?: number; recovered?: boolean };
    if (result.recovered || typeof result.text !== "string") throw new MobileFault(404, "unsupported");
    return { items: [{ id: opaqueId("step", [id, cursor ?? "0"]), text: result.text.slice(0, 128 * 1024), at: null }],
      next: result.next !== undefined && result.next < (result.size ?? 0) ? String(result.next) : null, generation: binding.generation, reset: false };
  }
  async answer(id: string, body: { expectedVersion: string; option?: string; text?: string }, deviceId: string, key: string): Promise<Question> {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    const q = this.questions.answerMobile(id, body, deviceId, key, { id: `owner:mobile:${deviceId}`, name: "Owner (mobile)", agent: "other" });
    // Delivery resumes through the existing service work loop even if this callback fails.
    const latest = this.questions.get(q.id) ?? q;
    try { if (!latest.deliveryComplete) this.completeAnswer?.(latest); } catch { /* Persisted owner intent must not be submitted again. */ }
    return projectQuestion(this.listQuestions().find(latest => latest.id === q.id) ?? q, this.pcId);
  }
}
