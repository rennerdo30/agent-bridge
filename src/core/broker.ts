import { HistoryBackground } from "./history-background.js";
import { NativeChildren, isNativeChildAddress } from "./native-children.js";
import { HealthMonitor } from "./health.js";
import { loadConfig } from "./config.js";
import { conversationPageSchema } from "./conversations.js";
import { historySearchSchema } from "./history.js";
import { ReadJournal } from "./read-journal.js";
import { recordStorePeer, refreshStorePeerIdentities, validStoreCapabilities } from "./store-compatibility.js";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readMusePrivateJson, readMusePrivateJsonAsync, writeMusePrivateJsonAsync } from "./muse-context.js";
import { ownProcessIdentity, processIdentity, readProcessIdentities } from "./process-identity.js";
import { isPluginCacheCwd } from "./session-visibility.js";
import { createServer, type Server, type Socket } from "node:net";
import {
  APP_VERSION,
  DEFAULT_MAX_HOPS,
  HOOK_MAX_MESSAGES,
  MAX_BODY_CHARS,
  BROKER_TESTED_JOB_LOAD,
  MAX_FRAME_BYTES,
  HANDOVER_DRAIN_MS,
  HANDOVER_MARKER_FILE,
  HANDOVER_REPEAT_WINDOW_MS,
  isNewerRelease,
  MESSAGE_TTL_MS,
  PROTOCOL_VERSION,
  PURGE_INTERVAL_MS,
  QUEUED_MAIL_MAX_AGE_MS,
} from "./constants.js";
import type { Logger } from "./logger.js";
import { isSqliteBusy } from "./sqlite-policy.js";
import {
  AGENT_KINDS,
  BROADCAST,
  BridgeError,
  encodeFrame,
  FrameDecoder,
  SIBLING_CONVERSATION_PREFIX,
  SIBLING_NOTE_SUFFIX,
  isQuietMessage,
  isJobQuestion,
  type AgentKind,
  type BridgeMessage,
  type EventFrame,
  type EventMap,
  type EventName,
  type Op,
  type PeerInfo,
  type RequestFrame,
  type RequestMap,
  type SiblingPeer,
  type SendModeReport,
} from "./protocol.js";
import { agentQueueKey, MessageStore, registrationIdentity } from "./store.js";
import { sameFrontend, t3BindingSchema } from "./t3-identity.js";
import { tokensEqual } from "./token.js";
import { commitHandoff, handoffJournal, handoffSchema, type HandoffReceipt } from "./job-handoff.js";
import { setTimeout as delay } from "node:timers/promises";
import { canControlJob, mastersFor, chooseJobRecipient, primaryFor } from "./job-ownership.js";
import { RootConcurrency } from "./root-concurrency.js";
import { isRecord, retentionLimit } from "./json-store.js";
import { quarantineMessage } from "./oversize.js";
import { readArchivedJobSnapshot } from "./job-archive.js";
import { JobArchiveBackground } from "./job-archive-background.js";
import { startBrokerJobRunIndex, stopJobRunBackfill } from "./job-run-index.js";
import { indexedJobProjectionCurrent, readIndexedJobs } from "./job-archive-index.js";
import { readJsonSnapshot, type JsonSnapshot } from "./file-cache.js";
import { completionMessageId, COMPLETION_DEDUPE_PREFIX } from "./completion.js";
import { projectAskCompletions } from "./ask-completion.js";
import { isJobSendTarget, MAX_JOB_SEND_TARGETS } from "./job-messaging.js";
import { NetworkService, type NetworkStatus } from "../network/link.js";
import { readNetworkConfig, writeNetworkConfig, type NetworkConfig } from "../network/config.js";
import { z } from "zod";
import { basename, dirname, isAbsolute, join } from "node:path";
import { platform as hostPlatform } from "node:process";
import { ProjectGroups } from "./project-groups.js";
import { accessJobChecklist, jobChecklistRequestSchema, readChecklistAuthority } from "./checklists.js";
import { recoverJobRecordAsync, type RecoveryRefusal } from "./job-recovery.js";
import { findHistoryJob, selectHistoryJobs } from "./run-history.js";
import { pageProjectJobSummaries, PROJECT_JOB_SUMMARY_PAGE_MAX } from "./project-job-summary.js";
import { collectTransfer, receiveTransfer, type TransferResult } from "../network/files.js";
import { cancelStoredTransfer, MAX_STREAM_ENTRIES, readTransferHistory, type TransferStarted } from "../network/transfers.js";
import { MAX_NETWORK_HOST_CHARS, MAX_PAIRING_CODE_CHARS, MAX_PORT } from "../network/constants.js";
import { RemoteDashboard, dashboardError } from "../network/remote-dashboard.js";
import { RemoteJobs } from "../network/remote-jobs.js";
import { DecisionSync } from "../network/decision-sync.js";
import { CONTROL_CONVERSATION_PREFIX } from "../mcp/job-host.js";
import { DASHBOARD_JOB_CONVERSATION } from "./job-control.js";
import { DECISION_MESSAGE_HOP, MAX_DECISION_TEXT_CHARS, MAX_DECISION_TOPIC_CHARS, decisionApplies, decisionScopeSchema, type OwnerDecision } from "./decisions.js";
import { askOwnerSchema, questionAnswerSchema, QUESTIONS_FILE } from "./owner-questions.js";
import { OwnerQuestionService, OWNER_ADDRESS } from "./owner-question-service.js";
import { BROKER_TCP_FILE, ensurePrivateSocketDirectory, isEphemeralBrokerTcpRecord, resolvePipePath } from "./paths.js";
import { hasEndpointActivationWitness, type EndpointReservation } from "./endpoint-reservation.js";

export type LifecycleServingPhase = "admission" | "prepare" | "write";
/** Opaque source capability. Shape/copy/serialized flags never confer authority. */
export interface LifecycleServingCapability { readonly __servingCapability?: never }
const SERVING_PHASE_MS = { admission: 1000, prepare: 5000, write: 2000 } as const;
type ServingBinding = { server: Server; ownerInstance: string; generation: number; home: string; identity: string; endpoint: string; revoked: boolean; current(): boolean };
const servingBindings = new WeakMap<Broker, ServingBinding>();
const servingCapabilities = new WeakMap<LifecycleServingCapability, { binding: ServingBinding; generation: number; phase: LifecycleServingPhase; expires: number }>();
function servingHomeIdentity(home: string): string {
  const stat = lstatSync(home, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino <= 0n || stat.dev < 0n || process.platform === "win32" && stat.dev === 0n) throw Error("unknown");
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
function unavailableServing(): never { throw new BridgeError("bad_request", "Core lifecycle serving authority is unavailable."); }
/** Internal consumer validation only; no factory, protocol handler, role flag or fixture mint. */
export function assertLifecycleServingCapability(capability: LifecycleServingCapability, phase: LifecycleServingPhase): Readonly<{ ownerInstance: string; generation: number; home: string; endpoint: string }> {
  const grant = servingCapabilities.get(capability);
  if (!grant || grant.phase !== phase || performance.now() >= grant.expires || grant.binding.revoked || grant.generation !== grant.binding.generation) unavailableServing();
  try {
    if (!grant.binding.current() || !grant.binding.server.listening || grant.binding.server.address() !== grant.binding.endpoint || servingHomeIdentity(grant.binding.home) !== grant.binding.identity) unavailableServing();
  } catch { unavailableServing(); }
  return Object.freeze({ ownerInstance: grant.binding.ownerInstance, generation: grant.generation, home: grant.binding.home, endpoint: grant.binding.endpoint });
}

/** Peer names double as offline queue keys, so keep them simple and unambiguous. */
export const PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PENDING_DEFAULT_LIMIT = 50;
/** How long, and how many, send dedupe keys are remembered (retries come within minutes). */
const DEDUPE_KEEP_MS = 30 * 60 * 1000;
const DEDUPE_MAX = 5_000;
const PENDING_MAX_LIMIT = 500;
const NAME_SUFFIX_LIMIT = 100;
const MAX_FILE_ADDRESS_CHARS = 256;
const MAX_FILE_PATH_CHARS = 1_024;
/** Pause reasons are bounded wherever they are relayed (the same limit as the pause_subagent tool). */
const MAX_PAUSE_REASON_CHARS = 500;
const SIBLING_STATUSES = new Set<SiblingPeer["status"]>(["running", "paused", "done", "failed", "interrupted", "cancelled"]);
const MAX_INFLIGHT_PER_CONNECTION = 128;
const PAUSE_INFLIGHT_PER_CONNECTION = 32;
const MAX_CONNECTION_BUFFER_BYTES = 4 * MAX_FRAME_BYTES;
/** Allow the existing 5s OS probe budget, while staying below the 10s RPC deadline. */
const HANDOFF_STORE_READY_MS = 5_500;

type StoredSibling = SiblingPeer & { id: string; report: string | null };
type QueueRegistration = Pick<PeerInfo, "id" | "name" | "sessionId"> & { generation: number };
type ProjectMainIdentity = Pick<PeerInfo, "id" | "agent" | "sessionId" | "name" | "frontend">;
const ownsProjectMain = (owner: ProjectMainIdentity, peer: ProjectMainIdentity) => owner.agent === peer.agent && sameFrontend(owner, peer) &&
  (owner.frontend ? true : owner.sessionId ? owner.sessionId === peer.sessionId : owner.id === peer.id);

interface Conn {
  socket: Socket;
  peer: PeerInfo | null;
  /** Presented the right token (via hello or auth). */
  authed: boolean;
  inFlight: number;
  mailGeneration: number;
  /** Published only after this exact registration finished queued-mail expiry. */
  mailReady?: QueueRegistration;
  /** The listener that accepted it: only local-pipe peers share this machine's PID namespace (AB-399). */
  transport: "pipe" | "tcp";
  /** AB-399: the broker found this session's CLI process gone and told the server to stay off the bridge. */
  retired?: boolean;
  /** Its hello finished; until then the hello's own reply must reach the server before any retirement. */
  registered?: boolean;
  /** Last cheap signal-0 probe of the session's CLI process (see hostExited). */
  hostProbe?: { at: number; exited: boolean };
  /** The broker's own first identity reading of the session's CLI (POSIX without exact start ticks). */
  hostBaseline?: string;
}

/**
 * AB-399: CLIs that start the bridge MCP server as their own child, so the hello's agentPid is the session's
 * process. Other hosts are exempt from retirement: opencode can host the server through a launcher or in-process,
 * Antigravity and Muse servers report helper processes (their hooks resolve hosts via antigravityAncestor and
 * museHostPid), and "other" covers the dashboard "you" peer and CLI peers inside the broker daemon.
 */
const RETIRABLE_AGENTS: ReadonlySet<string> = new Set(["claude", "codex"]);
/** Reuse of a signal-0 probe within one burst of view/send work (peers decorates every member). */
const HOST_PROBE_MS = 1_000;
/**
 * Background creation-identity check of connected sessions (one batch query, never on a request). It only catches
 * PID reuse (ESRCH is checked inline) and current servers already exit on parent loss (watchParent), so it runs at
 * watchParent's identity cadence: on Windows each sweep starts one PowerShell process.
 */
const LIVENESS_SWEEP_MS = 10 * 60_000;
/** Coarse start-time resolution (ps lstart has seconds) must never read as a later start. */
const PID_REUSE_SLACK_MS = 2_000;
const MAX_AGENT_HOSTS = 4_096;
/** A retired project main gets its role back only when its session reconnects within this window (AB-399). */
const RETIRED_MAIN_GRACE_MS = 5 * 60_000;

/**
 * The start time (epoch ms) a process identity describes, or undefined when it cannot be read. Windows ticks and
 * Linux boot-relative clock ticks (same boot only) are exact; macOS `ps -o lstart` prints local time, so it is
 * parsed as local time here (identityStartedAfter would read it as UTC and shift it by the zone offset).
 */
function identityStartMs(identity: string): number | undefined {
  if (process.platform === "win32") return /^\d{1,24}$/.test(identity) ? Number((BigInt(identity) - 621355968000000000n) / 10000n) : undefined;
  if (process.platform === "linux") {
    const match = /^(.+):(\d+)$/.exec(identity);
    if (!match) return undefined;
    try {
      if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== match[1]) return undefined;
      const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
      // Linux reports start times in clock ticks; USER_HZ is 100 on every supported build.
      return Number.isFinite(btime) ? btime * 1000 + Number(match[2]) * 10 : undefined;
    } catch { return undefined; }
  }
  const startedAt = Date.parse(identity);
  return Number.isFinite(startedAt) ? startedAt : undefined;
}

/** Whether a process identity proves a start after `at`. An unparseable identity proves nothing. */
function provenStartedAfter(identity: string, at: number): boolean {
  const startedAt = identityStartMs(identity);
  return startedAt !== undefined && startedAt > at;
}

/** Operations allowed before a connection has authenticated. */
const UNAUTHENTICATED_OPS = new Set<string>(["hello", "auth", "ping"]);

type Handler<O extends Op> = (conn: Conn, args: RequestMap[O][0]) => RequestMap[O][1] | Promise<RequestMap[O][1]>;

/**
 * The broker routes messages between peers. Exactly one process per endpoint runs it: whichever
 * agent-bridge MCP server bound the pipe first. It persists every message so peers that are offline,
 * or a broker hand-over, lose nothing.
 */

/** A handoff commit retries a briefly held registry lease asynchronously, as long as a blocking writer would wait. */
const HANDOFF_LOCK_WAIT_MS = 2_000;
const HANDOFF_LOCK_RETRY_MS = 25;
/** Qualification only: no resolution/probe, normalization or new grant. Stored context remains unchanged. */
function checklistDiscoveryPath(cwd: string): boolean {
  if (hostPlatform !== "win32") return isAbsolute(cwd);
  if (cwd.includes("\0")) return false;
  const uncShare = (value: string) => {
    const match = /^([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/.exec(value);
    return Boolean(match && match.slice(1).every(part => !/^[. ]+$/.test(part) && !/[<>:"|?*\u0000-\u001f]/.test(part)));
  };
  // Extended filesystem paths have literal backslashes; other device/NT namespaces are not project roots.
  if (cwd.startsWith("\\\\?\\")) {
    const path = cwd.slice(4);
    if (path.includes("/")) return false;
    if (/^[a-z]:\\/i.test(path) || /^Volume\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}\\/i.test(path)) return true;
    return /^UNC\\/i.test(path) && uncShare(path.slice(4));
  }
  // A rooted slash alone still depends on the current drive. UNC needs BOTH server and share.
  return /^[a-z]:[\\/]/i.test(cwd) || /^[\\/]{2}/.test(cwd) && uncShare(cwd.slice(2));
}

/** Retained relative context has no original cwd witness here. Preserve current project roles,
 * but never rediscover these paths against the broker's unrelated current directory. */
class ChecklistProjectGroups extends ProjectGroups {
  override root(cwd: string): string | null {
    return checklistDiscoveryPath(cwd) ? super.root(cwd) : null;
  }
}

export class Broker {
  private hosting: { mode: "daemon" | "embedded" | "embedded_degraded"; reason?: string } = { mode: "embedded" };
  setHostingMode(mode: "daemon" | "embedded_degraded", reason?: "windows_wmi_unavailable" | "windows_wmi_create_rejected"): void {
    this.hosting = { mode, ...(reason ? { reason } : {}) };
  }
  private handoverHandler: ((target: EventMap["handover"]) => void) | undefined;
  private draining = false;
  private activeRequests = 0;
  private readonly drainWaiters = new Set<() => void>();
  private idle: { ms: number; onIdle: () => void; keepAlive?: () => string | undefined; timer: NodeJS.Timeout | null } | undefined;
  /**
   * Daemon hosting only: an authenticated client of a newer release (APP_VERSION or PROTOCOL_VERSION) asks this
   * broker to step aside. The broker stops admitting work at once; the handler drains, closes and exits, and the
   * newer client then demand-starts its own release. Embedded brokers never hand over (they live with a session).
   */
  onNewerClient(handler: (target: EventMap["handover"]) => void): void { this.handoverHandler = handler; }
  /**
   * Daemon hosting only: call onIdle once nothing has been served for `ms`. Served means a pipe/TCP client of
   * another process, a pending remote-job request or start, a connected paired PC, or whatever the host's
   * `keepAlive` names (open dashboard HTTP/SSE clients, an active mobile connection). Client connections
   * start and stop the timer; the other sources are checked when it fires and re-arm it while they last.
   */
  exitWhenIdle(ms: number, onIdle: () => void, keepAlive?: () => string | undefined): void {
    if (this.idle?.timer) clearTimeout(this.idle.timer);
    this.idle = { ms, onIdle, keepAlive, timer: null };
    this.updateIdle();
  }
  /** Why the daemon is still serving without a connected client, or undefined when it is idle. */
  private idleKeepAlive(): string | undefined {
    if (this.remoteJobs?.busy) return "remote_job_admission";
    if (this.network?.activeLinks) return "paired_pc_link";
    try { return this.idle?.keepAlive?.(); } catch { return "keep_alive_unknown"; }
  }
  get isDraining(): boolean { return this.draining; }
  private updateIdle(): void {
    const idle = this.idle;
    if (!idle) return;
    // The daemon's own dashboard sender registers from this process; it is not a client to stay up for.
    const served = () => [...this.conns].some(c => c.peer?.pid !== process.pid);
    if (served() || this.draining || this.closing) {
      if (idle.timer) { clearTimeout(idle.timer); idle.timer = null; }
      return;
    }
    const arm = () => setTimeout(() => {
      idle.timer = null;
      if (this.idle !== idle || served() || this.draining || this.closing) return;
      const reason = this.idleKeepAlive();
      if (reason) { this.log.debug("no client connected, but still serving; idle period restarts", { reason }); idle.timer = arm(); return; }
      this.log.info("no client connected; daemon exits after its idle period", { idleMs: idle.ms });
      idle.onIdle();
    }, idle.ms);
    idle.timer ??= arm();
  }
  private handoverRefusal(op: string): BridgeError {
    // auth/hello answer like an incompatible broker, so every client release backs off and re-elects;
    // the flag lets current clients retry at once and demand-start after the endpoint is released.
    return op === "auth" || op === "hello" || op === "helloT3"
      ? new BridgeError("protocol_mismatch", `agent-bridge ${APP_VERSION} broker is stopping (handover or idle exit); retry shortly.`, { brokerProtocol: PROTOCOL_VERSION, brokerVersion: APP_VERSION, handover: true })
      : new BridgeError("bad_request", "The broker is stopping (handover to a newer release or idle exit); this request was not applied. Retry shortly.", { handover: true, applied: false, retryLater: true });
  }
  /**
   * Start a handover unless one to this same target happened within the repeat window. Returns false when this
   * daemon keeps serving. The marker in the home directory outlives this process: when the newer daemon could
   * not start and an older one was started again, that older daemon does not hand over to the same release
   * again for the window, so a client that cannot bring up its daemon cannot make brokers churn.
   */
  private requestHandover(target: EventMap["handover"]): boolean {
    if (!this.handoverHandler || this.draining || this.closing) return false;
    const key = target.version !== undefined ? `version:${target.version}` : `protocol:${target.protocol}`;
    if (this.store.file !== ":memory:") {
      const file = join(dirname(this.store.file), HANDOVER_MARKER_FILE), now = this.now();
      try {
        const marker = JSON.parse(readFileSync(file, "utf8")) as { target?: unknown; at?: unknown };
        if (marker.target === key && typeof marker.at === "number" && now - marker.at >= 0 && now - marker.at < HANDOVER_REPEAT_WINDOW_MS) {
          this.log.warn("not handing over again to the same newer release within the repeat window; that release's daemon did not take over", { target: key, since: marker.at, windowMs: HANDOVER_REPEAT_WINDOW_MS });
          return false;
        }
      } catch { /* No readable marker: no recent handover to this target. */ }
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, JSON.stringify({ target: key, from: APP_VERSION, at: now }), { flag: "wx", mode: 0o600 }); renameSync(temporary, file); }
      catch (err) {
        try { unlinkSync(temporary); } catch { /* Not created. */ }
        // Without the marker the repeat limit cannot hold, so fail closed and keep serving.
        this.log.warn("handover marker could not be recorded; daemon keeps serving", { err: String(err), target: key });
        return false;
      }
    }
    this.log.info("newer agent-bridge client connected; daemon hands over", { ...target, brokerVersion: APP_VERSION, brokerProtocol: PROTOCOL_VERSION });
    this.draining = true;
    this.updateIdle();
    for (const c of this.conns) if (c.authed && c.peer) this.emit(c, "handover", target);
    this.handoverHandler(target);
    return true;
  }
  /**
   * Stop admitting requests and wait, bounded, until every request admitted before now has answered. Accepted
   * mail is already committed to SQLite when its send answers; refused requests were never applied.
   */
  drain(timeoutMs = HANDOVER_DRAIN_MS): Promise<boolean> {
    this.draining = true;
    this.updateIdle();
    if (!this.activeRequests) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.drainWaiters.delete(done); resolve(true); };
      const timer = setTimeout(() => { this.drainWaiters.delete(done); resolve(false); }, timeoutMs);
      this.drainWaiters.add(done);
    });
  }
  /** Trusted bootstrap primitive staging only. Ordinary/default startup never invokes it. */
  lifecycleServingCapability(phase: LifecycleServingPhase, deadline: number): LifecycleServingCapability {
    const binding = servingBindings.get(this);
    if (!binding || binding.revoked || !Object.hasOwn(SERVING_PHASE_MS, phase) || !Number.isFinite(deadline)) unavailableServing();
    const expires = Math.min(deadline, performance.now() + SERVING_PHASE_MS[phase]);
    if (expires <= performance.now()) unavailableServing();
    const capability = Object.freeze({});
    servingCapabilities.set(capability, { binding, generation: binding.generation, phase, expires });
    assertLifecycleServingCapability(capability, phase); return capability;
  }
  private mobileResources?: Set<() => Promise<void>>;
  private mobileRetiring?: boolean;
  /** Deliberate owner-only activation, after caller validation; no change to ordinary startup. */
  initializeMobileOwnerQuestions(): boolean {
    if (this.closing || this.mobileRetiring || !this.server?.listening) return false;
    this.ownerQuestions(); return true;
  }
  /** Explicit host-only opt-in; borrow an already-existing service, never initialize one here. */
  mobileHostContext(): import("../mobile/host.js").MobileHostContext | undefined {
    const service = this.questions;
    if (!service || this.closing || this.mobileRetiring || !this.server?.listening) return undefined;
    let live = true;
    const home = dirname(this.store.file);
    const ready = () => live && !this.mobileRetiring && !this.closing && !!this.server?.listening && this.questions === service;
    const requireReady = () => { if (!ready()) throw new Error("source_unavailable"); };
    return { home, pipe: this.pipePath, log: this.log,
      local: { home, log: this.log, peers: () => { requireReady(); return this.dashboardPeers(); } },
      ownerQuestions: { store: {
        get: id => { requireReady(); return service.store.get(id); },
        list: () => { requireReady(); return service.store.list(); },
        answerMobile: (...args) => { requireReady(); return service.store.answerMobile(...args); },
      }, list: () => { requireReady(); return service.list(); }, complete: q => { requireReady(); return service.complete(q); } },
      ready,
      onDispose: dispose => {
        const wrapped = () => { live = false; return dispose(); };
        (this.mobileResources ??= new Set()).add(wrapped);
        return () => { this.mobileResources?.delete(wrapped); };
      } };
  }
  private async disposeMobileResources(): Promise<void> {
    this.mobileRetiring = true;
    const resources = this.mobileResources; this.mobileResources = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = Promise.allSettled([...resources ?? []].map(dispose => Promise.resolve().then(dispose)));
      const settled = await Promise.race([work, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 5000); })]);
      if (!settled) this.mobileDisposalDiagnostic("mobile_disposal_timeout");
      else if (settled.some(result => result.status === "rejected")) this.mobileDisposalDiagnostic("mobile_disposal_failed");
    } finally { if (timer) clearTimeout(timer); }
  }
  private mobileDisposalDiagnostic(errorCategory: "mobile_disposal_timeout" | "mobile_disposal_failed"): void {
    try { this.log.warn("mobile shutdown requires restart", { requestId: randomUUID(), errorCategory }); } catch { /* Optional diagnostics must never block core teardown. */ }
  }
  private questions: OwnerQuestionService | null = null;
  private ownerQuestions(): OwnerQuestionService {
    return this.questions ??= new OwnerQuestionService(dirname(this.store.file), this.store, this.log, () => this.localPeers().map(p => this.projectPeer(p)), (peer, message) => { const c = this.connByName(peer.name); if (c) this.emit(c, "message", message); }, decision => {
      for (const c of this.conns) if (c.peer && !c.peer.jobAgent && decisionApplies(decision,c.peer)) { const message=this.queueDecision(decision,c.peer); if (message) this.emit(c,"message",message); }
    });
  }
  private readonly groups: ProjectGroups;
  /** Live role selection, recomputed after broker restart; no durable ownership is rewritten. */
  private readonly projectMains = new Map<string, ProjectMainIdentity>();
  private readonly projectRoutes = new Map<string, import("./protocol.js").ProjectRoute>();
  private server: Server | null = null;
  private tcpServer: Server | null = null;
  private tcpReady: Promise<void> | null = null;
  private tcpNonce: string | null = null;
  private tcpPort: number | null = null;
  private readonly conns = new Set<Conn>();
  private readonly nativeChildren: NativeChildren;
  private historyBackground: HistoryBackground | null = null;
  private jobArchiveBackground: JobArchiveBackground | null = null;
  private readonly healthMonitor = new HealthMonitor();
  private historyPendingRequests = 0;
  private purgeTimer: NodeJS.Timeout | null = null;
  private pendingJobMailRoute: Promise<void> | null = null;
  private pendingJobMailRouteAgain = false;
  private pendingJobMailRetry: NodeJS.Timeout | null = null;
  private jobMailRerouteTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private requestTurn: Promise<void> = Promise.resolve();
  private network: NetworkService | null = null;
  private remoteJobs: RemoteJobs | null = null;
  private remoteDashboard: RemoteDashboard | null = null;
  private decisionSync: DecisionSync | null = null;
  private readonly remoteProgress = new Map<string, string>();
  private networkChange: Promise<unknown> = Promise.resolve();
  private networkAuthorityDeferred = false;
  private startupAuthorityRevoked = false;
  private readonly handlers: { [O in Exclude<Op, "modeSend">]: Handler<O> };
  private jobsSnapshot: { active: JsonSnapshot; archive: string; records: Record<string, unknown>[] } | null = null;
  private jobsForDispatch: Record<string, unknown>[] | null = null;
  private readonly recoveredJobs = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly pipePath: string,
    private readonly store: MessageStore,
    private readonly log: Logger,
    private readonly token: string,
    private readonly now: () => number = Date.now,
    /** The supervisor's job registry, for siblings whose peers are not connected between turns. */
    private readonly jobsPath?: string,
    private readonly networking?: { home: string; config: NetworkConfig },
    private readonly dashboardHost?: { ensure(force: boolean, port?: number): Promise<import("../cli/dashboard.js").DashboardInfo | null> },
  ) {
    this.groups = new ProjectGroups(jobsPath ? dirname(jobsPath) : undefined);
    this.nativeChildren = new NativeChildren(this.store);
    this.handlers = {
      coreStatus: () => ({ version: APP_VERSION, pid: process.pid, uptimeSeconds: Math.floor(process.uptime()), ...this.hosting,
        connectedClients: [...this.conns].filter(c => c.authed).length, connectedJobClients: [...this.conns].filter(c => c.authed && c.peer?.jobAgent).length,
        runningJobs: this.storedJobs().filter(job => job.status === "running").length, runningJobsEvidence: "legacy_registry_labels_not_execution" }),
      ensureDashboard: (c, a) => {
        if (c.peer?.jobAgent || c.peer?.subagent) throw new BridgeError("unauthorized", "Only local project sessions and CLI clients can open the dashboard.");
        const parsed = z.object({ force: z.boolean(), port: z.number().int().min(1).max(65535).optional() }).strict().safeParse(a);
        if (!parsed.success) throw new BridgeError("bad_request", "Invalid dashboard startup request.");
        if (!this.dashboardHost) throw new BridgeError("protocol_mismatch", "This broker does not support ensureDashboard hosting; no operation was applied.", { operation: "ensureDashboard" });
        return this.dashboardHost.ensure(parsed.data.force, parsed.data.port);
      },
      askOwner: (c,a) => {
        const peer = this.requirePeer(c);
        if (peer.jobAgent || peer.subagent || peer.agent === "other") throw new BridgeError("unauthorized", "Delegated jobs ask their main; only project sessions file owner questions.");
        const args = askOwnerSchema.parse(a), root = this.groups.root(peer.cwd);
        if (!root || args.project && !this.groups.same(args.project, peer.cwd)) throw new BridgeError("unauthorized", "File questions only for your own project.");
        if (args.job && !this.storedJobs().some(j => j.name === args.job && this.groups.canControl(peer,j,this.localPeers()))) throw new BridgeError("unauthorized", "Linked job must belong to this project session.");
        const main = this.localPeers().find(p => this.groups.same(p.cwd, peer.cwd) && this.projectPeer(p).projectMain);
        let deskProject: string | undefined=args.deskProject;
        try { const linked=readJsonSnapshot(join(root,".pair-desk.json")).value; if (isRecord(linked) && typeof linked.project === "string") deskProject=linked.project; } catch { /* Desk linking is optional. */ }
        return this.ownerQuestions().store.ask(args, root, { session: peer.name, sessionId: peer.sessionId, peerId:peer.id, agent: peer.agent, main: main?.name ?? peer.name, mainSessionId:main ? main.sessionId : peer.sessionId, mainPeerId:main?.id ?? peer.id, ...(args.job ? {job:args.job} : {}) }, this.now(),deskProject);
      },
      ownerQuestions: () => this.ownerQuestions().list(),
      answerOwner: (c,a) => {
        // An authenticated dashboard connection has no agent peer. Models cannot answer for the owner.
        if (c.peer) throw new BridgeError("unauthorized", "Only the local owner dashboard can answer questions.");
        const args = z.object({ id: z.uuid(), answer: questionAnswerSchema }).strict().parse(a);
        return this.ownerQuestions().complete(this.ownerQuestions().store.answer(args.id,args.answer,OWNER_ADDRESS,this.now()));
      },
      dismissOwner: (c,a) => {
        const args = z.object({ id: z.uuid(), status: z.enum(["cancelled","superseded"]), reason: z.string().trim().min(1).max(1000), supersededBy: z.uuid().optional() }).strict().parse(a);
        const q = this.ownerQuestions().store.get(args.id);
        if (c.peer && (c.peer.jobAgent || c.peer.subagent || !q?.askers.some(asker => asker.sessionId && c.peer!.sessionId ? asker.agent === c.peer!.agent && asker.sessionId === c.peer!.sessionId : asker.peerId ? asker.peerId === c.peer!.id : asker.session === c.peer!.name))) throw new BridgeError("unauthorized", "Only an asker or the owner may dismiss this question.");
        return this.ownerQuestions().store.dismiss(args.id,args.status,args.reason,args.supersededBy);
      },
      dashboardJobSend: (c, a) => {
        if (c.peer) {
          this.log.warn("rejected agent dashboard job send", { from: c.peer.name });
          throw new BridgeError("unauthorized", "Only the local owner dashboard can use dashboardJobSend.");
        }
        const sender = this.localPeers().find(p => p.id === a.senderId && p.agent === "other" && !p.jobAgent && !p.subagent);
        if (!sender || a.conversationId !== DASHBOARD_JOB_CONVERSATION) throw new BridgeError("bad_request", "A local dashboard reply listener is required.");
        return this.routeSend(c, sender, a);
      },
      dashboardHeartbeat: (c,a) => {
        if (c.peer) throw new BridgeError("unauthorized", "Only the local dashboard reports presence.");
        const args = z.object({ tab:z.string().regex(/^[\w-]{1,80}$/), visible:z.boolean() }).strict().parse(a);
        return this.ownerQuestions().heartbeat(args.tab,args.visible);
      },
      projectMain: (c, a) => {
        const args = z.object({ to: z.string().min(1) }).strict().parse(a);
        return this.switchProjectMain(c.peer, this.connByName(args.to)?.peer ?? undefined);
      },
      projectJobs: (c) => this.projectJobRecords(c),
      // AB-404: peers needs a few fields; full records with retained history can exceed one frame.
      projectJobSummaries: async (c, a) => {
        const args = z.object({ offset: z.number().int().nonnegative().optional(),
          limit: z.number().int().min(1).max(PROJECT_JOB_SUMMARY_PAGE_MAX).optional() }).strict().parse(a ?? {});
        return pageProjectJobSummaries(await this.projectJobRecords(c), args);
      },
      coordinatorAvailability: (c, a) => {
        const args = z.object({ name: z.string().optional(), unavailable: z.boolean() }).strict().parse(a);
        if (!c.peer && !args.name) throw new BridgeError("bad_request", "A coordinator name is required.");
        const target = args.name ? this.connByName(args.name) : c;
        if (!target?.peer || target.peer.jobAgent || target.peer.subagent) throw new BridgeError("bad_request", "A live local master is required.");
        if (c.peer && target !== c) throw new BridgeError("unauthorized", "A session can only change its own availability.");
        return this.onUpdatePeer(target, { unavailable: args.unavailable });
      },
      handoffSubagents: async (c, a) => {
        const parsed = handoffSchema.safeParse(a);
        if (!parsed.success) throw new BridgeError("bad_request", "Invalid handoff arguments.");
        const source = this.requirePeer(c);
        if (parsed.data.to.includes("/")) throw new BridgeError("bad_request", "Paired-PC handoff is not supported; choose an exact live local session name.");
        const targetConn = this.connByName(parsed.data.to), target = targetConn?.peer;
        if (!target || !targetConn) throw new BridgeError("unknown_target", "The target must be an exact live local session name.");
        if (!this.jobsPath) throw new BridgeError("bad_request", "The job registry is unavailable.");
        const registration = (peer: PeerInfo) => ({ id: peer.id, name: peer.name, sessionId: peer.sessionId, cwd: peer.cwd });
        const sourceRegistration = registration(source), targetRegistration = registration(target);
        // Authentication alone does not prime this broker's foreign-PID cache.
        // No metadata lock is held while the asynchronous OS probe is pending.
        await this.awaitHandoffReaders(c, targetConn);
        let receipt: HandoffReceipt;
        for (const deadline = Date.now() + HANDOFF_LOCK_WAIT_MS; ; await delay(HANDOFF_LOCK_RETRY_MS)) {
          this.assertHandoffRegistration(c, source, sourceRegistration);
          this.assertHandoffRegistration(targetConn, target, targetRegistration);
          // Project roles/grants and registry authority may have changed while
          // waiting. Recompute them immediately before the synchronous commit.
          this.jobsForDispatch = null;
          if (parsed.data.switch_project_main && ((parsed.data.jobs !== "all") || !this.projectPeer(source).projectGroup || this.projectPeer(source).projectGroup !== this.projectPeer(target).projectGroup)) {
            throw new BridgeError("unauthorized", "Switching the project main requires all jobs and a target in the same project group.");
          }
          try {
            receipt = commitHandoff(this.jobsPath, source, target, parsed.data, { canControl: (job) => this.groups.canControl(source, job as unknown as Record<string, unknown>, this.localPeers()) });
            break;
          } catch (error) {
            // The commit takes the registry lease without waiting, so the broker thread never blocks. Another holder
            // keeps it only for one short read-merge-write: this broker's own history worker reconciling ask
            // completions (same PID, so never "stale"), or a session's job manager. Retry off the thread instead
            // of failing the handoff; nothing was written by the refused attempt.
            if ((error as NodeJS.ErrnoException).code !== "EJOBLOCKED" || Date.now() >= deadline) throw error;
          }
        }
        if (parsed.data.switch_project_main) this.switchProjectMain(source, target);
        this.jobsSnapshot = null; this.jobsForDispatch = null;
        this.applyHandoffs();
        for (const conn of this.conns) if (conn.peer) this.emit(conn, "jobs_changed", { withdrawn: conn.peer.name === source.name ? receipt.jobs.map((j) => j.id) : [] });
        return receipt;
      },
      jobAuthority: async (c, a) => {
        const peer = this.requirePeer(c), job = this.currentJobAuthority(await this.jobForControl(peer, a.job));
        if (!job || !this.groups.canControl(peer, job, this.localPeers())) return null;
        return job as unknown as import("../mcp/jobs.js").Job;
      },
      jobChecklist: async (c, a) => {
        const parsed = jobChecklistRequestSchema.safeParse(a);
        if (!parsed.success || parsed.data.note !== undefined && !(parsed.data.close || parsed.data.approve || parsed.data.reject))
          throw new BridgeError("bad_request", "Invalid checklist request. No checklist operation applied.");
        const caller = () => {
          if (!c.authed || !c.registered || !this.conns.has(c) || c.retired || c.socket.destroyed || c.peer?.host)
            throw new BridgeError("unauthorized", "Checklist access requires a current authenticated local registration.");
          return this.requirePeer(c);
        };
        const { job: name, ...change } = parsed.data;
        const recovered = await this.jobForControl(caller(), name);
        // Re-read registration and durable job authority after the final await, and again in transaction admission.
        // A fresh group reader also observes settings/path changes during admission, rather than a cached dispatch grant.
        let current: Record<string, unknown> | undefined;
        const authorize = () => {
          const peer = caller();
          current = this.currentChecklistAuthority(recovered);
          if (!current || current.name !== name || current.remote || !this.jobsPath ||
              !new ChecklistProjectGroups(dirname(this.jobsPath)).canControl(peer, current, this.localPeers()))
            throw new BridgeError("unauthorized", "Current authority does not allow this checklist operation.");
        };
        authorize();
        const items = accessJobChecklist(dirname(this.jobsPath!), name, change, caller().name, authorize);
        return { job: { name, status: String(current!.status), agent: String(current!.agent) }, items };
      },
      jobRecipient: async (c, a) => {
        const peer = this.requirePeer(c), job = this.currentJobAuthority(await this.jobForControl(peer, a.job));
        if (!job || !this.groups.canControl(peer, job, this.localPeers())) throw new BridgeError("unauthorized", "Only a master can inspect the job recipient.");
        return this.jobRecipient(job);
      },
      inlineJobControl: async (c, a) => {
        const peer = this.requirePeer(c), job = this.currentJobAuthority(await this.jobForControl(peer, a.job));
        if (!job || !this.groups.canControl(peer, job, this.localPeers())) throw new BridgeError("unauthorized", "Only the current supervisor can control this job.");
        if (!a.control || !["message", "title", "settings", "effort", "cancel", "pause"].includes(a.control.type)) throw new BridgeError("bad_request", "Invalid inline control.");
        // A pause reason travels to runners, peers and the dashboard: only a bounded string is relayed (AB-398).
        if (a.control.type === "pause") {
          const reason: unknown = a.control.reason;
          if (reason !== undefined && typeof reason !== "string") throw new BridgeError("bad_request", "Invalid pause reason.");
          // One line: newlines in a relayed reason could otherwise add lines to peers or sibling text.
          const line = reason?.replace(/\s+/g, " ").trim().slice(0, MAX_PAUSE_REASON_CHARS).trim();
          a = { ...a, control: { type: "pause", ...(line ? { reason: line } : {}) } };
        }
        if (job.host && (job.status === "running" || job.status === "paused" && job.pausePending)) {
          await this.onSend(c, { to: String(job.name), body: JSON.stringify(a.control), conversationId: `${CONTROL_CONVERSATION_PREFIX}${job.id}` });
          return { sent: true };
        }
        const executor = typeof (job.executionOwner ?? job.owner) === "string" ? this.connByName(String(job.executionOwner ?? job.owner)) : undefined;
        if (job.status !== "running" && !(job.status === "paused" && job.pausePending)) {
          const recipient = this.jobRecipient(job);
          const primary = this.connByName(recipient);
          if (!primary) throw new BridgeError("unknown_target", "No job master is currently connected.");
          this.emit(primary, "shared_job_control", a);
          return { sent: true };
        }
        if (!executor) throw new BridgeError("unknown_target", "The inline job's executor is offline.");
        this.emit(executor, "inline_job_control", a);
        return { sent: true };
      },
      inlineJobReport: async (c, m) => {
        const peer = this.requirePeer(c);
        let fallback = false;
        await this.store.retryWrite(() => {
          const job = this.storedJobs().find((j) => `job:${j.id}` === m.from?.id);
          if (!job || (job.executionOwner !== peer.name && job.owner !== peer.name && job.rootName !== peer.name) || typeof job.owner !== "string" || typeof m.body !== "string") throw new BridgeError("unauthorized", "Invalid inline job delivery.");
          const recipient = this.jobRecipient(job);
          fallback = recipient !== primaryFor(job);
          // AB-380: an oversized report from an older sender is stored as a stub with the same id, never rejected.
          const message = this.wireMessage({ ...m, jobControlAuthorized: undefined, to: recipient, recipient, conversationId: this.jobConversation(job, recipient, m.conversationId) });
          if (this.store.insertJobDelivery(message)) {
            const target = this.connByName(recipient);
            if (target && !target.peer?.unavailable) this.emit(target, "message", message);
          }
        });
        // A report parked with a previous owner (the new primary was not live yet, e.g. mid-handoff) moves on by itself
        // once the primary is live, instead of waiting for an unrelated session to connect.
        if (fallback) this.scheduleJobMailReroute();
        return { saved: true };
      },
      auth: (c, a) => {
        this.checkAuth(a.protocol, a.token, a.canHost);
        c.authed = true;
        return { brokerPid: process.pid };
      },
      hello: async (c, a) => { const result = await this.onHello(c, a); const job = this.storedJobs().find((j) => `job:${j.id}` === c.peer?.id); if (job?.ownershipHistory) this.refreshJobPeer(job); void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) })); this.store.history.rememberPeer(c.peer!); this.afterRegistration(c); return result; },
      helloT3: async (c, a) => {
        if (a.peer?.jobAgent || !t3BindingSchema.safeParse(a.peer?.frontend).success) throw new BridgeError("bad_request", "Hosted hello requires an exact T3 frontend binding.");
        const result = await this.onHello(c, a);
        void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }));
        this.store.history.rememberPeer(c.peer!); this.afterRegistration(c); return result;
      },
      send: (c, a) => this.onSend(c, { ...a, messageId: undefined }),
      trackedSend: (c, a) => this.onTrackedSend(c, a),
      sendState: (c, a) => this.sendState(c, z.uuid().parse(a.id).toLowerCase()),
      decide: (c, a) => this.onDecide(c, a),
      decisions: (c, a) => this.onDecisions(c, a),
      searchHistory: (_, a) => {
        const parsed = historySearchSchema.safeParse(a);
        if (!parsed.success) throw new BridgeError("bad_request", "Invalid history query or filters.");
        return this.store.history.search(parsed.data);
      },
      getConversation: (_, a) => {
        return this.store.history.conversationPage(conversationPageSchema.parse(a));
      },
      reindexHistory: (_, a) => {
        const args = z.object({ reset: z.boolean().optional() }).strict().parse(a);
        if (this.historyBackground) return this.historyBackground.tick(args.reset);
        if (this.store.file !== ":memory:") return { work: 0, discovering: false };
        if (args.reset) this.store.history.reset();
        return this.store.history.tick();
      },
      peers: () => this.livePeers(),
      brokerLoad: () => ({ connectedJobs: [...this.conns].filter((conn) => conn.peer?.jobAgent).length, testedJobs: BROKER_TESTED_JOB_LOAD }),
      dashboardPeers: () => this.dashboardPeers().concat(this.network?.peers() ?? []),
      dashboardRead: (_, a) => this.remoteDashboard?.request(a.host, a.request) ?? dashboardError("remote_offline", "Networking is unavailable."),
      siblings: (c) => this.siblingPeers(c),
      sendSibling: (c, a) => this.onSendSibling(c, a),
      nativeChildren: (c) => this.nativeChildren.list(this.requirePeer(c)),
      nativeChildrenEnd: async (c) => { await this.nativeChildren.endParent(this.requirePeer(c)); return { ended: true }; },
      nativeChild: async (c, a) => {
        const peer = this.requirePeer(c);
        if (a.action === "start") return this.nativeChildren.start(peer, a.agentId, a.maxHops);
        if (a.action === "grant") return this.nativeChildren.grant(peer, a.agentId, a.sendTo ?? []);
        if (a.action !== "end") throw new BridgeError("bad_request", "Unknown native child action.");
        await this.nativeChildren.end(peer, a.agentId);
        this.replayMail(c, peer);
        return null;
      },
      nativeChildPending: (c, a) => this.pendingMail(this.nativeChildren.own(this.requirePeer(c), a.agentId).address, HOOK_MAX_MESSAGES),
      nativeChildAck: async (c, a) => {
        const peer = this.requirePeer(c);
        return { acked: await this.store.retryWrite(() => this.store.markRead(this.nativeChildren.own(peer, a.agentId).address, a.ids, this.now())) };
      },
      nativeChildSend: (c, a) => {
        const child = this.nativeChildren.own(this.requirePeer(c), a.agentId);
        return this.routeNativeSend(c, a, child.address);
      },
      guardedSend: (c, a) => {
        if (!a.ifNoNewerThan) throw new BridgeError("bad_request", "guardedSend requires if_no_newer_than");
        return this.onSend(c, a);
      },
      messageReceipt: (c, a) => this.messageReceipt(c, a.id),
      ack: async (c, a) => ({ acked: await this.store.retryWrite(() => this.store.markRead(this.requirePeer(c).name, a.ids ?? [], this.now())) }),
      pending: (c, a) => {
        const peer = this.requirePeer(c);
        return this.queueReady(c, peer) ? this.pendingMail(peer.name, Math.min(Math.max(1, a.limit ?? PENDING_DEFAULT_LIMIT), PENDING_MAX_LIMIT)) : [];
      },
      updatePeer: async (c, a) => { const peer = await this.onUpdatePeer(c, a); const job = this.storedJobs().find((j) => `job:${j.id}` === peer.id); if (job?.ownershipHistory) this.refreshJobPeer(job); this.store.history.rememberPeer(peer); return peer; },
      claimMail: (c, a) => this.onClaimMail(c, a),
      health: () => this.healthMonitor.snapshot(APP_VERSION, this.historyBackground?.status() ?? null, this.store.backupStatus()),
      ping: () => ({ brokerPid: process.pid, protocol: PROTOCOL_VERSION, brokerVersion: APP_VERSION,
        health: this.healthMonitor.snapshot(APP_VERSION, this.historyBackground?.status() ?? null, this.store.backupStatus()) }),
      networkStatus: () => this.network?.status() ?? { enabled: false, config: this.networking?.config, discovered: [], paired: [] },
      remoteJob: async (c, a) => {
        const peer = this.requirePeer(c);
        if (peer.jobAgent) throw new BridgeError("bad_request", "Only supervisor sessions can request remote jobs.");
        if (!this.remoteJobs) throw new BridgeError("bad_request", "Remote broker update needed or networking unavailable.");
        const saved = this.storedJobs().find((job) => job.id === a.request.job && job.owner === peer.name);
        const supervisor = typeof saved?.supervisor === "string" ? saved.supervisor : peer.sessionId ?? peer.id;
        const snapshot = await this.remoteJobs.request(a.host, peer, a.request, supervisor, typeof saved?.name === "string" ? saved.name : undefined);
        const progress = snapshot.state?.progress;
        const key = `${a.host}/${a.request.job}`;
        if (progress && this.remoteProgress.get(key) !== progress) {
          this.remoteProgress.set(key, progress);
          const pair = this.requireNetwork().status().paired.find((p) => p.id === a.host || p.name === a.host);
          const name = snapshot.state!.peer;
          this.receiveRemote({ id: randomUUID(), from: { id: `${pair?.id ?? a.host}/job:${a.request.job}`, name: `${pair?.name ?? a.host}/${name}`, agent: "other" },
            to: peer.name, recipient: peer.name, body: progress, conversationId: `job-${a.request.job}:note`, replyTo: null, hop: 0, createdAt: this.now(), readAt: null });
        }
        return snapshot;
      },
      networkConfigure: (_, a) => {
        const change = this.networkChange.then(() => this.configureNetwork(a));
        this.networkChange = change.catch(() => {});
        return change;
      },
      networkVerify: (_, a) => this.requireNetwork().verify(z.uuid().parse(a.id)),
      networkPair: () => this.requireNetwork().keys.inviteWithExpiry(),
      networkLink: async (_, a) => {
        try {
          const args = z.object({ code: z.string().min(1).max(MAX_PAIRING_CODE_CHARS), host: z.string().min(1).max(MAX_NETWORK_HOST_CHARS), port: z.number().int().min(1).max(MAX_PORT) }).parse(a);
          return await this.requireNetwork().link(args.code, args.host, args.port);
        } catch { throw new BridgeError("bad_request", "Pairing failed. Check the address, code expiry, unique names and existing pairings."); }
      },
      networkUnlink: (_, a) => {
        const id = z.uuid().parse(a.id);
        const network = this.requireNetwork();
        const removed = network.status().paired.some((p) => p.id === id);
        network.unlink(id);
        return { removed };
      },
      sendFiles: (c, a) => this.onSendFiles(c, a),
      fetchFiles: (c, a) => {
        const sender = this.requirePeer(c);
        const args = z.object({ from: z.string().min(1).max(MAX_FILE_ADDRESS_CHARS), paths: z.array(z.string().min(1).max(MAX_FILE_PATH_CHARS)).min(1).max(MAX_STREAM_ENTRIES) }).parse(a);
        return this.requireNetwork().startFiles(args.from, args.paths, sender.cwd, { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent }, true);
      },
      transfers: () => ({ transfers: this.network?.transfers.list() ?? (this.networking ? readTransferHistory(this.networking.home) : []) }),
      cancelTransfer: (_, a) => {
        const id = z.uuid().parse(a.id);
        if (this.network) return this.network.transfers.cancel(id);
        if (!this.networking) throw new Error("transfer inbox home is unavailable");
        return cancelStoredTransfer(this.networking.home, id);
      },
    };
  }

  /** Bind the endpoint. Rejects with the socket error (EADDRINUSE when another broker owns it). */
  listen(reservation?: EndpointReservation): Promise<void> {
    if (reservation) return this.listenReserved(reservation);
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket));
      const onError = (err: Error) => {
        server.removeListener("listening", listening);
        reject(err);
      };
      /** Optional services: a failure is logged and the broker keeps serving without them (AB-223, AB-239). */
      const optional = (what: string, step: () => void) => {
        try { step(); } catch (err) { this.log.warn(`broker startup: ${what} failed; continuing without it`, { err: String(err) }); }
      };
      const onListening = async () => {
        server.removeListener("error", onError);
        server.on("error", (err) => this.log.error("broker server error", { err }));
        this.server = server;
        try {
          await this.startServices(optional);
          this.tcpReady = this.startTcpFallback();
          await this.tcpReady.catch(err => this.log.warn("broker TCP fallback unavailable", { err: String(err) }));
          resolve();
        } catch (err) {
          // Never leave a bound, half-started broker behind or an unhandled rejection: release the endpoint and let
          // election retry. The caller owns (and closes) the store.
          this.log.error("broker startup failed; releasing the endpoint", { err: String(err) });
          await this.abortStartup().catch((closeErr) => this.log.warn("broker startup cleanup failed", { err: String(closeErr) }));
          reject(err);
        }
      };
      const listening = () => { void onListening(); };
      server.once("error", onError);
      server.once("listening", listening);
      ensurePrivateSocketDirectory(this.pipePath);
      server.listen(this.pipePath);
    });
  }

  private async listenReserved(reservation: EndpointReservation): Promise<void> {
    this.server = reservation.ownedServer(this.pipePath);
    this.networkAuthorityDeferred = true;
    const optional = (what: string, step: () => void) => {
      try { step(); } catch (err) { this.log.warn(`broker startup: ${what} failed; continuing without it`, { err: String(err) }); }
    };
    try {
      await this.startServices(optional);
      const accept = (socket: Socket) => this.accept(socket);
      reservation.activate(accept, this);
      this.network?.activateAuthority();
      this.networkAuthorityDeferred = false;
      this.server.on("error", err => this.log.error("broker server error", { err }));
      this.tcpReady = this.startTcpFallback();
      await this.tcpReady.catch(err => this.log.warn("broker TCP fallback unavailable", { err: String(err) }));
      // Only this real controlled reservation's completed activation registers a
      // source issuer. A constructor, legacy listener, tentative or failed start
      // cannot register/mint. Failure here leaves ordinary serving unchanged.
      if (!servingBindings.has(this) && this.hosting.mode === "daemon" && this.store.file !== ":memory:"
        && hasEndpointActivationWitness(reservation, this, this.server, this.pipePath, accept)) {
        try {
          const server = this.server, home = realpathSync.native(dirname(this.store.file)), identity = servingHomeIdentity(home), hosting = this.hosting;
          if (resolvePipePath(home, {}) === this.pipePath && server.listening && server.address() === this.pipePath) {
            const binding: ServingBinding = { server, home, identity, endpoint: this.pipePath, ownerInstance: randomUUID(), generation: 0, revoked: false,
              current: () => hasEndpointActivationWitness(reservation, this, server, this.pipePath, accept) && this.server === server && this.hosting === hosting && !this.closing && !this.startupAuthorityRevoked && !this.networkAuthorityDeferred && !this.mobileRetiring && this.store.lifecycleWriteManifest().transactionsSettled };
            const revoke = () => { binding.revoked = true; binding.generation++; };
            server.once("close", revoke); server.once("error", revoke); servingBindings.set(this, binding);
          }
        } catch { /* Unproved canonical home/endpoint binding is lifecycle unsupported, never repaired. */ }
      }
    } catch (error) {
      this.startupAuthorityRevoked = true;
      this.network?.deferAuthority();
      await this.abortStartup().catch(() => {});
      await reservation.close();
      throw error;
    }
  }

  /** Undo a failed listen(): background services, timers and the bound server; the store stays open for its owner. */
  private async abortStartup(): Promise<void> {
    this.healthMonitor.close();
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.purgeTimer = null;
    if (this.mobileResources) await this.disposeMobileResources().catch(() => this.mobileDisposalDiagnostic("mobile_disposal_failed"));
    await this.stopTcpFallback();
    this.questions?.close(); this.questions = null;
    if (this.jobsPath) await stopJobRunBackfill(dirname(this.jobsPath));
    await this.historyBackground?.close().catch(() => {});
    this.historyBackground = null;
    await this.jobArchiveBackground?.close().catch(() => {});
    this.jobArchiveBackground = null;
    await this.store.closeBackups().catch(() => {});
    this.remoteDashboard?.close(); this.remoteDashboard = null;
    this.remoteJobs?.close(); this.remoteJobs = null;
    this.decisionSync?.close(); this.decisionSync = null;
    await this.network?.close().catch(() => {});
    this.network = null;
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private async startServices(optional: (what: string, step: () => void) => void): Promise<void> {
        if (this.jobsPath) void startBrokerJobRunIndex(dirname(this.jobsPath)).catch(error => this.log.warn("job run index preparing", { err: String(error) }));
        await this.nativeChildren.recover();
        if (this.jobsPath && this.store.file !== ":memory:") optional("job archive worker", () => { this.jobArchiveBackground = new JobArchiveBackground(this.jobsPath!, this.log); });
        optional("backups", () => this.store.startBackups());
        this.healthMonitor.start();
        optional("handoff replay", () => this.applyHandoffs());
        this.purgeTimer = setInterval(() => this.purge(), PURGE_INTERVAL_MS);
        this.purgeTimer.unref();
        // Config toggles pause the monitor and later resume its durable cursors.
        // The environment kill switch intentionally disables even the worker.
        if (this.store.file !== ":memory:" && !["false", "0"].includes(process.env.AGENT_BRIDGE_HISTORY_INGEST ?? "")) optional("history worker", () => {
          const history = new HistoryBackground(this.store.file, this.log);
          this.historyBackground = history;
          this.store.historyPeerSink = (peer) => this.historyBackground?.rememberPeer(peer);
          this.store.historyMessageSink = () => this.historyBackground?.messageArrived();
          void history.reconcileAsks().catch(error => this.log.debug("startup ask reconciliation deferred", { error: String(error) }));
        });
        this.purge();
        this.log.info("broker listening", { pipe: this.pipePath });
        if (this.store.file !== ":memory:" && existsSync(join(dirname(this.store.file),QUESTIONS_FILE))) optional("owner questions", () => { this.ownerQuestions(); });
        // Another broker may have enabled or changed pairing since this session started.
        if (this.networking) this.networking.config = readNetworkConfig(this.networking.home, this.networking.config);
        if (this.networking?.config.enabled) {
          try {
            this.network = new NetworkService(this.networking.home, this.networking.config, {
              peers: () => this.dashboardPeers(),
              receive: (message) => this.receiveRemote(message),
        receipt: (id, sender, recipient) => this.remoteReceipt(id, sender, recipient),
        recipientReceipts: true,
            }, this.log);
            this.installRemoteJobs(this.network);
            await this.network.start(this.networkAuthorityDeferred);
          } catch (err) {
            this.remoteDashboard?.close();
            this.remoteDashboard = null;
            this.remoteJobs?.close();
            this.remoteJobs = null;
            this.decisionSync?.close();
            this.decisionSync = null;
            await this.network?.close();
            this.network = null;
            this.log.warn("networking could not start; local broker remains available", { message: (err as Error).message });
          }
        }
  }

  /**
   * On Windows, also serve the same token-authenticated protocol on loopback TCP.
   * Sandboxed plugin children (Muse) run under a restricted token that cannot open
   * the named pipe; loopback stays reachable. The port is recorded in the private
   * bridge home, and the protocol still requires the broker token on hello.
   */
  private async startTcpFallback(): Promise<void> {
    if (process.platform !== "win32" || this.store.file === ":memory:") return;
    const home = dirname(this.store.file), file = join(home, BROKER_TCP_FILE);
    // The pipe is already serving: every PowerShell helper here (own creation identity, DPAPI
    // unprotect of a previous record, DPAPI protect of the new one) runs off the event loop.
    // Run synchronously they blocked authentication of waiting clients for seconds on Windows.
    const [identity, previous] = await Promise.all([ownProcessIdentity(),
      existsSync(file) ? Promise.resolve().then(() => readMusePrivateJsonAsync(file)).then(record => ({ record }), (error: unknown) => ({ error })) : undefined]);
    if (!identity || this.closing) return;
    const nonce = this.tcpNonce = randomUUID();
    const server = createServer((socket) => this.accept(socket, "tcp"));
    this.tcpServer = server;
    server.on("error", (err) => this.log.warn("broker TCP fallback error", { err: String(err) }));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    }); });
    const address = server.address();
    if (!address || typeof address === "string" || this.closing) return;
    this.tcpPort = address.port;
    const temporary = join(home, `${BROKER_TCP_FILE}.${nonce}.tmp`);
    let staged = false;
    try {
      // This recreated descriptor is ephemeral. Unknown content may be durable
      // user state: neither publication nor shutdown may overwrite/remove it.
      if (previous && ("error" in previous ? true : !isEphemeralBrokerTcpRecord(previous.record))) {
        throw "error" in previous ? previous.error : new Error("Retaining unknown TCP discovery state");
      }
      await writeMusePrivateJsonAsync(temporary, { port: address.port, pid: process.pid, identity, nonce, protocol: PROTOCOL_VERSION, pipePath: this.pipePath });
      staged = true;
      // The read above and the protected write are asynchronous: content that appeared since an absent read
      // was never checked and may be durable user state, so it is retained rather than replaced.
      if (!previous && existsSync(file)) throw new Error("Retaining TCP discovery state that appeared during publication");
      renameSync(temporary, file);
    }
    catch (err) { this.log.warn("broker TCP fallback port could not be recorded", { err: String(err) }); }
    finally { if (staged) try { unlinkSync(temporary); } catch { /* Exclusively owned unpublished staging only. */ } }
    this.log.info("broker loopback fallback listening", { port: address.port });
  }

  private async stopTcpFallback(): Promise<void> {
    await this.tcpReady?.catch(() => {});
    this.tcpReady = null;
    const server = this.tcpServer;
    this.tcpServer = null;
    if (this.store.file !== ":memory:" && this.tcpNonce) {
      const file = join(dirname(this.store.file), BROKER_TCP_FILE);
      try {
        const record = readMusePrivateJson(file);
        if (isEphemeralBrokerTcpRecord(record) && record.pid === process.pid && record.identity === processIdentity(process.pid) &&
          record.nonce === this.tcpNonce && record.port === this.tcpPort && record.protocol === PROTOCOL_VERSION && record.pipePath === this.pipePath) unlinkSync(file);
      }
      catch { /* Preserve corrupt, foreign or successor metadata. */ }
    }
    this.tcpNonce = null;
    this.tcpPort = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  async close(): Promise<void> {
    this.healthMonitor.close();
    this.closing = true;
    if (this.livenessTimer) { clearInterval(this.livenessTimer); this.livenessTimer = null; }
    if (this.idle?.timer) { clearTimeout(this.idle.timer); this.idle.timer = null; }
    if (this.mobileResources) await this.disposeMobileResources().catch(() => this.mobileDisposalDiagnostic("mobile_disposal_failed"));
    this.questions?.close(); this.questions = null;
    this.store.stopWrites();
    if (this.pendingJobMailRetry) clearTimeout(this.pendingJobMailRetry);
    if (this.jobMailRerouteTimer) { clearTimeout(this.jobMailRerouteTimer); this.jobMailRerouteTimer = null; }
    this.pendingJobMailRetry = null;
    if (this.jobsPath) await stopJobRunBackfill(dirname(this.jobsPath));
    await this.historyBackground?.close();
    await this.jobArchiveBackground?.close();
    this.jobArchiveBackground = null;
    this.historyBackground = null;
    await this.store.closeBackups();
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    await this.networkChange;
    this.remoteDashboard?.close();
    this.remoteDashboard = null;
    this.remoteJobs?.close();
    this.remoteJobs = null;
    this.decisionSync?.close();
    this.decisionSync = null;
    await this.network?.close();
    this.network = null;
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    await this.stopTcpFallback();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await this.pendingJobMailRoute?.catch((err) => this.log.warn("pending mail route stopped", { err: String(err) }));
    this.store.close();
    this.log.info("broker closed");
  }

  /** Serialize listener changes and let the elected broker remain the sole network writer. */
  private async configureNetwork(value: NetworkConfig): Promise<NetworkStatus> {
    if (this.networkAuthorityDeferred) throw new BridgeError("bad_request", "Core is initializing; network configuration was not applied.");
    if (!this.networking) throw new BridgeError("bad_request", "Restart all agent-bridge hosting sessions to load this wizard-capable broker.");
    const config = writeNetworkConfig(this.networking.home, value);
    this.remoteDashboard?.close();
    this.remoteDashboard = null;
    this.remoteJobs?.close();
    this.remoteJobs = null;
    this.decisionSync?.close();
    this.decisionSync = null;
    await this.network?.close();
    this.network = null;
    this.networking.config = config;
    if (config.enabled) {
      const service = new NetworkService(this.networking.home, config, {
        peers: () => this.dashboardPeers(),
        receive: (message) => this.receiveRemote(message),
        receipt: (id, sender, recipient) => this.remoteReceipt(id, sender, recipient),
        recipientReceipts: true,
      }, this.log);
      this.installRemoteJobs(service);
      try { await service.start(this.networkAuthorityDeferred); this.network = service; }
      catch (err) { await service.close(); throw err; }
    }
    return this.network?.status() ?? { enabled: false, config, discovered: [], paired: [] };
  }

  private installRemoteJobs(service: NetworkService): void {
    this.remoteDashboard = new RemoteDashboard(service, { home: this.networking!.home, log: this.log, peers: () => this.dashboardPeers() });
    this.decisionSync = new DecisionSync(service, {
      globalDecisions: () => this.store.decisions.list({ scope: "all", history: true })
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)),
      importDecision: (decision) => this.store.decisions.importSync(decision),
      notifyDecision: (decision) => { this.notifyDecision(decision); },
    }, this.log);
    this.remoteJobs = new RemoteJobs(service, this.networking!.home, this.log, async (record, control) => {
      this.receiveRemote({ id: randomUUID(), from: { id: record.owner, name: record.owner, agent: "other" },
        to: record.name, recipient: record.name, conversationId: `${CONTROL_CONVERSATION_PREFIX}${record.id}`,
        replyTo: null, hop: 0, body: JSON.stringify(control), createdAt: this.now(), readAt: null });
    });
  }

  private purge(): void {
    this.jobArchiveBackground?.repack();
    try {
      const ttl = retentionLimit("AGENT_BRIDGE_MESSAGE_TTL_MS", MESSAGE_TTL_MS);
      if (ttl) this.store.schedulePurgeOlderThan(this.now() - ttl);
    } catch (err) {
      this.log.warn("purge failed", { err });
    }
  }

  private accept(socket: Socket, transport: Conn["transport"] = "pipe"): void {
    if (this.startupAuthorityRevoked) { socket.destroy(); return; }
    const conn: Conn = { socket, peer: null, authed: false, inFlight: 0, mailGeneration: 0, transport };
    this.conns.add(conn);
    this.updateIdle();
    socket.setEncoding("utf8");
    const decoder = new FrameDecoder(MAX_FRAME_BYTES);
    this.log.debug("connection accepted");

    socket.on("data", (chunk: string) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.log.warn("dropping connection after undecodable frame", { err });
        socket.destroy();
        return;
      }
      for (const f of frames) {
        if (f.t === "req") {
          if (++conn.inFlight > MAX_INFLIGHT_PER_CONNECTION) {
            this.log.warn("closing overloaded client connection", { peer: conn.peer?.name });
            socket.destroy();
            break;
          }
          if (conn.inFlight >= PAUSE_INFLIGHT_PER_CONNECTION) socket.pause();
          void this.dispatch(conn, f).catch((err) => {
            this.log.warn("client request transport failed", { err: String(err) });
            socket.destroy();
          }).finally(() => {
            conn.inFlight--;
            if (conn.inFlight < PAUSE_INFLIGHT_PER_CONNECTION && !socket.destroyed) socket.resume();
          });
        }
        else this.log.debug("ignoring non-request frame from client", { t: f.t });
      }
    });
    socket.on("error", (err) => this.log.debug("connection error", { err: err.message }));
    socket.on("close", () => {
      this.conns.delete(conn);
      this.updateIdle();
      if (conn.peer) {
        void this.nativeChildren.endParent(conn.peer, true).catch(err => this.log.warn("native child fallback deferred", { err: String(err) }));
        if (!this.closing && !conn.peer.jobAgent && !conn.peer.subagent) {
          const name = conn.peer.name, at = this.now();
          void this.store.retryWrite(() => {
            if (!this.closing) this.store.markPeerSeen(name, at);
          }).catch((err) => this.log.warn("offline last-seen update deferred", { err: String(err) }));
        }
        void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }));
        this.log.info("peer left", { name: conn.peer.name, agent: conn.peer.agent });
        if (!conn.peer.jobAgent) this.broadcastEvent("peer_left", conn.peer, conn);
      }
    });
  }

  private async dispatch(conn: Conn, frame: RequestFrame): Promise<void> {
    if (this.refuseRevokedStartup(conn, frame)) return;
    // A stopping daemon admits nothing new, so drain() has a fixed set of requests to wait for.
    if (this.draining) { this.write(conn, { t: "res", id: frame.id, ok: false, error: this.handoverRefusal(frame.op).toPayload() }); return; }
    this.activeRequests++;
    try { await this.dispatchAdmitted(conn, frame); }
    finally { if (--this.activeRequests === 0) for (const done of [...this.drainWaiters]) done(); }
  }

  private async dispatchAdmitted(conn: Conn, frame: RequestFrame): Promise<void> {
    this.healthMonitor.start();
    // In-memory probes must not pause background work just to observe its status.
    const countsPressure = !["reindexHistory", "health", "ping"].includes(frame.op);
    if (countsPressure) this.historyPendingRequests++;
    this.historyBackground?.pressure(this.historyPendingRequests > 0);
    this.store.backupPressure(this.historyPendingRequests > 0);
    // Keep the released constructor/control-flow pin unchanged.
    const handler = (frame.op === "modeSend" ? this.onModeSend.bind(this) : this.handlers[frame.op]) as Handler<Op> | undefined;
    try {
      if (!handler) throw new BridgeError("bad_request", `unknown op: ${String(frame.op)}`);
      // Start one handler per event-loop turn so bursts cannot starve fresh hook connections.
      // Only its start is scheduled: a pending SQLite retry never holds up other requests.
      const turn = this.requestTurn.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
      this.requestTurn = turn;
      await turn;
      if (this.refuseRevokedStartup(conn, frame)) return;
      if (this.closing) return;
      if (!conn.authed && !UNAUTHENTICATED_OPS.has(frame.op)) throw new BridgeError("unauthorized", "authenticate first");
      this.log.debug("request", { op: frame.op, peer: conn.peer?.name });
      const result = await handler(conn, (frame.args ?? {}) as never);
      this.write(conn, { t: "res", id: frame.id, ok: true, result });
    } catch (err) {
      if (isSqliteBusy(err)) {
        this.historyBackground?.pressure(true, true);
        this.store.backupPressure(true, true);
      }
      const be = err instanceof BridgeError ? err : new BridgeError("internal", String((err as Error)?.message ?? err));
      if (be.code === "internal" || isSqliteBusy(err)) this.healthMonitor.error(frame.op, isSqliteBusy(err) ? "store_busy" : be.code);
      if (be.code === "internal") this.log.error("request failed", { op: frame.op, err });
      else this.log.debug("request rejected", { op: frame.op, code: be.code, message: be.message });
      this.write(conn, { t: "res", id: frame.id, ok: false, error: be.toPayload() });
    } finally {
      if (countsPressure) this.historyPendingRequests--;
      this.historyBackground?.pressure(this.historyPendingRequests > 0);
      this.store.backupPressure(this.historyPendingRequests > 0);
    }
  }

  private refuseRevokedStartup(conn: Conn, frame: RequestFrame): boolean {
    if (!this.startupAuthorityRevoked) return false;
    this.write(conn, { t: "res", id: frame.id, ok: false, error: { code: "internal", message: "Core initialization is unavailable; no request was admitted." } });
    return true;
  }

  private write(conn: Conn, frame: Parameters<typeof encodeFrame>[0]): boolean {
    if (conn.socket.destroyed) return false;
    try {
      let data = encodeFrame(frame);
      let bytes = Buffer.byteLength(data);
      if (bytes > MAX_FRAME_BYTES) {
        // AB-380: the peer's decoder would reject it and drop the connection, so a reconnect would loop on it.
        // Skip the frame instead; a response still settles its request, as too_large.
        const ev = frame.t === "evt" ? frame.ev : undefined, id = frame.t === "evt" && isRecord(frame.data) ? (frame.data as Record<string, unknown>).id : undefined;
        this.log.error("skipping oversized frame; connection kept", { peer: conn.peer?.name, t: frame.t, ev, id, bytes });
        if (frame.t !== "res") return true;
        data = encodeFrame({ t: "res", id: frame.id, ok: false, error: new BridgeError("too_large",
          `response is ${bytes} bytes, over the ${MAX_FRAME_BYTES}-byte frame limit`, { bytes, limit: MAX_FRAME_BYTES, retryable: false }).toPayload() });
        bytes = Buffer.byteLength(data);
      }
      if (conn.socket.writableLength + bytes > MAX_CONNECTION_BUFFER_BYTES) {
        this.log.warn("closing slow client connection; unread mail remains stored", { peer: conn.peer?.name });
        conn.socket.destroy();
        return false;
      }
      return conn.socket.write(data);
    } catch (err) {
      this.log.warn("client write failed; unread mail remains stored", { err: String(err) });
      conn.socket.destroy();
      return false;
    }
  }

  /** Deferred replay is outside dispatch: storage faults must not become uncaught exceptions.
   * Honour stream backpressure so a large retained inbox is not repeatedly disconnected on replay.
   */
  private replayMail(conn: Conn, peer: PeerInfo, before?: () => void): void {
    const registration = { id: peer.id, name: peer.name, sessionId: peer.sessionId, generation: conn.mailGeneration };
    const current = () => this.queueReady(conn, peer) && conn.mailGeneration === registration.generation && !conn.socket.destroyed && conn.peer === peer && peer.id === registration.id &&
      peer.name === registration.name && peer.sessionId === registration.sessionId && this.connByName(registration.name) === conn;
    setImmediate(() => {
      if (!current()) return;
      try {
        before?.();
        const mail = this.unreadMail(peer.name, PENDING_MAX_LIMIT);
        let at = 0;
        const pump = () => {
          if (!current()) return;
          while (at < mail.length) {
            const m = mail[at++]!;
            // Availability may change after hello scheduled this replay, or while a
            // backpressured stream is paused. Keep job reports durable for the router.
            if (peer.unavailable && m.from.id.startsWith("job:") && !m.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX)) continue;
            if (!this.write(conn, { t: "evt", ev: "message", data: m })) {
              if (!conn.socket.destroyed) conn.socket.once("drain", pump);
              return;
            }
          }
        };
        pump();
      } catch (err) { this.log.warn("mail replay deferred after storage failure", { peer: peer.name, err: String(err) }); }
    });
  }

  private emit<E extends EventName>(conn: Conn, ev: E, data: EventMap[E]): void {
    const publicData = ev === "peer_joined" || ev === "peer_left" ? this.publicPeer(data as PeerInfo) as EventMap[E] : data;
    const frame: EventFrame<E> = { t: "evt", ev, data: publicData };
    this.write(conn, frame as EventFrame);
  }

  private broadcastEvent<E extends EventName>(ev: E, data: EventMap[E], except: Conn): void {
    for (const c of this.conns) if (c !== except && c.peer) this.emit(c, ev, data);
  }

  private requirePeer(conn: Conn): PeerInfo {
    if (!conn.peer) throw new BridgeError("not_registered", "send hello first");
    return conn.peer;
  }

  /** Local sessions and paired remote peers; local job runners stay hidden (see job-host.ts). */
  private livePeers(): PeerInfo[] {
    return this.localPeers().filter((p) => !p.jobAgent).map((p) => this.projectPeer(p)).concat(this.network?.peers() ?? []).filter((p) => !isPluginCacheCwd(p.cwd)).map(peer => this.publicPeer(peer));
  }

  /** The node's own registration is authoritative. Legacy observers must not
   * concurrently republish foreign explicit records without creation identity.
   */
  private publicPeer(peer: PeerInfo): PeerInfo {
    const { storeCapabilities: _privateCapabilities, ...publicPeer } = peer;
    return publicPeer;
  }

  /**
   * AB-399: each node's session host as of its first hello on this broker. A POSIX MCP server whose CLI ended is
   * re-parented (agentPid 1 or a subreaper) and would otherwise revive on its next hello; the frozen host keeps
   * pointing at the CLI it was started by.
   */
  private readonly agentHosts = new Map<string, { agentPid: number | null; agentStartedAt: string | null; firstHelloAt: number }>();
  /**
   * Node ids the broker retired (in memory only). Their CLI is provably gone, so a re-hello from the same server is
   * refused: a release that ignores the `retired` event reconnects at once, and the refusal sends it into its
   * normal reconnect backoff instead of a registration loop.
   */
  private readonly retiredPeers = new Map<string, EventMap["retired"]["reason"]>();
  /** Project mains whose connection the broker retired; the same session reconnecting soon gets its role back. */
  private readonly retiredProjectMains = new Map<string, { main: ProjectMainIdentity; at: number }>();
  private identityReader: (pids: number[]) => Promise<Map<number, string>> = readProcessIdentities;
  private livenessTimer: NodeJS.Timeout | null = null;
  private livenessSweep: Promise<void> | undefined;

  /** Test seam: the batch creation-identity reader used by the background liveness sweep. */
  setIdentityReader(reader: (pids: number[]) => Promise<Map<number, string>>): void { this.identityReader = reader; }

  private freezeAgentHost(peer: PeerInfo): void {
    // Only retirable sessions need a frozen host; others would only cycle the bounded map.
    if (peer.jobAgent || peer.subagent || !RETIRABLE_AGENTS.has(peer.agent)) return;
    const known = this.agentHosts.get(peer.id);
    if (known) { peer.agentPid = known.agentPid; peer.agentStartedAt = known.agentStartedAt; return; }
    if (this.agentHosts.size >= MAX_AGENT_HOSTS) this.agentHosts.delete(this.agentHosts.keys().next().value!);
    this.agentHosts.set(peer.id, { agentPid: peer.agentPid ?? null, agentStartedAt: peer.agentStartedAt ?? null, firstHelloAt: this.now() });
  }

  /** Whether a session may be retired when its CLI process is gone (see RETIRABLE_AGENTS); TCP peers never are. */
  private retirablePeer(peer: PeerInfo | null, transport: Conn["transport"]): peer is PeerInfo {
    return Boolean(peer && transport === "pipe" && !peer.jobAgent && !peer.subagent && RETIRABLE_AGENTS.has(peer.agent)
      && Number.isSafeInteger(peer.agentPid) && peer.agentPid! > 1 && peer.agentStartedAt);
  }

  private retirable(conn: Conn): boolean {
    return !conn.retired && this.retirablePeer(conn.peer, conn.transport);
  }

  /**
   * Signal 0 only (no process is started). True only for ESRCH of the session's CLI while its server process is
   * visible here; EPERM and every other answer count as alive. A server PID that does not exist here belongs to
   * another PID namespace or a synthetic registration.
   */
  private hostGone(peer: PeerInfo): boolean {
    const missing = (pid: number) => {
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    };
    return !missing(peer.pid) && missing(peer.agentPid!);
  }

  /** hostGone with the probe reused within one burst of view/send work (peers decorates every member). */
  private hostExited(conn: Conn): boolean {
    const at = this.now();
    if (conn.hostProbe && at - conn.hostProbe.at < HOST_PROBE_MS && at >= conn.hostProbe.at) return conn.hostProbe.exited;
    const exited = this.hostGone(conn.peer!);
    conn.hostProbe = { at, exited };
    return exited;
  }

  /**
   * Hello gate for retirable sessions, before any registration work (session recovery, replacing an older server
   * of the session, mail claims). A server the broker already retired, or one whose frozen CLI is gone, is
   * refused with "unauthorized": every node release treats that as "back off and retry" (nextBackoff), so even a
   * release that knows nothing of retirement cannot reconnect in a tight loop. Current nodes read `retired` from
   * the details and stay off the bridge.
   */
  private refuseRetiredHello(conn: Conn, peer: PeerInfo): void {
    if (!this.retirablePeer(peer, conn.transport)) return;
    const reason = this.retiredPeers.get(peer.id) ?? (this.hostGone(peer) ? "host_exited" : undefined);
    if (!reason) return;
    this.rememberRetired(peer.id, reason);
    this.log.debug("refusing a session whose CLI process ended", { name: peer.name, agentPid: peer.agentPid, reason });
    throw new BridgeError("unauthorized", "This session's CLI process has ended; the broker retired its bridge server.", { retired: true, reason, agentPid: peer.agentPid ?? null });
  }

  private rememberRetired(id: string, reason: EventMap["retired"]["reason"]): void {
    this.retiredPeers.delete(id);
    if (this.retiredPeers.size >= MAX_AGENT_HOSTS) this.retiredPeers.delete(this.retiredPeers.keys().next().value!);
    this.retiredPeers.set(id, reason);
  }

  /**
   * A connected MCP server may outlive its CLI parent. The retained DB name is history, while the socket stops
   * representing a live session once its CLI process is gone. Inline this reads only the retirement verdict and
   * a cached signal-0 probe; creation identities are checked by the background sweep (sweepPeerLiveness).
   */
  private liveConns(): Conn[] {
    const live: Conn[] = [];
    for (const conn of this.conns) {
      if (!conn.peer || conn.retired || conn.socket.destroyed) continue;
      if (conn.registered && this.retirable(conn)) {
        this.startLivenessSweep();
        if (this.hostExited(conn)) { this.retire(conn, "host_exited"); continue; }
      }
      live.push(conn);
    }
    return live;
  }

  /** Check a new registration once its hello reply is written, so a dead session is told at once (AB-399). */
  private afterRegistration(conn: Conn): void {
    setImmediate(() => {
      conn.registered = true;
      if (!this.closing && this.conns.has(conn) && this.retirable(conn) && this.hostExited(conn)) this.retire(conn, "host_exited");
    });
  }

  /** Tell the server why it leaves (so it stays off instead of reconnecting) and close its connection. */
  private retire(conn: Conn, reason: EventMap["retired"]["reason"]): void {
    const peer = conn.peer;
    if (!peer || conn.retired) return;
    conn.retired = true;
    this.rememberRetired(peer.id, reason);
    for (const [key, main] of this.projectMains) if (ownsProjectMain(main, peer)) this.retiredProjectMains.set(key, { main, at: this.now() });
    this.log.info("retiring session whose CLI process ended", { name: peer.name, agentPid: peer.agentPid, reason });
    this.emit(conn, "retired", { reason, agentPid: peer.agentPid ?? null });
    conn.socket.end();
  }

  private startLivenessSweep(): void {
    if (this.livenessTimer || this.closing) return;
    this.livenessTimer = setInterval(() => void this.sweepPeerLiveness().catch(err => this.log.warn("peer liveness sweep failed", { err: String(err) })), LIVENESS_SWEEP_MS);
    this.livenessTimer.unref();
  }

  /**
   * Background creation-identity check: one asynchronous batch query for all retirable sessions, one at a time.
   * A session retires only on proven PID reuse: the process now holding its CLI PID started after the session's
   * CLI did (its recorded identity's start time, else the first hello on this broker). An unreadable, failed or
   * merely different identity (format, time zone) counts as alive.
   */
  sweepPeerLiveness(): Promise<void> {
    if (this.livenessSweep) return this.livenessSweep;
    // A host already gone (ESRCH) is retired inline; only hosts that still answer signal 0 need an identity read.
    const targets = [...this.conns].filter(conn => this.retirable(conn) && !this.hostExited(conn));
    if (!targets.length || this.closing) {
      // No reader process while nothing needs one; liveConns starts the timer again for a new retirable session.
      if (!targets.length && this.livenessTimer) { clearInterval(this.livenessTimer); this.livenessTimer = null; }
      return Promise.resolve();
    }
    const sweep = (async () => {
      let identities: Map<number, string>;
      try { identities = await this.identityReader(targets.map(conn => conn.peer!.agentPid!)); }
      catch (error) { this.log.debug("peer identity query failed; sessions stay live", { err: String(error) }); return; }
      for (const conn of targets) {
        const peer = conn.peer;
        if (this.closing || !peer || !this.conns.has(conn) || !this.retirable(conn)) continue;
        const current = identities.get(peer.agentPid!);
        if (!current || current === peer.agentStartedAt) continue;
        let since: number;
        if (process.platform === "win32" || process.platform === "linux") {
          // After a broker restart the first hello here is the reconnect, so the recorded CLI start is the better bound.
          since = identityStartMs(peer.agentStartedAt!) ?? this.agentHosts.get(peer.id)?.firstHelloAt ?? peer.startedAt;
        } else {
          // ps lstart is local time in the printing process's zone, and the server's TZ may differ from the
          // broker's: compare only with the broker's own first reading of this host.
          const baseline = conn.hostBaseline ??= current;
          if (current === baseline) continue;
          since = identityStartMs(baseline) ?? this.agentHosts.get(peer.id)?.firstHelloAt ?? peer.startedAt;
        }
        if (provenStartedAfter(current, since + PID_REUSE_SLACK_MS)) this.retire(conn, "pid_reused");
      }
    })().finally(() => { if (this.livenessSweep === sweep) this.livenessSweep = undefined; });
    return this.livenessSweep = sweep;
  }

  private localPeers(): PeerInfo[] { return this.liveConns().map((c) => c.peer!); }

  private projectPeer(peer: PeerInfo): PeerInfo {
    const decorated = this.groups.decorate(peer), key = decorated.projectGroup;
    if (!key || peer.jobAgent || peer.subagent) return decorated;
    const members = this.localPeers().filter((p) => !p.jobAgent && !p.subagent && this.groups.decorate(p).projectGroup === key)
      .sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name));
    // Remembered retired mains are in-memory state only; past the grace window the current main keeps its role.
    const at = this.now();
    for (const [group, entry] of this.retiredProjectMains) if (at - entry.at > RETIRED_MAIN_GRACE_MS || at < entry.at) this.retiredProjectMains.delete(group);
    const retired = this.retiredProjectMains.get(key), back = retired && members.find(p => ownsProjectMain(retired.main, p));
    // A retired main whose session reconnects soon (a resumed CLI) takes its role back, as after a broker restart.
    if (back) { this.retiredProjectMains.delete(key); this.recordProjectMain(key, `project:${basename(decorated.projectRoot!)}`, back); }
    let main = members.find(p => this.projectMains.has(key) && ownsProjectMain(this.projectMains.get(key)!, p));
    if (!main) { main = members[0]; if (main) this.recordProjectMain(key, `project:${basename(decorated.projectRoot!)}`, main); }
    return { ...decorated, projectMain: main?.id === peer.id, projectAddress: `project:${basename(decorated.projectRoot!)}`, projectRoute: this.projectRoutes.get(key) };
  }

  private switchProjectMain(source: PeerInfo | null | undefined, target: PeerInfo | undefined): PeerInfo {
    if (!target || target.jobAgent || target.subagent || target.host) throw new BridgeError("bad_request", "Choose a live local project master.");
    const peer = this.projectPeer(target);
    if (!peer.projectGroup || source && (source.jobAgent || this.projectPeer(source).projectGroup !== peer.projectGroup)) throw new BridgeError("unauthorized", "Only a master of this project may switch its main session.");
    this.retiredProjectMains.delete(peer.projectGroup);
    this.recordProjectMain(peer.projectGroup, peer.projectAddress!, target);
    return this.projectPeer(target);
  }

  private recordProjectMain(key: string, address: string, peer: PeerInfo): void {
    const old = this.projectMains.get(key);
    if (old && ownsProjectMain(old, peer)) { this.transferProjectMain(old, peer); return; }
    const previous = old?.name, main = peer.name;
    const route = { address, main, since: this.now(), previous };
    this.projectMains.set(key, { id: peer.id, agent: peer.agent, sessionId: peer.sessionId, name: peer.name, frontend: peer.frontend }); this.projectRoutes.set(key, route);
    if (previous) void this.notifyProjectMainChange(route).catch((err) => this.log.warn("project main notice deferred", { err: String(err) }));
  }

  /** Only an owning live connection (or an exact reconnect) may carry its role across resume/rename. */
  private transferProjectMain(old: ProjectMainIdentity, peer: PeerInfo): void {
    for (const [key, main] of this.projectMains) {
      if (!ownsProjectMain(main, old)) continue;
      this.projectMains.set(key, { id: peer.id, agent: peer.agent, sessionId: peer.sessionId, name: peer.name, frontend: peer.frontend });
      const route = this.projectRoutes.get(key);
      if (route) this.projectRoutes.set(key, { ...route, main: peer.name });
    }
  }

  private async notifyProjectMainChange(route: import("./protocol.js").ProjectRoute): Promise<void> {
    const recipients = new Set([route.previous!, ...this.store.recentProjectSenders(route.address, route.previous!, route.since - 24 * 60 * 60 * 1_000)]);
    for (const recipient of recipients) {
      if (this.closing) return;
      if (!PEER_NAME_PATTERN.test(recipient) || this.connByName(recipient)?.peer?.jobAgent) continue;
      const message: BridgeMessage = { id: randomUUID(), from: { id: "bridge-project-routing", name: "agent-bridge", agent: "other" },
        to: recipient, recipient, conversationId: `project-main-${randomUUID()}`, replyTo: null, hop: 0,
        body: `${route.address} main changed from ${route.previous} to ${route.main} at ${new Date(route.since).toISOString().slice(11, 16)} UTC. Future project-address mail routes to ${route.main}; exact session names keep direct routing.`,
        createdAt: route.since, readAt: null };
      await this.store.retryWrite(() => this.store.insert(message));
      const conn = this.recipientConn(recipient); if (conn) this.emit(conn, "message", message);
    }
  }

  private sameJobFamily(a: PeerInfo, b: PeerInfo, jobs = this.storedJobs()): boolean {
    if (this.jobSupervisor(a, jobs) !== this.jobSupervisor(b, jobs)) return false;
    const left = jobs.find((j) => `job:${j.id}` === a.id), right = jobs.find((j) => `job:${j.id}` === b.id);
    const l = left && this.groups.jobRoot(left, this.localPeers()), r = right && this.groups.jobRoot(right, this.localPeers());
    return !(l && r) || this.groups.root(l) === this.groups.root(r);
  }

  private sharedJobs(a: PeerInfo, b: PeerInfo, jobs = this.storedJobs()): boolean {
    const left = jobs.find((j) => `job:${j.id}` === a.id), right = jobs.find((j) => `job:${j.id}` === b.id);
    if (!left || !right || !this.groups.shareable(left) || !this.groups.shareable(right)) return false;
    const peers = this.localPeers(), l = this.groups.jobRoot(left, peers), r = this.groups.jobRoot(right, peers);
    return Boolean(l && r && this.groups.same(l, r));
  }

  /** Project local runner lineage from durable jobs; do not alter broker routing identities. */
  private dashboardPeers(): PeerInfo[] {
    const peers = this.liveConns().flatMap((c) => c.peer ? [c.peer] : []);
    const jobs = this.peerJobs(peers);
    return peers.flatMap((peer) => {
      const job = jobs.find((j) => j.name === peer.name || `job:${j.id}` === peer.id);
      const field = (key: string): string | undefined => typeof job?.[key] === "string" ? job[key] as string : undefined;
      return [{ ...this.projectPeer(peer), agent: peer.jobAgent ?? peer.agent, parentJob: field("parentJob") ?? peer.parentJob, rootSession: field("rootSession") ?? peer.rootSession ?? peer.jobOwner,
        rootName: field("rootName") ?? peer.rootName ?? peer.jobParent, title: peer.jobTitle, subagent: Boolean(peer.jobAgent) }];
    });
  }

  private connByName(name: string): Conn | undefined {
    for (const c of this.liveConns()) if (c.peer?.name === name) return c;
    return undefined;
  }

  /** Replay every effect after the registry commit, including a crash between stores. */
  private applyHandoffs(): void {
    if (!this.jobsPath) return;
    const records = this.storedJobs();
    for (const receipt of handoffJournal(this.jobsPath)) {
      const current = receipt.jobs.map((j) => records.find((r) => r.id === j.id)).filter(isRecord);
      for (const job of current) {
        const old = receipt.jobs.find((j) => j.id === job.id)!;
        const budget = new RootConcurrency(dirname(this.jobsPath), String(job.rootSession));
        try { budget.moveJobs([old.name]); } finally { budget.close(); }
        this.refreshJobPeer(job);
      }
      const body = `Inherited subagents from ${receipt.from}:\n` + receipt.jobs.map((j) => `- ${j.name}: ${j.title} (${j.status})`).join("\n") +
        (receipt.note ? `\n\nHandoff note: ${receipt.note}` : "") + "\n\nYou are their supervisor. Use message_subagent or cancel_subagent to control them.";
      for (const [recipient, text, suffix] of [[receipt.to, body, "inherited"], [receipt.from, `Handed off ${receipt.jobs.length} subagent(s) to ${receipt.to}.`, "confirmed"]]) {
        const m: BridgeMessage = { id: `${receipt.id}-${suffix}`, from: { id: "handoff", name: "agent-bridge", agent: "other" },
          to: recipient!, recipient: recipient!, body: text!, conversationId: `handoff-${receipt.id}`, hop: 0, replyTo: null, createdAt: receipt.at, readAt: null };
        if (this.store.insertOnce(m)) { const conn = this.connByName(recipient!); if (conn) this.emit(conn, "message", m); }
      }
    }
    void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }));
  }

  /** Rerun job mail routing a few times (250 ms up to 10 s) after a report went to a fallback recipient. */
  private scheduleJobMailReroute(delays: readonly number[] = [250, 1_000, 3_000, 10_000]): void {
    if (this.closing || this.jobMailRerouteTimer || !delays.length) return;
    this.jobMailRerouteTimer = setTimeout(() => {
      this.jobMailRerouteTimer = null;
      if (this.closing) return;
      void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }))
        .finally(() => this.scheduleJobMailReroute(delays.slice(1)));
    }, delays[0]);
    this.jobMailRerouteTimer.unref();
  }

  routePendingJobMail(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.pendingJobMailRouteAgain = true;
    this.pendingJobMailRoute ??= this.reroutePendingJobMail().catch((err) => {
      // A busy interval can outlast one RPC deadline. Durable envelopes still need a drain
      // even if no new connection arrives to trigger another routing pass.
      if (isSqliteBusy(err) && !this.closing && !this.pendingJobMailRetry) {
        this.pendingJobMailRetry = setTimeout(() => {
          this.pendingJobMailRetry = null;
          void this.routePendingJobMail().catch((error) => this.log.warn("pending job mail retry deferred", { err: String(error) }));
        }, 1_000);
        this.pendingJobMailRetry.unref();
      }
      throw err;
    }).finally(() => { this.pendingJobMailRoute = null; });
    return this.pendingJobMailRoute;
  }

  private async reroutePendingJobMail(): Promise<void> {
    do {
      this.pendingJobMailRouteAgain = false;
      let processed = 0;
      let pending = this.store.pendingJobSenders();
      for (const snapshot of this.storedJobs()) {
        if (++processed % 16 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          pending = this.store.pendingJobSenders();
        }
        if (snapshot.remote || !primaryFor(snapshot)) continue;
        // Empty jobs need no write attempt or refreshed archive traversal. Every retained
        // envelope still enters the retry callback, which rereads ownership before writing.
        if ((!Array.isArray(snapshot.deliveryHistory) || !snapshot.deliveryHistory.length) && !pending.has(`job:${snapshot.id}`)) continue;
        await this.store.retryWrite(() => {
          if (this.closing) return;
          const job = this.storedJobs().find((record) => record.id === snapshot.id);
          if (!job || job.remote || !primaryFor(job)) return;
          if ((!Array.isArray(job.deliveryHistory) || !job.deliveryHistory.length) && !this.store.pendingJobRecipients(String(job.id)).length) return;
          const recipient = this.jobRecipient(job), target = this.connByName(recipient);
          if (Array.isArray(job.deliveryHistory)) for (const envelope of job.deliveryHistory) {
            if (!isRecord(envelope) || !isRecord(envelope.from) || envelope.from.id !== `job:${job.id}` || typeof envelope.id !== "string" || typeof envelope.body !== "string") continue;
            // AB-380: an oversized stored envelope is persisted and sent as a stub; jobs.json keeps the original.
            const message = this.wireMessage({ ...envelope, to: recipient, recipient, conversationId: this.jobConversation(job, recipient, String(envelope.conversationId)) } as unknown as BridgeMessage);
            const inserted = this.store.insertJobDelivery(message);
            const names = new Set([recipient, envelope.to, envelope.recipient, ...mastersFor(job)]);
            const consumed = this.jobsPath && [...names].some((name) => typeof name === "string" &&
              new ReadJournal(dirname(this.jobsPath!)).read(`name:${name}`).includes(message.id));
            if (consumed) this.store.markRead(recipient, [message.id], this.now());
            else if (inserted && target && !target.peer?.unavailable) this.emit(target, "message", message);
          }
          if (!target || target.peer?.unavailable) return;
          for (const from of this.store.pendingJobRecipients(String(job.id))) {
            if (this.jobsPath) this.store.markRead(from, new ReadJournal(dirname(this.jobsPath)).read(`name:${from}`), this.now());
            const moved = this.store.handoffMail(from, recipient, String(job.id), this.now(), recipient !== job.parentJob && recipient !== primaryFor(job));
            const previous = this.connByName(from);
            if (previous && moved.length) this.emit(previous, "mail_retracted", { ids: moved.map((m) => m.id) });
            for (const m of moved) this.emit(target, "message", this.wireMessage(m, "the bridge database"));
          }
        });
      }
    } while (this.pendingJobMailRouteAgain && !this.closing);
  }

  private jobRecipient(job: Record<string, unknown>, question = false): string {
    if (typeof job.parentJob === "string" && this.connByName(job.parentJob)?.peer?.jobAgent) return job.parentJob;
    const local = this.localPeers(), members = this.groups.members(job, local);
    const chosen = chooseJobRecipient(job, local, members);
    // AB-249: a job's question to a parent that is not connected goes to the project's current main session.
    const parent = question ? this.connByName(primaryFor(job))?.peer : undefined;
    if (question && (!parent || parent.unavailable)) {
      const main = members.map((p) => this.projectPeer(p)).find((p) => p.projectMain && !p.unavailable);
      if (main) return main.name;
    }
    return chosen;
  }

  private jobConversation(job: Record<string, unknown>, recipient: string, conversationId: string): string {
    if (recipient === job.parentJob || recipient === primaryFor(job) || isQuietMessage({ conversationId })) return conversationId;
    return conversationId.replace(/:note$/, "") + (conversationId.endsWith(":fallback") ? "" : ":fallback");
  }

  private refreshJobPeer(job: Record<string, unknown>): void {
    const peer = this.connByName(String(job.name))?.peer;
    if (!peer?.jobAgent) return;
    peer.jobParent = String(job.owner); peer.jobOwner = String(job.supervisor);
    peer.rootSession = String(job.rootSession); peer.rootName = String(job.rootName);
    peer.parentJob = typeof job.parentJob === "string" ? job.parentJob : undefined;
    if (isRecord(job.args) && Array.isArray(job.args.send_to)) peer.jobSendTo = job.args.send_to as string[];
  }

  private siblingConns(conn: Conn, target?: string): Conn[] {
    const peer = this.requirePeer(conn);
    if (!peer.jobAgent || !peer.jobOwner) throw new BridgeError("bad_request", "not a linked job");
    const jobs = this.storedJobs();
    const supervisor = this.jobSupervisor(peer, jobs);
    return [...this.conns].filter((c) => c !== conn && c.peer?.jobAgent && (!target || c.peer.name === target) && (this.sameJobFamily(peer, c.peer, jobs) || this.sharedJobs(peer, c.peer, jobs) || peer.jobSendTo?.includes(c.peer.name)));
  }

  private async jobForControl(peer: PeerInfo, ref: string): Promise<Record<string, unknown> | undefined> {
    let known = this.storedJob(ref);
    let active = false;
    if (known && this.jobsPath) {
      try {
        if (indexedJobProjectionCurrent(this.jobsPath)) {
          const selected = readIndexedJobs(this.jobsPath, { ids: new Set([String(known.id)]), active: true }).jobs[0];
          active = Boolean(selected);
          if (selected) known = selected;
        } else {
        const data = readJsonSnapshot(this.jobsPath).value;
        const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : [];
        active = rows.some(record => isRecord(record) && record.id === known!.id);
        }
      } catch { /* Unknown registry reads cannot authorize a stale archive fast path. */ }
    }
    if (active && (known?.remote || (isRecord(known?.host) && Date.now() - Number(known.host.startedAt) < 30_000))) return known;
    // A connected inline executor is the only source of its runtime controller.
    if (active && (known?.status === "running" || known?.status === "paused" && known.pausePending) && !known.host && this.connByName(String(known.executionOwner ?? known.owner))) return known;
    let refusal: RecoveryRefusal | undefined;
    const recovered = this.jobsPath ? await recoverJobRecordAsync(dirname(this.jobsPath), ref, { onUnavailable: value => { refusal = value; } }) : undefined;
    const current = this.storedJob(ref);
    if (!recovered) {
      if (typeof current?.prompt === "string" && typeof current.owner === "string") return current;
      if (refusal?.reason === "recovery_context_unavailable") this.log.debug("job context not reconstructible", refusal);
      else if (refusal) throw new BridgeError("job_index_preparing", `Job recovery unavailable (${refusal.reason}; ${refusal.stage}). No control submitted.`, refusal);
      return undefined;
    }
    if (!this.groups.canControl(peer, recovered as unknown as Record<string, unknown>, this.localPeers())) return current;
    this.recoveredJobs.set(recovered.id, recovered as unknown as Record<string, unknown>);
    this.jobsSnapshot = null; this.jobsForDispatch = null;
    return recovered as unknown as Record<string, unknown>;
  }

  /** Checklist access needs current durable proof, not the compatibility control
   * helper's recovered/label-only fallback. Called again inside the checklist
   * transaction; no await or retained authority fills a missing durable field. */
  private currentChecklistAuthority(witness: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    return this.jobsPath ? readChecklistAuthority(this.jobsPath, witness) : undefined;
  }

  /** Synchronous authorization fence after the handler's final await. Never use
   * an earlier generation or stale grants for a control/routing side effect. */
  private currentJobAuthority(job: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!job || typeof job.id !== "string" || !this.jobsPath) return undefined;
    let active: Record<string, unknown> | undefined;
    try {
      if (indexedJobProjectionCurrent(this.jobsPath)) {
        active = readIndexedJobs(this.jobsPath, { ids: new Set([job.id]), active: true }).jobs[0];
      } else {
      const data = readJsonSnapshot(this.jobsPath).value;
      const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : undefined;
      if (!rows) return undefined;
      active = rows.filter(isRecord).findLast(record => record.id === job.id);
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Keep raw storage errors (which may contain SQL, paths or payloads) off the wire.
        // Only this canonical busy marker is recognized by the existing read retry policy.
        const busy = isSqliteBusy(error) || /\bdatabase is busy\b/i.test(String((error as Error)?.message));
        throw new BridgeError(busy ? "job_index_preparing" : "internal",
          `Job authority unavailable (authority_store_read; authority_fence${busy ? "; SQLITE_BUSY" : ""}). No control submitted.`,
          { reason: "authority_store_read", stage: "authority_fence" });
      }
    }
    this.jobsForDispatch = null;
    const current = active ?? findHistoryJob(dirname(this.jobsPath), String(job.name), job.id) ?? this.storedJob(job.id, false);
    if (!current) return undefined;
    for (const key of ["id", "name", "agent", "startedAt", "sessionId", "threadId"]) {
      if (current[key] !== undefined && current[key] !== null && current[key] !== job[key]) return undefined;
    }
    const latest = { ...job };
    for (const key of ["owner", "supervisor", "executionOwner", "rootName", "rootSession", "parentJob", "masters", "ownershipHistory", "remote", "projectRoot", "args"]) {
      // A retained label-only record can have its owner recovered from the exact header.
      if ((key === "owner" || key === "args") && current[key] === undefined) continue;
      // An archive may predate context/grant fields recovered from its run/spec.
      // Active rows are authoritative about grants removed by a newer handoff.
      if (!active && !(key in current)) continue;
      latest[key] = current[key];
    }
    if (typeof current.prompt === "string") latest.prompt = current.prompt;
    return latest;
  }

  /** storedJobs().find(name or id === ref) through indexed probes instead of a full registry read (AB-300).
   * Control and authority requests resolve one job; a full read per request saturated the broker under load. */
  private storedJob(ref: string, byName = true): Record<string, unknown> | undefined {
    const matches = (job: Record<string, unknown>) => job.id === ref || byName && job.name === ref;
    if (!this.jobsPath || this.jobsForDispatch) return this.storedJobs().find(matches);
    try {
      if (indexedJobProjectionCurrent(this.jobsPath)) {
        const stored = readIndexedJobs(this.jobsPath, { metadata: true, ids: new Set([ref]), ...(byName ? { names: new Set([ref]) } : {}) }).jobs.find(matches);
        // As in storedJobs: a recovered record only stands in for a job the store does not list.
        if (stored) { if (typeof stored.id === "string") this.recoveredJobs.delete(stored.id); return stored; }
        return [...this.recoveredJobs.values()].find(matches);
      }
      // Reuse this negative observation in the legacy path. Rechecking inside
      // storedJobs adds another native projection probe without new evidence.
      return this.storedJobs(false).find(matches);
    } catch { /* Fall back to the full registry read, which handles its own failures. */ }
    return this.storedJobs().find(matches);
  }

  /** The stored jobs of these connected peers through indexed probes, as in storedJob (AB-382): every dashboard
   * refresh decoded the full registry to project a few peers, which blocked broker requests while a tab was open. */
  private peerJobs(peers: readonly PeerInfo[]): Record<string, unknown>[] {
    if (!this.jobsPath || this.jobsForDispatch) return this.storedJobs();
    try {
      if (indexedJobProjectionCurrent(this.jobsPath)) {
        const ids = new Set(peers.flatMap((peer) => peer.id.startsWith("job:") ? [peer.id.slice(4)] : []));
        const stored = readIndexedJobs(this.jobsPath, { metadata: true, ids, names: new Set(peers.map((peer) => peer.name)) }).jobs;
        // As in storedJobs: a recovered record only stands in for a job the store does not list.
        for (const job of stored) if (typeof job.id === "string") this.recoveredJobs.delete(job.id);
        return [...this.recoveredJobs.values(), ...stored];
      }
      return this.storedJobs(false);
    } catch { /* Fall back to the full registry read, which handles its own failures. */ }
    return this.storedJobs();
  }

  /** Full stored records of the jobs this peer may control, with retained history merged in. */
  private async projectJobRecords(c: Conn): Promise<Record<string, unknown>[]> {
    const peer = this.requirePeer(c);
    if (this.jobsPath && this.historyBackground) {
      try { await this.historyBackground.reconcileAsks(); }
      catch (error) { this.log.debug("ask reconciliation deferred; records retained", { error: String(error) }); }
    }
    // Surviving runners may exist only in retained snapshots after an old server overwrote the registry.
    const known = new Set(this.storedJobs().map((job) => job.name));
    for (const runner of this.conns) if (runner.peer?.jobAgent && !known.has(runner.peer.name)) {
      try { await this.jobForControl(peer, runner.peer.name); }
      catch { this.log.debug("project runner enrichment deferred", { reason: "job_authority_unavailable" }); }
    }
    this.jobsForDispatch = null;
    let activeIds = new Set<unknown>();
    try {
      const data = readJsonSnapshot(this.jobsPath!).value;
      const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : undefined;
      if (!rows) return [];
      activeIds = new Set(rows.filter(isRecord).map(record => record.id));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return []; }
    const stored = this.storedJobs();
    const jobs = this.jobsPath && !this.historyBackground ? await projectAskCompletions(this.jobsPath, stored) : stored;
    const retained = this.jobsPath ? selectHistoryJobs(dirname(this.jobsPath), new Set(jobs.filter(job => !activeIds.has(job.id)).map(job => String(job.name)))) : new Map();
    return jobs.map(job => activeIds.has(job.id) ? job : { ...job, ...retained.get(String(job.name)) })
      .filter(job => this.groups.canControl(peer, job, this.localPeers()));
  }

  private storedJobs(projectionCurrent?: false): Record<string, unknown>[] {
    if (!this.jobsPath) return [];
    // Sibling routing consults the registry several times in one synchronous dispatch batch.
    // Share that snapshot until the next microtask, without a timer-based stale window.
    if (this.jobsForDispatch) return this.jobsForDispatch;
    try {
      const archive = readArchivedJobSnapshot(this.jobsPath, { metadata: true });
      if (projectionCurrent !== false && indexedJobProjectionCurrent(this.jobsPath, archive.signature)) {
        // A recovered record only stands in for a job the store does not list. Once the store lists it, the
        // stored record wins: a recovery cached before a handoff must not keep routing to the previous owner.
        const stored = new Set(archive.jobs.map((job) => job.id).filter((id): id is string => typeof id === "string"));
        for (const id of stored) this.recoveredJobs.delete(id);
        return [...this.recoveredJobs.values(), ...archive.jobs];
      }
      const active = readJsonSnapshot(this.jobsPath);
      if (this.jobsSnapshot?.active === active && this.jobsSnapshot.archive === archive.signature) {
        this.jobsForDispatch = this.jobsSnapshot.records;
        queueMicrotask(() => { this.jobsForDispatch = null; });
        return this.jobsForDispatch;
      }
      const data = active.value;
      const jobs = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : [];
      const merged = new Map<string, Record<string, unknown>>();
      for (const [id, job] of this.recoveredJobs) merged.set(id, job);
      for (const job of [...archive.jobs, ...jobs.filter(isRecord)]) {
        if (typeof job.id === "string") { merged.set(job.id, job); this.recoveredJobs.delete(job.id); }
      }
      const records = [...merged.values()];
      this.jobsSnapshot = { active, archive: archive.signature, records };
      this.jobsForDispatch = records;
      queueMicrotask(() => { this.jobsForDispatch = null; });
      return records;
    } catch {
      return [...this.recoveredJobs.values()];
    }
  }

  /** A restored legacy runner may still advertise its old owner name until its next turn. */
  private jobSupervisor(peer: PeerInfo, jobs = this.storedJobs()): string | undefined {
    const job = jobs.find((j) => `job:${j.id}` === peer.id);
    return typeof job?.supervisor === "string" ? job.supervisor : peer.jobOwner;
  }

  private storedSiblings(peer: PeerInfo, target?: string): StoredSibling[] {
    if (!this.jobsPath || !peer.jobOwner) return [];
    try {
      const records = this.storedJobs();
      const supervisor = this.jobSupervisor(peer, records);
      return records.flatMap((j) => j && (!target || j.name === target) && (this.sameJobFamily(peer, { id: `job:${j.id}`, jobOwner: String(j.supervisor) } as PeerInfo, records) || this.sharedJobs(peer, { id: `job:${j.id}` } as PeerInfo, records) || peer.jobSendTo?.includes(String(j.name))) && typeof j.id === "string" &&
        typeof j.name === "string" && j.name !== peer.name && `job:${j.id}` !== peer.id &&
        AGENT_KINDS.includes(j.agent as AgentKind) && SIBLING_STATUSES.has(j.status as SiblingPeer["status"])
        ? [{ id: `job:${j.id}`, name: j.name, title: isRecord(j.args) && typeof j.args.title === "string" ? j.args.title : "", agent: j.agent as AgentKind, status: j.status as SiblingPeer["status"], ...(typeof j.pauseReason === "string" ? { pauseReason: j.pauseReason } : {}), ...(typeof j.pausedAt === "number" ? { pausedAt: j.pausedAt } : {}), ...(typeof j.finishedAt === "number" ? { finishedAt: j.finishedAt } : {}), report: typeof j.report === "string" ? j.report : null }]
        : []);
    } catch {
      return [];
    }
  }

  private siblingPeers(conn: Conn): SiblingPeer[] {
    const live = this.siblingConns(conn);
    const stored = this.storedSiblings(this.requirePeer(conn));
    const peers = new Map(stored.map(({ id, report, ...s }) => [s.name, s]));
    for (const c of live) {
      const p = c.peer!;
      const previous = stored.find((s) => s.id === p.id);
      if (previous) peers.delete(previous.name);
      peers.set(p.name, { name: p.name, title: p.jobTitle ?? "", agent: p.jobAgent!, status: previous?.status ?? "running",
        ...(previous?.pauseReason ? { pauseReason: previous.pauseReason } : {}), ...(previous?.pausedAt ? { pausedAt: previous.pausedAt } : {}),
        ...(previous?.finishedAt !== undefined ? { finishedAt: previous.finishedAt } : {}) });
    }
    const caller = this.requirePeer(conn);
    for (const parent of this.liveConns()) {
      for (const child of this.nativeChildren.list(parent.peer!)) {
        if (this.nativeAllowed(this.nativeChildren.target(child.address), caller.name)) peers.set(child.address, { name: child.address, title: "Native Claude child", agent: "claude", status: "running" });
      }
    }
    return [...peers.values()];
  }

  private async onSendSibling(conn: Conn, args: RequestMap["sendSibling"][0]): Promise<RequestMap["sendSibling"][1]> {
    if (isNativeChildAddress(args.to)) return this.routeNativeSend(conn, args);
    const sender = this.requirePeer(conn);
    const dedupeKey = args.dedupeKey ? `${SIBLING_CONVERSATION_PREFIX}${args.dedupeKey}` : undefined;
    const key = dedupeKey ? `${sender.id}:${dedupeKey}` : null;
    const seen = key ? this.sentByKey.get(key) : undefined;
    if (seen) return seen.result;
    const target = this.siblingConns(conn, args.to).find((c) => c.peer!.name === args.to);
    const stored = this.storedSiblings(sender, args.to).find((s) => s.name === args.to);
    if (!target && !stored) {
      if (!isJobSendTarget(args.to) || !sender.jobSendTo?.includes(args.to) || args.to.includes("-job-") || args.to.includes("-ask-") || this.connByName(args.to)?.peer?.jobAgent) {
        throw new BridgeError("unknown_target", "no sibling with that job name or explicit send_to grant");
      }
      if (args.replyTo) {
        const parent = this.store.byId(args.replyTo);
        const own = this.storedJobs().find((j) => `job:${j.id}` === sender.id);
        const ownerNames = new Set([sender.name, sender.jobParent, own?.owner]);
        if (!parent || !((parent.from.name === args.to && ownerNames.has(parent.recipient)) ||
            (parent.from.id === sender.id && parent.recipient === args.to))) {
          throw new BridgeError("bad_request", "reply_to must refer to a message exchanged with the granted session or supervisor");
        }
      }
      return this.onSend(conn, { ...args, dedupeKey });
    }
    const targetId = target?.peer!.id ?? stored!.id;
    const parent = args.replyTo ? this.store.byId(args.replyTo) : null;
    if (args.replyTo && (!parent || !parent.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX) ||
        !((parent.from.id === targetId && parent.recipient === sender.name) ||
          (parent.from.id === sender.id && parent.recipient === args.to)))) {
      throw new BridgeError("bad_request", "reply_to must refer to a message exchanged with this sibling");
    }
    if (!Number.isInteger(args.maxHops) || args.maxHops < 1 || (parent ? parent.hop + 1 : 0) >= args.maxHops) {
      if (typeof args.body !== "string" || !args.body.trim() || args.body.length > MAX_BODY_CHARS) {
        throw new BridgeError("bad_request", "invalid sibling message body");
      }
      const id = randomUUID();
      const notice: BridgeMessage = {
        id, from: { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent },
        to: sender.jobParent ?? sender.name, recipient: sender.name,
        conversationId: `sibling-drop-${id}`, replyTo: parent?.id ?? null, hop: 0,
        body: `Sibling delivery blocked: ${sender.name} to ${args.to} reached the ${args.maxHops}-message hop limit. The target did not receive this message. Stop this thread and resolve remaining work with the supervisor.\n\nUndelivered text:\n${args.body}`,
        createdAt: this.now(), readAt: null,
      };
      // Persist both notices before surfacing the error. The original text remains inspectable.
      await this.store.retryWrite(() => this.store.insert(notice));
      this.emit(conn, "message", notice);
      if (sender.jobParent && sender.jobParent !== sender.name) {
        const copy = { ...notice, recipient: sender.jobParent };
        await this.store.retryWrite(() => this.store.insert(copy));
        const supervisor = this.connByName(sender.jobParent);
        if (supervisor) this.emit(supervisor, "message", copy);
      }
      throw new BridgeError("bad_request", `sibling conversation reached its ${args.maxHops}-message hop limit; message was not delivered. Durable notice ${id} saved for sender and supervisor, including the undelivered text`);
    }
    const conversationId = parent?.conversationId ?? `${SIBLING_CONVERSATION_PREFIX}${randomUUID()}`;
    const result = await this.onSend(conn, { ...args, dedupeKey, conversationId });
    const message = result.messages[0]!;
    const recipientOwner = target?.peer?.jobParent ?? this.storedJobs().find((j) => j.name === args.to)?.owner;
    const observers = new Set([sender.jobParent, recipientOwner].filter((owner): owner is string => typeof owner === "string"));
    for (const owner of observers) {
      const note = { ...message, id: randomUUID(), recipient: owner,
        conversationId: `${conversationId}${SIBLING_NOTE_SUFFIX}`, body: `Sibling message to ${message.recipient}:\n\n${message.body}` };
      await this.store.retryWrite(() => this.store.insert(note));
      const supervisor = this.connByName(owner);
      if (supervisor) this.emit(supervisor, "message", note);
    }
    if (stored && stored.status !== "running" && stored.status !== "paused") {
      result.finishedRecipient = { name: stored.name, status: stored.status, report: stored.report,
        ...(stored.finishedAt !== undefined ? { finishedAt: stored.finishedAt } : {}) };
    }
    return result;
  }

  private uniqueName(requested: string): string {
    if (!this.connByName(requested)) return requested;
    for (let i = 2; i < NAME_SUFFIX_LIMIT; i++) {
      const candidate = `${requested}-${i}`;
      if (!this.connByName(candidate)) return candidate;
    }
    return `${requested}-${randomUUID().slice(0, 8)}`;
  }

  private onDecide(conn: Conn, value: RequestMap["decide"][0]): RequestMap["decide"][1] {
    const peer = this.requirePeer(conn);
    const parsed = z.object({
      topic: z.string().trim().min(1).max(MAX_DECISION_TOPIC_CHARS),
      text: z.string().trim().min(1).max(MAX_DECISION_TEXT_CHARS),
      scope: decisionScopeSchema.optional(), sourceMessageId: z.string().min(1).optional(),
    }).strict().safeParse(value);
    if (!parsed.success) throw new BridgeError("bad_request", "Invalid decision topic, text or scope.");
    if (parsed.data.sourceMessageId && !this.store.byId(parsed.data.sourceMessageId)) throw new BridgeError("bad_request", "Source message does not exist.");
    const decision = this.store.decisions.record({ ...parsed.data, scope: parsed.data.scope ?? { project: peer.cwd } }, { id: peer.id, name: peer.name, agent: peer.agent }, this.now());
    const deliveredTo = this.notifyDecision(decision);
    this.decisionSync?.announce(decision);
    return { decision, deliveredTo };
  }

  private onDecisions(conn: Conn, value: RequestMap["decisions"][0]): RequestMap["decisions"][1] {
    const parsed = z.object({
      query: z.string().max(MAX_DECISION_TEXT_CHARS).optional(), scope: decisionScopeSchema.optional(),
      history: z.boolean().optional(), topic: z.string().max(MAX_DECISION_TOPIC_CHARS).optional(), session: z.string().optional(),
    }).strict().safeParse(value);
    if (!parsed.success) throw new BridgeError("bad_request", "Invalid decisions query or scope.");
    const scope = parsed.data.scope ?? (conn.peer ? { project: conn.peer.cwd } : undefined);
    return this.store.decisions.list({ ...parsed.data, scope }, conn.peer ?? undefined);
  }

  private decisionSessionKey(peer: PeerInfo): string {
    return `${peer.agent}:${peer.sessionId ?? peer.id}`;
  }

  /** Deliver one decision notification per local session; receipts make redelivery a no-op. */
  private notifyDecision(decision: Omit<OwnerDecision, "current">): string[] {
    const deliveredTo: string[] = [];
    for (const c of this.conns) {
      if (!c.peer || c.peer.jobAgent || !decisionApplies(decision, c.peer)) continue;
      const message = this.queueDecision(decision, c.peer);
      if (message) { this.emit(c, "message", message); deliveredTo.push(c.peer.name); }
    }
    return deliveredTo;
  }

  private queueDecision(decision: Omit<OwnerDecision, "current">, peer: PeerInfo): BridgeMessage | null {
    const message: BridgeMessage = {
      id: randomUUID(), from: decision.author, to: peer.name, recipient: peer.name,
      conversationId: `decision-${decision.id}`, replyTo: decision.sourceMessageId, hop: DECISION_MESSAGE_HOP,
      body: `Pinned owner decision: ${decision.topic}\n\n${decision.text}\n\nCall decisions to look up current decisions or their history.`,
      createdAt: this.now(), readAt: null,
    };
    return this.store.decisions.enqueue(decision, this.decisionSessionKey(peer), message, () => this.store.insert(message)) ? message : null;
  }

  private queueCurrentDecisions(peer: PeerInfo): BridgeMessage[] {
    // Hello may precede the hook that identifies this session. Waiting for that identity avoids
    // sending a second copy on reload before its previous receipt can be found.
    if (peer.jobAgent || !peer.sessionId) return [];
    return this.store.decisions.list().filter((d) => decisionApplies(d, peer)).flatMap((d) => {
      const message = this.queueDecision(d, peer);
      return message ? [message] : [];
    });
  }

  private checkAuth(protocol: number, token: unknown, canHost?: unknown): void {
    if (protocol !== PROTOCOL_VERSION) {
      // Only a client proving the shared token that can demand-start its own daemon can make this one step aside,
      // and only for a newer protocol. CLI commands, job runners and connect-only nodes never send canHost.
      if (this.handoverHandler && canHost === true && typeof protocol === "number" && protocol > PROTOCOL_VERSION && typeof token === "string" && tokensEqual(token, this.token)
        && this.requestHandover({ protocol })) throw this.handoverRefusal("auth");
      throw new BridgeError("protocol_mismatch", `broker speaks protocol ${PROTOCOL_VERSION}, client ${protocol}`, {
        brokerProtocol: PROTOCOL_VERSION,
      });
    }
    if (typeof token !== "string" || !tokensEqual(token, this.token)) {
      this.log.warn("rejected connection with a wrong or missing token");
      throw new BridgeError("unauthorized", "wrong agent-bridge token");
    }
  }

  private async onHello(conn: Conn, args: RequestMap["hello"][0]): Promise<RequestMap["hello"][1]> {
    this.checkAuth(args.protocol, args.token, args.canHost);
    conn.authed = true;
    const p = args.peer;
    if (!p || !PEER_NAME_PATTERN.test(p.name ?? "") || !AGENT_KINDS.includes(p.agent)) {
      throw new BridgeError("bad_request", "invalid peer info");
    }
    if (conn.peer) throw new BridgeError("bad_request", "already registered");
    if (isPluginCacheCwd(String(p.cwd ?? ""))) throw new BridgeError("bad_request", "Plugin-cache processes cannot register as sessions.");
    if (p.subagent && !p.jobAgent) throw new BridgeError("bad_request", "Native subagents cannot register as top-level bridge sessions.");
    // Only a newer client that can demand-start its own daemon may ask for handover (never a job runner).
    // Refused before any registration state changes: the newer release registers with its own daemon. When the
    // repeat limit holds, the newer client registers here as with any older compatible broker.
    if (this.handoverHandler && args.canHost === true && !p.jobAgent && isNewerRelease(p.version, APP_VERSION)
      && this.requestHandover({ version: String(p.version).slice(0, 32) })) throw this.handoverRefusal("hello");
    const peer: PeerInfo = {
      id: String(p.id),
      name: p.name,
      agent: p.agent,
      cwd: String(p.cwd ?? ""),
      pid: Number(p.pid),
      agentPid: p.agentPid ?? null,
      agentStartedAt: typeof p.agentStartedAt === "string" && p.agentStartedAt.length <= 128 ? p.agentStartedAt : null,
      sessionId: p.sessionId ?? null,
      ...(p.frontend ? { frontend: t3BindingSchema.parse(p.frontend) } : {}),
      startedAt: Number(p.startedAt) || this.now(),
      autoWake: Boolean(p.autoWake),
      wakeOnDirect: Boolean(p.wakeOnDirect),
      wakeAvailable: Boolean(p.wakeAvailable),
      wakeMaxHops: typeof p.wakeMaxHops === "number" ? p.wakeMaxHops : undefined,
      activity: p.activity === "busy" || p.activity === "idle" ? p.activity : null,
      unavailable: p.unavailable === true,
      version: typeof p.version === "string" ? p.version.slice(0, 32) : undefined,
      ...(validStoreCapabilities(p.storeCapabilities) ? { storeCapabilities: p.storeCapabilities } : {}),
      ...(p.subagent === true ? { subagent: true } : {}),
      ...(p.jobAgent && AGENT_KINDS.includes(p.jobAgent) ? { jobAgent: p.jobAgent } : {}),
      ...(p.jobAgent && typeof p.jobOwner === "string" && p.jobOwner ? {
        parentJob: typeof p.parentJob === "string" ? p.parentJob : undefined,
        rootSession: typeof p.rootSession === "string" ? p.rootSession : undefined,
        rootName: typeof p.rootName === "string" ? p.rootName : undefined,
        jobOwner: p.jobOwner, jobParent: typeof p.jobParent === "string" ? p.jobParent : undefined,
        jobTitle: typeof p.jobTitle === "string" ? p.jobTitle : undefined,
        jobSendTo: Array.isArray(p.jobSendTo) ? p.jobSendTo.filter(isJobSendTarget).slice(0, MAX_JOB_SEND_TARGETS) : [],
      } : {}),
    };
    this.freezeAgentHost(peer);
    this.refuseRetiredHello(conn, peer);
    if (!peer.sessionId) peer.sessionId = this.store.recoverSession(peer);
    // Recover the identity before allocating a name. Arrival order cannot swap an
    // established suffixed session with another session's base name on reconnect.
    const identity = registrationIdentity(peer);
    const liveOwner = this.localPeers().find(old => old.agent === peer.agent && sameFrontend(old, peer) && (peer.frontend || (peer.sessionId ? old.sessionId === peer.sessionId :
      (old.pid !== peer.pid || old.id === peer.id) && identity && identity === registrationIdentity(old))));
    const remembered = this.store.namesFor(peer).find(name => name.replace(/-\d+$/, "") === p.name.replace(/-\d+$/, "") && !this.connByName(name));
    peer.name = liveOwner?.name ?? this.uniqueName(remembered ?? p.name);
    this.store.rememberSession(peer, this.now());
    conn.peer = peer;
    const aliases = this.replaceStale(conn, peer);
    aliases.push(...this.restoreNames(peer, true));
    if (this.jobsPath) recordStorePeer(dirname(this.jobsPath), peer, { authoritative: true });
    const registration = { id: peer.id, name: peer.name, sessionId: peer.sessionId, generation: ++conn.mailGeneration };
    conn.mailReady = undefined;
    await this.expireStaleQueue(peer.name);
    this.assertQueueRegistration(conn, peer, registration);
    await this.claimQueueAliases(conn, peer, registration, aliases);
    // A job runner is no session of its agent kind: it never takes mail waiting for "any <agent>".
    let claimed = 0;
    if (!peer.jobAgent) {
      await this.expireStaleQueue(agentQueueKey(peer.agent));
      claimed = await this.store.retryWrite(() => {
        this.assertQueueRegistration(conn, peer, registration);
        return this.store.claim(agentQueueKey(peer.agent), peer.name);
      });
    }
    this.assertQueueRegistration(conn, peer, registration);
    conn.mailReady = registration;
    this.updateIdle();
    this.log.info("peer joined", { name: peer.name, agent: peer.agent, jobAgent: peer.jobAgent, cwd: peer.cwd, claimed });
    if (!peer.jobAgent) this.broadcastEvent("peer_joined", peer, conn);
    // Deliver the backlog right after the hello response has been written.
    this.replayMail(conn, peer, () => { this.queueCurrentDecisions(peer); });
    return { brokerPid: process.pid, brokerVersion: APP_VERSION, name: peer.name, sessionId: peer.sessionId, ...(peer.frontend ? { frontend: peer.frontend } : {}), peers: this.livePeers().filter((x) => x.id !== peer.id) };
  }

  /**
   * Mail sent to a "-N" stand-in of this peer's name (a reload ran the session under it briefly) moves to the
   * peer. Only names of that form, and only while no one holds them: another session's mail stays its own.
   */
  private async onClaimMail(conn: Conn, args: RequestMap["claimMail"][0]): Promise<{ moved: number }> {
    const peer = this.requirePeer(conn);
    const registration = conn.mailReady;
    if (!registration || !this.queueReady(conn, peer)) throw new BridgeError("unauthorized", "Queued mail registration is not ready; retry after registration completes.");
    const base = peer.name.replace(/-\d+$/, "");
    let moved = 0;
    for (const name of new Set(args.names ?? [])) {
      const standIn = name !== peer.name && (name === base || (name.startsWith(`${base}-`) && /^\d+$/.test(name.slice(base.length + 1))));
      if (!standIn || this.connByName(name)) continue;
      await this.expireStaleQueue(name);
      moved += await this.store.retryWrite(() => {
        this.assertQueueRegistration(conn, peer, registration);
        return this.connByName(name) ? 0 : this.store.claim(name, registration.name);
      });
    }
    this.assertQueueRegistration(conn, peer, registration);
    if (moved) {
      this.log.info("mail of a stand-in name moved to its session", { to: peer.name, moved });
      this.replayMail(conn, peer);
    }
    return { moved };
  }

  private async onUpdatePeer(conn: Conn, args: RequestMap["updatePeer"][0]): Promise<PeerInfo> {
    if (typeof args.cwd === "string" && isPluginCacheCwd(args.cwd)) throw new BridgeError("bad_request", "Plugin-cache processes cannot register as sessions.");
    const peer = this.requirePeer(conn);
    const previousIdentity = { id: peer.id, agent: peer.agent, sessionId: peer.sessionId, name: peer.name, frontend: peer.frontend };
    const previousName = peer.name;
    if (args.sessionId !== undefined && args.sessionId !== peer.sessionId || args.name !== undefined && args.name !== peer.name) await this.nativeChildren.endParent(peer, true);
    const aliases: string[] = [];
    let replay = args.unavailable === false;
    if (args.unavailable !== undefined) {
      if (peer.jobAgent || typeof args.unavailable !== "boolean") throw new BridgeError("bad_request", "Only masters can change availability.");
      peer.unavailable = args.unavailable;
      void this.routePendingJobMail().catch((err) => this.log.warn("pending job reroute deferred", { err: String(err) }));
    }
    if (peer.jobOwner) {
      if (typeof args.jobParent === "string") peer.jobParent = args.jobParent;
      if (typeof args.jobTitle === "string") peer.jobTitle = args.jobTitle;
    }
    if (args.sessionId !== undefined) {
      const previousKey = this.decisionSessionKey(peer);
      peer.sessionId = args.sessionId;
      this.transferProjectMain(previousIdentity, peer);
      this.store.decisions.linkSession(previousKey, this.decisionSessionKey(peer));
      if (peer.sessionId) aliases.push(...this.replaceStale(conn, peer));
    }
    if (args.autoWake !== undefined) peer.autoWake = Boolean(args.autoWake);
    if (args.wakeOnDirect !== undefined) peer.wakeOnDirect = Boolean(args.wakeOnDirect);
    if (args.wakeAvailable !== undefined) peer.wakeAvailable = Boolean(args.wakeAvailable);
    if (typeof args.wakeMaxHops === "number") peer.wakeMaxHops = args.wakeMaxHops;
    if (typeof args.cwd === "string" && args.cwd) peer.cwd = args.cwd;
    if (args.activity === "busy" || args.activity === "idle") peer.activity = args.activity;
    if (typeof args.name === "string" && args.name !== peer.name) {
      if (!PEER_NAME_PATTERN.test(args.name)) throw new BridgeError("bad_request", "invalid peer name");
      const old = peer.name;
      this.store.rememberName(peer, this.now());
      peer.name = this.uniqueName(args.name);
      this.log.info("peer renamed", { from: old, to: peer.name });
      replay = true;
    }
    this.log.debug("peer updated", { name: peer.name, sessionId: peer.sessionId, autoWake: peer.autoWake, cwd: peer.cwd });
    this.store.rememberSession(peer, this.now());
    this.store.rememberName(peer, this.now());
    aliases.push(...this.restoreNames(peer, args.sessionId !== undefined));
    this.transferProjectMain({ ...previousIdentity, sessionId: peer.sessionId }, peer);
    replay ||= previousName !== peer.name || aliases.length > 0;
    if (replay || args.sessionId !== undefined) {
      const registration = { id: peer.id, name: peer.name, sessionId: peer.sessionId, generation: ++conn.mailGeneration };
      conn.mailReady = undefined;
      await this.expireStaleQueue(peer.name);
      this.assertQueueRegistration(conn, peer, registration);
      await this.claimQueueAliases(conn, peer, registration, aliases);
      this.assertQueueRegistration(conn, peer, registration);
      conn.mailReady = registration;
    }
    if (replay) this.replayMail(conn, peer);
    for (const message of this.queueCurrentDecisions(peer)) this.emit(conn, "message", message);
    return peer;
  }

  /**
   * One agent session, two servers: Claude Code's /reload-plugins (or a restart of the MCP server) starts a new
   * agent-bridge server while the old one may still be connected. The old one would keep the name and receive
   * mail the session no longer sees. So the newest server of a session wins: the old connection is told it was
   * replaced (it stops instead of reconnecting) and the new one takes over its name and waiting mail.
   */
  private replaceStale(conn: Conn, peer: PeerInfo): string[] {
    const aliases: string[] = [];
    for (const c of [...this.conns]) {
      const old = c.peer;
      if (c === conn || !old || old.agent !== peer.agent || !sameFrontend(old, peer)) continue;
      const sameSession = peer.frontend || peer.sessionId && old.sessionId === peer.sessionId;
      const identity = registrationIdentity(peer);
      // Separate MCP processes of the same CLI can overlap before a hook learns its session id.
      const sameProcess = (old.pid !== peer.pid || old.id === peer.id) && identity && identity === registrationIdentity(old) &&
        (!old.sessionId || !peer.sessionId || old.sessionId === peer.sessionId);
      if (!sameSession && !sameProcess) continue;
      const previousIdentity = { id: old.id, agent: old.agent, sessionId: old.sessionId, name: old.name, frontend: old.frontend };
      this.store.rememberName(old, this.now());
      this.log.info("session connected again from a new server; replacing the old connection", { name: old.name, by: peer.name, sessionId: peer.sessionId });
      this.emit(c, "replaced", { by: peer.name, ...(peer.version ? { version: peer.version } : {}), agentPid: peer.agentPid ?? null, agentStartedAt: peer.agentStartedAt ?? null });
      void this.nativeChildren.endParent(old, true).catch(err => this.log.warn("replaced native child fallback deferred", { err: String(err) }));
      this.conns.delete(c);
      c.peer = null;
      this.broadcastEvent("peer_left", old, c);
      c.socket.end();
      if (peer.name !== old.name && !this.connByName(old.name)) {
        // Keep the session's usual name: take the old one's only when ours is a "-N" stand-in for it (the usual
        // reload). A leftover server can also be the one holding "-N"; then the new server keeps its own name.
        const oldName = old.name;
        if (peer.name.startsWith(`${oldName}-`) && /^\d+$/.test(peer.name.slice(oldName.length + 1))) peer.name = oldName;
        // Either way, mail that waited under the old name is the session's.
        aliases.push(oldName);
      }
      this.transferProjectMain(previousIdentity, peer);
    }
    return aliases;
  }

  private restoreNames(peer: PeerInfo, reclaim: boolean): string[] {
    const names = this.store.namesFor(peer);
    if (reclaim) {
      const base = peer.name.replace(/-\d+$/, "");
      const original = names.find((name) => name.replace(/-\d+$/, "") === base && (name === peer.name || !this.connByName(name)));
      if (original) peer.name = original;
    }
    this.store.rememberName(peer, this.now());
    return names.filter(name => name !== peer.name && !this.connByName(name));
  }

  private async claimQueueAliases(conn: Conn, peer: PeerInfo, registration: QueueRegistration, aliases: string[]): Promise<void> {
    for (const alias of new Set(aliases)) {
      if (alias === registration.name || this.connByName(alias)) continue;
      await this.expireStaleQueue(alias);
      await this.store.retryWrite(() => {
        this.assertQueueRegistration(conn, peer, registration);
        if (!this.connByName(alias)) this.store.claim(alias, registration.name);
      });
    }
  }

  /** Exact registrations win; an unoccupied retained alias must identify one live session. */
  private recipientConn(name: string): Conn | undefined {
    const exact = this.connByName(name);
    if (exact) return exact;
    const matches = this.liveConns().filter((c) => c.peer && this.store.namesFor(c.peer).includes(name));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Before a peer takes over queued mail. Names are derived from the project folder and reused by every
   * later session there, so a name alone does not identify the session that mail was meant for. Mail that
   * waited longer than QUEUED_MAIL_MAX_AGE_MS most likely belongs to a session that is gone; recent mail
   * still reaches a session that restarted or reconnected after a broker hand-over.
   */
  private async expireStaleQueue(key: string): Promise<void> {
    try {
      const maxAge = retentionLimit("AGENT_BRIDGE_QUEUED_MAIL_MAX_AGE_MS", QUEUED_MAIL_MAX_AGE_MS);
      if (maxAge) await this.store.expireQueuedAsync(key, this.now() - maxAge);
    } catch (err) {
      this.log.warn("expiring queued mail failed", { key, err });
      throw err;
    }
  }

  /** An expiry retry must not grant queued mail to a changed or replaced session. */
  private assertQueueRegistration(conn: Conn, peer: PeerInfo, registration: QueueRegistration): void {
    if (conn.socket.destroyed || conn.peer !== peer || peer.id !== registration.id || peer.name !== registration.name ||
      peer.sessionId !== registration.sessionId || conn.mailGeneration !== registration.generation || this.connByName(registration.name) !== conn) {
      throw new BridgeError("unauthorized", "Session changed while queued mail was archived; reconnect to claim retained mail.");
    }
  }

  private queueReady(conn: Conn, peer: PeerInfo): boolean {
    const ready = conn.mailReady;
    return Boolean(ready && conn.peer === peer && ready.generation === conn.mailGeneration && ready.id === peer.id &&
      ready.name === peer.name && ready.sessionId === peer.sessionId && this.connByName(peer.name) === conn);
  }

  private async awaitHandoffReaders(source: Conn, target: Conn): Promise<void> {
    const controller = new AbortController();
    const closed = () => controller.abort(new BridgeError("unauthorized", "A handoff session disconnected during store reader verification; no job ownership was changed."));
    const timer = setTimeout(() => controller.abort(new BridgeError("timeout", "Store reader verification timed out before handoff; no job ownership was changed.")), HANDOFF_STORE_READY_MS);
    source.socket.once("close", closed); target.socket.once("close", closed);
    let aborted!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    try { await Promise.race([refreshStorePeerIdentities(dirname(this.jobsPath!), controller.signal), interrupted]); }
    finally {
      clearTimeout(timer);
      source.socket.off("close", closed); target.socket.off("close", closed);
      controller.signal.removeEventListener("abort", aborted);
    }
  }

  private assertHandoffRegistration(conn: Conn, peer: PeerInfo, registration: Pick<PeerInfo, "id" | "name" | "sessionId" | "cwd">): void {
    if (this.closing || !conn.authed || !this.conns.has(conn) || conn.socket.destroyed || conn.peer !== peer ||
      peer.id !== registration.id || peer.name !== registration.name || peer.sessionId !== registration.sessionId || peer.cwd !== registration.cwd ||
      this.connByName(registration.name) !== conn) {
      throw new BridgeError("unauthorized", "Session identity or project changed while store readers were verified; retry from the current sessions. No job ownership was changed.");
    }
  }

  /** Turns a sender-supplied target into live connections and/or offline queue keys. */
  private resolveTargets(to: string, sender: PeerInfo): { live: Conn[]; queued: string[]; skipped?: string[] } {
    const all = this.liveConns().filter((c) => c.peer && c.peer.id !== sender.id);
    // Broadcasts and agent kinds address sessions; job runners only get mail sent to them by name.
    const others = all.filter((c) => !c.peer!.jobAgent);
    if (to.startsWith("project:")) {
      const members = this.localPeers().filter((p) => !p.jobAgent && !p.subagent).map((p) => this.projectPeer(p)).filter((p) => p.projectAddress === to);
      const keys = new Set(members.map((p) => p.projectGroup));
      if (keys.size !== 1) throw new BridgeError(keys.size > 1 ? "ambiguous_target" : "unknown_target", "Use a unique live local project address from peers.");
      const target = members.filter((p) => !p.unavailable).sort((a, b) => Number(Boolean(b.projectMain)) - Number(Boolean(a.projectMain)) || a.startedAt - b.startedAt || a.name.localeCompare(b.name))[0];
      if (!target) throw new BridgeError("unknown_target", "No project master is available; use an exact session name to queue mail.");
      // Project conversations belong to the whole live team. A secondary coordinating a topic
      // must see incoming proposals without spending a supervisor turn on a manual relay.
      const recipients = members.filter((p) => !p.unavailable && p.id !== sender.id);
      if (!recipients.length) throw new BridgeError("unknown_target", "No other available project session; use an exact name to queue mail.");
      return { live: recipients
        .sort((a, b) => Number(Boolean(b.projectMain)) - Number(Boolean(a.projectMain)))
        .map((p) => this.connByName(p.name)!), queued: [] };
    }
    if (to === BROADCAST) {
      if (sender.jobAgent) throw new BridgeError("unauthorized", "job runners cannot broadcast to independent sessions");
      const ownNames = new Set([sender.name, ...this.store.namesFor(sender)]);
      const masters = new Set([...this.projectMains.values()].map(peer => peer.name).concat(this.storedJobs().filter((job) => !job.parentJob && job.status === "running").map(primaryFor)).filter((name) => PEER_NAME_PATTERN.test(name)));
      const eligible = this.store.broadcastRecipients(this.now(), masters);
      const offline = (name: string) => !ownNames.has(name) && !this.recipientConn(name);
      const queued = eligible.queued.filter(offline), skipped = eligible.skipped.filter(offline);
      if (others.length === 0 && queued.length === 0 && skipped.length === 0 && !this.network?.peers().some((p) => !p.jobAgent)) {
        throw new BridgeError("unknown_target", "no other known sessions; send to an exact name to create an offline queue");
      }
      return { live: others, queued, skipped };
    }
    const recipient = this.recipientConn(to);
    const exact = all.find((c) => c.peer!.id === to || c === recipient);
    if (exact) return { live: [exact], queued: [] };
    if (recipient?.peer?.id === sender.id || to === sender.name || to === sender.id) throw new BridgeError("bad_request", "cannot send a message to yourself");
    if ((AGENT_KINDS as readonly string[]).includes(to)) {
      const ofKind = others.filter((c) => c.peer!.agent === (to as AgentKind));
      if (ofKind.length === 1) return { live: ofKind, queued: [] };
      if (ofKind.length > 1) {
        throw new BridgeError("ambiguous_target", `several ${to} peers are online`, {
          candidates: ofKind.map((c) => c.peer!.name),
        });
      }
      return { live: [], queued: [agentQueueKey(to as AgentKind)] };
    }
    if (!PEER_NAME_PATTERN.test(to)) throw new BridgeError("unknown_target", `invalid target: ${to}`);
    return { live: [], queued: [to] };
  }

  /** Results of recent sends by dedupe key (see SendArgs.dedupeKey), so a retry is not sent twice. */
  private readonly sentByKey = new Map<string, { at: number; result: RequestMap["send"][1] }>();
  private readonly sendingByKey = new Map<string, Promise<RequestMap["send"][1]>>();
  private readonly trackedSending = new Map<string, { sender: string; fingerprint: string; result: Promise<RequestMap["send"][1]> }>();

  private sendState(conn: Conn, id: string): RequestMap["sendState"][1] {
    const sender = this.requirePeer(conn), message = this.store.byId(id), pending = this.trackedSending.get(id);
    if ((message && message.from.name !== sender.name) || (pending && pending.sender !== sender.name)) {
      throw new BridgeError("unauthorized", "Only the original sender can inspect or retry this message id.");
    }
    return { id, state: message ? "stored" : pending ? "pending" : "not_stored", checkedAt: this.now(),
      message, receipts: message ? this.store.receipts(id) : [] };
  }

  private async onTrackedSend(conn: Conn, args: RequestMap["trackedSend"][0]): Promise<RequestMap["send"][1]> {
    const id = z.uuid().parse(args.messageId).toLowerCase(), sender = this.requirePeer(conn);
    const state = this.sendState(conn, id);
    if (state.message) {
      const message = state.message;
      // Recipient routing hints are the only broker-added body suffix. Ownership may redirect job mail.
      const bodyMatches = message.body === args.body || message.body.startsWith(args.body + "\n\n[agent-bridge routing hint:");
      if (!bodyMatches || (!sender.jobAgent && message.to !== args.to.trim()) ||
          message.replyTo !== (args.replyTo?.trim() || null) ||
          args.conversationId && message.conversationId !== args.conversationId.trim() &&
          !(sender.jobAgent && message.conversationId === args.conversationId.trim() + ":fallback")) {
        throw new BridgeError("bad_request", "Message id already stored with different content; use a new id for a new message.");
      }
      const receipts = message.recipient.includes("/") && !isNativeChildAddress(message.recipient) ? await this.messageReceipt(conn, id).catch(() => state.receipts) : state.receipts;
      return { messages: this.store.messagesById(id), deliveredTo: [], queuedFor: [], storage: { id, state: "stored", recovered: true, receipts } };
    }
    const fingerprint = JSON.stringify([args.to, args.body, args.replyTo, args.conversationId, args.ifNoNewerThan]);
    const pending = this.trackedSending.get(id);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new BridgeError("bad_request", "Message id already pending with different content.");
      return pending.result;
    }
    const result = this.routeSend(conn, sender, { ...args, messageId: id }).then(sent => ({ ...sent,
      storage: { ...sent.storage, id, state: this.store.byId(id) ? "stored" as const : "not_stored" as const, receipts: sent.storage?.receipts ?? this.store.receipts(id) } }));
    this.trackedSending.set(id, { sender: sender.name, fingerprint, result });
    try {
      return await result;
    } catch (error) {
      const state = this.store.byId(id) ? "stored" : "unknown";
      throw new BridgeError(error instanceof BridgeError ? error.code : "internal",
        `Message ${id} storage state is ${state}; routing failed: ${(error as Error).message}. Query send_status or retry with the same message_id; remote storage may precede its acknowledgement.`,
        { ...(error instanceof BridgeError ? error.details : {}), messageId: id, state });
    } finally { this.trackedSending.delete(id); }
  }

  private async onSend(conn: Conn, args: RequestMap["send"][0]): Promise<RequestMap["send"][1]> {
    const sender = this.requirePeer(conn);
    const key = typeof args.dedupeKey === "string" && args.dedupeKey ? `${sender.id}:${args.dedupeKey}` : null;
    const seen = key ? this.sentByKey.get(key) : undefined;
    if (seen) return seen.result;
    const inFlight = key ? this.sendingByKey.get(key) : undefined;
    if (inFlight) return inFlight;
    const sending = this.routeSend(conn, sender, args);
    if (key) this.sendingByKey.set(key, sending);
    let result: RequestMap["send"][1];
    try { result = await sending; }
    finally { if (key) this.sendingByKey.delete(key); }
    if (key) {
      const now = this.now();
      this.sentByKey.set(key, { at: now, result });
      for (const [k, v] of this.sentByKey) {
        if (now - v.at < DEDUPE_KEEP_MS && this.sentByKey.size <= DEDUPE_MAX) break;
        this.sentByKey.delete(k);
      }
    }
    return result;
  }

  /** One-shot optional modes; this is not the future transactional delivery layer. */
  private async onModeSend(conn: Conn, args: RequestMap["modeSend"][0]): Promise<RequestMap["modeSend"][1]> {
    const sender = this.requirePeer(conn);
    const parsed = z.object({ mode: z.enum(["auto", "queue", "steer", "restart"]),
      to: z.string().min(1), body: z.string().min(1).max(MAX_BODY_CHARS),
      nativeChild: z.string().optional(), messageId: z.uuid().optional(), dedupeKey: z.string().optional(),
      conversationId: z.string().optional(), replyTo: z.string().optional(), ifNoNewerThan: z.string().optional(),
    }).strict().safeParse(args);
    if (!parsed.success) throw new BridgeError("bad_request", "Invalid modeSend arguments; no mode operation applied.");
    const a = parsed.data;
    const mode: SendModeReport = { requested: a.mode, effective: "refused", stage: "requested",
      protocolSupport: "mode-v1", sharedIdempotentDelivery: false,
      capabilities: { route: "unsupported", receiverRole: "unknown", ownedSession: false,
        generationKnown: false, activeSteering: false, interruptRestart: false, queue: false, idleWake: false } };
    const refuse = (reason: string): never => {
      throw new BridgeError("bad_request", `Requested ${a.mode} refused: ${reason}. No mode operation applied.`, { modeReport: { ...mode, reason } });
    };
    const queueIssuerSupported = (peer: PeerInfo): boolean => !peer.subagent && !peer.jobAgent &&
      !peer.id.startsWith("job:") && peer.agent !== "other" &&
      !this.storedJobs().some(job => job.name === peer.name || `job:${job.id}` === peer.id);
    if (a.to === "muse" || /^muse-(?:job|ask)-/.test(a.to)) refuse("Muse support belongs to PR20 and is unavailable");
    if (a.mode === "queue" && (a.messageId !== undefined || a.dedupeKey !== undefined)) refuse("one-shot queue rejects caller IDs and dedupe keys");
    // Scoped sender selection never changes the connection or grants authority.
    const fromChild = a.nativeChild !== undefined ? this.nativeChildren.own(sender, a.nativeChild).address : undefined;
    if (a.mode === "steer" || a.mode === "restart") refuse("active steering and interrupt/restart boundaries are unsupported");
    if (a.mode === "auto") {
      let send: RequestMap["send"][1];
      try {
        send = fromChild ? await this.routeNativeSend(conn, a, fromChild) :
          a.messageId ? await this.onTrackedSend(conn, { ...a, messageId: a.messageId }) : await this.onSend(conn, a);
      } catch (error) {
        // BridgeClient recognizes old-broker opcode refusal by its wire error.
        // A downstream failure AFTER this handler started cannot prove no effect.
        if (String((error as Error)?.message).includes("unknown op:") ||
            error instanceof BridgeError && error.code === "protocol_mismatch") {
          throw new BridgeError("internal", "modeSend downstream protocol failed; outcome unknown, legacy fallback is unsafe.",
            { modeReport: { ...mode, effective: "legacyunconfirmed", stage: "unknown", reason: "downstream protocol failure" } });
        }
        throw error;
      }
      const recipient = send.messages[0]?.recipient;
      const nativeRoute = Boolean(recipient && isNativeChildAddress(recipient));
      let native: ReturnType<NativeChildren["target"]> | undefined;
      if (nativeRoute) { try { native = this.nativeChildren.target(recipient!); } catch { /* It may have stopped after commit. */ } }
      const target = recipient ? this.connByName(recipient) : undefined;
      const targetPeer = target?.peer;
      const nativeOwner = native ? this.connByName(native.parent) : undefined;
      const nativeCurrent = Boolean(native && nativeOwner?.peer && nativeOwner.peer.id === native.owner &&
        nativeOwner.peer.sessionId === native.session && nativeOwner.peer.agent === "claude" &&
        !nativeOwner.peer.subagent && !nativeOwner.peer.jobAgent && this.queueReady(nativeOwner, nativeOwner.peer));
      mode.effective = nativeRoute ? "nativequeue" : "mailbox";
      mode.stage = send.storage?.state === "stored" || send.messages.length > 0 &&
        send.messages.every(message => Boolean(this.store.byId(message.id))) ? "stored" : "requested";
      mode.capabilities = { ...mode.capabilities, route: mode.effective,
        receiverRole: nativeRoute ? "native_child" : targetPeer?.jobAgent ? "delegated_job" : targetPeer ? "session" : "unknown",
        ownedSession: native ? native.owner === sender.id : target === conn,
        generationKnown: nativeRoute ? nativeCurrent : Boolean(target && targetPeer && this.queueReady(target, targetPeer)),
        queue: Boolean(native && nativeCurrent && !fromChild && queueIssuerSupported(sender) &&
          this.queueReady(conn, sender) && this.nativeAllowed(native, sender.name)),
        idleWake: !nativeRoute && targetPeer?.wakeAvailable && !targetPeer.jobAgent && targetPeer.agent !== "antigravity" ? "conditional" : false };
      return { send, mode };
    }
    if (fromChild || !isNativeChildAddress(a.to)) refuse("explicit queue is available only to an existing scoped Claude native target");
    // Legacy runner registrations can contain caller-supplied ownership hints.
    // New queue admission never turns those DTOs into an issuer generation.
    if (!queueIssuerSupported(sender)) {
      refuse("delegated or unknown issuer generation is unsupported for one-shot queue");
    }
    const child = this.nativeChildren.target(a.to), ownerConn = this.connByName(child.parent), owner = ownerConn?.peer;
    const sourceRegistration = conn.mailReady, ownerRegistration = ownerConn?.mailReady;
    if (!sourceRegistration || !this.queueReady(conn, sender) || !ownerConn || !owner || !ownerRegistration ||
        !this.queueReady(ownerConn, owner) || owner.id !== child.owner || owner.sessionId !== child.session) refuse("current native generation is unknown or stale");
    // Captured broker registrations are rechecked inside the existing insertion transaction.
    const current = () => {
      this.assertQueueRegistration(conn, sender, sourceRegistration!);
      this.assertQueueRegistration(ownerConn!, owner!, ownerRegistration!);
      if (!queueIssuerSupported(this.requirePeer(conn))) refuse("registered issuer role is unsupported for one-shot queue");
      this.nativeChildren.own(this.requirePeer(ownerConn!), child.agentId);
    };
    current();
    const id = randomUUID();
    const send = await this.routeNativeSend(conn, { ...a, messageId: id }, undefined, current);
    mode.effective = "nativequeue";
    mode.stage = "stored";
    mode.capabilities = { ...mode.capabilities, route: "nativequeue", receiverRole: "native_child",
      ownedSession: child.owner === sender.id, generationKnown: true, queue: true };
    return { send, mode };
  }

  /** Native queues admit only their parent, directly owned jobs and exact grants. */
  private nativeAllowed(child: ReturnType<NativeChildren["target"]>, name: string): boolean {
    if (name === child.parent || child.sendTo.includes(name)) return true;
    const job = this.storedJobs().find(j => j.name === name);
    if (job) return job.owner === child.parent && job.supervisor === child.session;
    const peer = this.connByName(name)?.peer;
    return Boolean(peer?.jobAgent && peer.jobParent === child.parent && peer.jobOwner === child.session);
  }

  /** Virtual sender selection is internal to this opcode, never a hello or connection mutation. */
  private async routeNativeSend(conn: Conn, args: RequestMap["send"][0], fromChild?: string, current?: () => void): Promise<RequestMap["send"][1]> {
    const peer = this.requirePeer(conn), to = String(args.to ?? "").trim();
    const child = this.nativeChildren.target(fromChild ?? to);
    const senderName = fromChild ?? peer.name;
    const check = () => {
      current?.();
      if (fromChild) this.nativeChildren.own(peer, child.agentId);
      else this.nativeChildren.target(to);
      const owner = this.connByName(child.parent)?.peer;
      if (!owner || owner.id !== child.owner || owner.sessionId !== child.session ||
          !this.nativeAllowed(child, fromChild ? to : senderName)) throw new BridgeError("unauthorized", "Native child mail requires its parent, the parent's bridge job, or an exact send_to grant.");
    };
    check();
    if (!args.body?.trim() || args.body.length > MAX_BODY_CHARS) throw new BridgeError("bad_request", "Invalid native child message body.");
    if (fromChild && (to === senderName || isNativeChildAddress(to))) throw new BridgeError("unauthorized", "Use an exact granted session or bridge job target.");
    const sender = { id: fromChild ? `native:${child.owner}:${child.agentId}` : peer.id, name: senderName, agent: fromChild ? "claude" as const : peer.jobAgent ?? peer.agent };
    const anchor = args.replyTo ? this.store.byId(args.replyTo) : null;
    if (args.replyTo && (!anchor || !((anchor.from.name === to && this.store.receipts(anchor.id).some(r => r.recipient === senderName)) ||
        (anchor.from.name === senderName && anchor.recipient === to)))) throw new BridgeError("bad_request", "reply_to must identify mail exchanged with this recipient.");
    const hop = anchor ? anchor.hop + 1 : 0;
    if (hop >= child.maxHops) throw new BridgeError("bad_request", `Native child conversation reached its ${child.maxHops}-message hop limit; message was not delivered.`);
    if (args.conversationId && !args.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX)) throw new BridgeError("bad_request", "Native child conversation_id must be a sibling thread returned by a previous send.");
    const conversationId = anchor?.conversationId ?? args.conversationId ?? `${SIBLING_CONVERSATION_PREFIX}${randomUUID()}`;
    const guard = args.ifNoNewerThan ? this.store.byId(args.ifNoNewerThan) : null;
    if (args.ifNoNewerThan && (!guard || guard.from.name !== senderName && !this.store.receipts(guard.id).some(r => r.recipient === senderName))) throw new BridgeError("bad_request", "Invalid native child reply guard.");
    const id = args.messageId ? z.uuid().parse(args.messageId).toLowerCase() : args.dedupeKey ? completionMessageId(`native:${sender.id}:${to}`, args.dedupeKey) : randomUUID();
    const recovered = (): RequestMap["send"][1] | null => {
      const existing = this.store.byId(id);
      if (!existing) return null;
      if (existing.from.name !== senderName || existing.to !== to || existing.body !== args.body || existing.replyTo !== (args.replyTo ?? null)) throw new BridgeError("bad_request", "Message id already belongs to different content or sender.");
      return { messages: this.store.messagesById(id), deliveredTo: [], queuedFor: [], storage: { id, state: "stored", recovered: true, receipts: this.store.receipts(id) } };
    };
    const existing = recovered();
    if (existing) return existing;
    const message: BridgeMessage = { id, from: sender, to, recipient: to, conversationId, replyTo: args.replyTo ?? null, hop, replyLimit: child.maxHops, body: args.body, createdAt: this.now(), readAt: null };
    const copies = to === child.parent ? [] : [{ ...message, id: randomUUID(), recipient: child.parent, conversationId: `${conversationId}${SIBLING_NOTE_SUFFIX}`, body: `Native child message to ${to}:\n\n${args.body}` }];
    const previous = await this.store.retryWrite(() => {
      check();
      const previous = recovered();
      if (previous) return previous;
      this.store.insertBatch([message, ...copies], () => {
        if (current) check(); // New one-shot queue: recheck after BEGIN IMMEDIATE.
        if (guard && this.store.replyConflicts(senderName, [to], conversationId, guard).length) throw new BridgeError("bad_request", "Stale reply refused: newer unread mail exists.");
      });
      return null;
    });
    if (previous) return previous;
    // Child queues are pulled at that child's hook/tool boundary. Never emit them as parent work.
    const recipient = fromChild ? this.connByName(to) : null;
    if (recipient) this.emit(recipient, "message", message);
    const supervisor = this.connByName(child.parent);
    for (const copy of copies) if (supervisor) this.emit(supervisor, "message", copy);
    return { messages: [message], deliveredTo: recipient ? [to] : [], queuedFor: recipient ? [] : [to], storage: { id, state: "stored", receipts: this.store.receipts(id) } };
  }

  /** Reverse permissions use the current durable record, not stale runner registration. */
  private replyRestriction(sender: PeerInfo, name: string): { name: string; supervisor: string } | null {
    const jobs = this.storedJobs(), peer = this.connByName(name)?.peer;
    const stored = jobs.find((j) => j.name === name);
    if (!stored && !peer?.jobAgent) return null;
    const job = stored ?? { id: peer!.id.replace(/^job:/, ""), name, owner: peer!.jobParent,
      supervisor: peer!.jobOwner, rootName: peer!.rootName, parentJob: peer!.parentJob,
      workdir: peer!.cwd, args: { send_to: peer!.jobSendTo } };
    const recipient = { ...peer, id: `job:${job.id}`, name, jobOwner: typeof job.supervisor === "string" ? job.supervisor : peer?.jobOwner } as PeerInfo;
    const grants = isRecord(job.args) && Array.isArray(job.args.send_to) ? job.args.send_to : [];
    if (sender.name === name || grants.includes(sender.name) || this.groups.canControl(sender, job, this.localPeers()) ||
        sender.jobAgent && (this.sameJobFamily(recipient, sender, jobs) || this.sharedJobs(recipient, sender, jobs))) return null;
    return { name, supervisor: this.jobRecipient(job) || peer?.jobParent || "the project's main session" };
  }

  private async routeSend(conn: Conn, sender: PeerInfo, args: RequestMap["send"][0]): Promise<RequestMap["send"][1]> {
    if (isNativeChildAddress(args.to)) return this.routeNativeSend(conn, args);
    const body = typeof args.body === "string" ? args.body : "";
    if (!body.trim()) throw new BridgeError("bad_request", "message body is empty");
    if (body.length > MAX_BODY_CHARS) throw new BridgeError("too_large", `message body exceeds ${MAX_BODY_CHARS} characters`);
    let to = String(args.to ?? "").trim();
    if (!to) throw new BridgeError("bad_request", "missing target");

    // Durable ownership wins over the old name cached in a still-running parent link.
    const own = sender.jobAgent ? this.storedJobs().find((j) => `job:${j.id}` === sender.id) : undefined;
    const supervisorMail = Boolean(own && (to === sender.jobParent || mastersFor(own).includes(to)));
    const question = isJobQuestion({ conversationId: args.conversationId ?? "" });
    if (own) {
      if (to === sender.jobParent || mastersFor(own).includes(to)) to = this.jobRecipient(own, question);
      else if (Array.isArray(own.ownershipHistory) && own.ownershipHistory.some((h) => isRecord(h) && h.fromRootName === to)) to = String(own.rootName);
      this.refreshJobPeer(own);
    }
    const controlled = this.storedJobs().find((j) => j.name === to);
    if ((controlled || this.connByName(to)?.peer?.jobAgent) &&
        !args.conversationId?.startsWith(CONTROL_CONVERSATION_PREFIX) &&
        !args.conversationId?.startsWith(SIBLING_CONVERSATION_PREFIX)) {
      throw new BridgeError("bad_request", "Ordinary direct mail to a job is not supported. Ask its supervisor to use message_subagent, or use the granted sibling channel. No message was stored.",
        { state: "not_stored", recipient: to });
    }
    if (args.conversationId?.startsWith(CONTROL_CONVERSATION_PREFIX) && controlled && !this.groups.canControl(sender, controlled, this.localPeers())) {
      throw new BridgeError("unauthorized", "Only the current supervisor can control this job runner.");
    }

    let conversationId = args.conversationId?.trim() || "";
    let hop = 0;
    const replyTo = args.replyTo?.trim() || null;
    if (replyTo) {
      const parent = this.store.byId(replyTo);
      if (parent) {
        hop = parent.hop + 1;
        conversationId ||= parent.conversationId;
      } else {
        this.log.debug("replyTo refers to an unknown message", { replyTo });
      }
    }
    const anchor = args.ifNoNewerThan ? this.store.byId(args.ifNoNewerThan) : null;
    if (args.ifNoNewerThan && (!anchor || (anchor.from.id !== sender.id && !this.store.receipts(anchor.id).some(r => r.recipient === sender.name)))) {
      throw new BridgeError("bad_request", "if_no_newer_than must identify a message exchanged by this session.");
    }
    conversationId ||= anchor?.conversationId || args.messageId || randomUUID();
    let jobControlAuthorized = false;
    if (conversationId === DASHBOARD_JOB_CONVERSATION) {
      let command: unknown;
      try { command = JSON.parse(body); } catch { /* Fail closed for malformed control messages. */ }
      const reject = () => {
        this.log.warn("rejected unauthorized dashboard job command", { from: sender.name, to });
        throw new BridgeError("unauthorized", "Only the owner dashboard or a controlling job master can send this command.");
      };
      if (!isRecord(command)) reject();
      const control = command as Record<string, unknown>;
      if (control.type === "result") {
        const parent = replyTo ? this.store.byId(replyTo) : null;
        let request: unknown;
        try { request = parent && JSON.parse(parent.body); } catch { /* Invalid reply anchor. */ }
        if (!parent || parent.conversationId !== DASHBOARD_JOB_CONVERSATION || parent.recipient !== sender.name ||
            parent.from.name !== to || !isRecord(request) || request.type === "result" || request.requestId !== control.requestId) reject();
      } else {
        if (!["message", "settings", "handoff"].includes(String(control.type)) || typeof control.requestId !== "string" || typeof control.job !== "string") reject();
        const target = this.connByName(to)?.peer;
        if (!target || target.jobAgent || target.subagent) reject();
        if (conn.peer) {
          const records = this.storedJobs();
          // Handoff can move a tree or all jobs, so authorize every selected root, not the display job.
          const selected = control.type === "handoff" ? records.filter(j => !j.parentJob &&
            this.groups.canControl(target!, j, this.localPeers()) && (control.jobs === undefined || control.jobs === "all" ||
              Array.isArray(control.jobs) && (control.jobs.includes(j.name) || control.jobs.includes(j.id)))) :
            records.filter(j => j.name === control.job || j.id === control.job);
          if (!selected.length || selected.some(j => !this.groups.canControl(sender, j, this.localPeers()))) reject();
        }
        jobControlAuthorized = true;
      }
    }
    if (own && (to === own.rootName || to === own.owner || this.groups.members(own, this.localPeers()).some((p) => p.name === to) || mastersFor(own).includes(to))) conversationId = this.jobConversation(own, to, conversationId);

    const id = args.messageId ?? (sender.jobAgent && args.dedupeKey?.startsWith(COMPLETION_DEDUPE_PREFIX)
      ? completionMessageId(sender.id, args.dedupeKey.slice(COMPLETION_DEDUPE_PREFIX.length)) : randomUUID());
    const createdAt = this.now();
    const base = {
      id,
      // A job runner speaks for its job: from the subagent's agent, like a job run inside the session's server.
      from: { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent },
      to,
      conversationId,
      replyTo,
      hop,
      body,
      createdAt,
      readAt: null,
      ...(jobControlAuthorized ? { jobControlAuthorized: true } : {}),
    };
    let remoteAddress = to.includes("/") ? to : undefined;
    if (to.startsWith("project:")) {
      const local = this.localPeers().filter((p) => !p.jobAgent && !p.subagent).map((p) => this.projectPeer(p)).filter((p) => p.projectAddress === to);
      const remote = this.network?.projectPeers(to) ?? [];
      const groups = new Set([...local.map((p) => `local/${p.projectGroup}`), ...remote.map((p) => `${p.host}/${p.projectGroup}`)]);
      if (groups.size > 1) throw new BridgeError("ambiguous_target", "Several projects use this address; use an exact session or host/project address.");
      if (!local.length && remote.length) remoteAddress = this.requireNetwork().projectTarget(to);
    }
    if (remoteAddress) {
      if (anchor && this.store.replyConflicts(sender.name, [to], conversationId, anchor).length) {
        throw new BridgeError("bad_request", "Stale reply refused: newer unread mail exists. Read inbox before replying.");
      }
      const result = await this.requireNetwork().send({ ...base, recipient: remoteAddress });
      for (const message of result.messages) await this.store.retryWrite(() => this.store.insert(message));
      return result;
    }
    const remoteTargets = to === BROADCAST ? this.network?.peers().filter((p) => !p.jobAgent).map((p) => p.name) ?? [] : [];
    let { live, queued, skipped } = this.resolveTargets(to, sender);
    const unreadBeforeSend = conversationId.startsWith(CONTROL_CONVERSATION_PREFIX) || isQuietMessage({ conversationId }) ? [] :
      this.store.replyConflicts(sender.name, [...live.map((c) => c.peer!.name), ...queued], conversationId);
    const checkReply = () => {
      if (!anchor) return;
      const newer = this.store.replyConflicts(sender.name, [...live.map((c) => c.peer!.name), ...queued], conversationId, anchor);
      if (newer.length) throw new BridgeError("bad_request", `Stale reply refused: ${newer.length} newer unread message(s). Read inbox before replying.`, { messageIds: newer.map((m) => m.id) });
    };
    checkReply();
    // With no available master, retain job reports under the primary without waking it.
    if (own && to === this.jobRecipient(own, question)) {
      for (let i = live.length - 1; i >= 0; i--) {
        if (live[i]!.peer?.unavailable) queued.push(live.splice(i, 1)[0]!.peer!.name);
      }
    }
    if (conversationId.startsWith(SIBLING_CONVERSATION_PREFIX) &&
        (queued.some((name) => !sender.jobAgent || !this.storedSiblings(sender, name).some((s) => s.name === name)) ||
          live.some((c) => c.peer!.jobAgent && (!sender.jobAgent || !sender.jobOwner || (!this.sameJobFamily(sender, c.peer!) && !this.sharedJobs(sender, c.peer!) && !sender.jobSendTo?.includes(c.peer!.name)))))) {
      throw new BridgeError("unauthorized", "sibling chat requires the same supervisor or an explicit send_to job grant");
    }
    let replyRestrictions = conversationId.startsWith(CONTROL_CONVERSATION_PREFIX) ? [] :
      [...live.map((c) => c.peer!.name), ...queued].flatMap((name) => {
        const restriction = this.replyRestriction(sender, name);
        return restriction ? [restriction] : [];
      });
    const envelope = (recipient: string): BridgeMessage => {
      const restriction = replyRestrictions.find((r) => r.name === recipient);
      return { ...base, recipient, body: restriction ? base.body +
        `\n\n[agent-bridge routing hint: this sender can't receive your direct reply; answer via your supervisor ${restriction.supervisor} if needed.]` : base.body };
    };
    const messages: BridgeMessage[] = [];
    let inserted = true;
    if (supervisorMail) {
      await this.store.retryWrite(() => {
        checkReply();
        const current = this.storedJobs().find((job) => `job:${job.id}` === sender.id);
        if (!current) throw new BridgeError("unauthorized", "Job ownership is unavailable.");
        this.refreshJobPeer(current);
        to = this.jobRecipient(current, question);
        ({ live, queued } = this.resolveTargets(to, sender));
        for (let i = live.length - 1; i >= 0; i--) {
          if (live[i]!.peer?.unavailable) queued.push(live.splice(i, 1)[0]!.peer!.name);
        }
        const recipient = live[0]?.peer!.name ?? queued[0]!;
        const restriction = this.replyRestriction(sender, recipient);
        replyRestrictions = restriction ? [restriction] : [];
        const message = { ...envelope(recipient), to, conversationId: this.jobConversation(current, to, base.conversationId) };
        inserted = this.store.insertJobDelivery(message);
        messages.splice(0, messages.length, message);
      });
    } else {
      for (const c of live) messages.push(envelope(c.peer!.name));
      for (const key of queued) messages.push(envelope(key));
      await this.store.retryWrite(() => this.store.insertBatch(messages, checkReply));
    }
    if (inserted) live.forEach((c, i) => this.emit(c, "message", messages[i]!));

    this.log.info("message routed", {
      id,
      from: sender.name,
      to,
      hop,
      deliveredTo: live.map((c) => c.peer!.name),
      queuedFor: queued,
    });
    const result: RequestMap["send"][1] = { messages, ...(skipped ? { skippedFor: skipped } : {}), deliveredTo: live.map((c) => c.peer!.name), queuedFor: queued, recipientStates: live.map((c) => ({ name: c.peer!.name, activity: c.peer!.activity, autoWake: c.peer!.autoWake, wakeOnDirect: c.peer!.wakeOnDirect, wakeAvailable: c.peer!.wakeAvailable, wakeMaxHops: c.peer!.wakeMaxHops })) };
    if (to.startsWith("project:") && live[0]?.peer) result.projectRoute = this.projectPeer(live[0].peer).projectRoute;
    if (replyRestrictions.length) result.replyRestrictions = replyRestrictions;
    if (unreadBeforeSend.length) result.unreadBeforeSend = unreadBeforeSend.map((m) => ({ id: m.id, from: m.from.name, conversationId: m.conversationId }));
    for (const recipient of remoteTargets) {
      // Fan out only at the originating broker. Receiving brokers deliver one local envelope.
      try {
        const remote = await this.requireNetwork().send({ ...base, recipient });
        for (const message of remote.messages) await this.store.retryWrite(() => this.store.insert(message));
        result.messages.push(...remote.messages);
        result.deliveredTo.push(...remote.deliveredTo);
        result.queuedFor.push(...remote.queuedFor);
        result.recipientStates!.push(...remote.recipientStates ?? []);
      } catch (err) {
        const message = { ...base, recipient };
        await this.store.retryWrite(() => this.store.insert(message));
        result.messages.push(message);
        (result.failedFor ??= []).push({ name: recipient, reason: (err as Error).message });
        this.log.warn("broadcast recipient delivery failed", { id, recipient, err: String(err) });
      }
    }
    result.wakeRequestedFor = (result.recipientStates ?? []).filter((peer) => {
      const message = result.messages.find((m) => m.recipient === peer.name);
      return Boolean(message && peer.wakeAvailable && (peer.autoWake || peer.wakeOnDirect &&
        (message.to === BROADCAST || message.to === peer.name || message.recipient === peer.name && !(AGENT_KINDS as readonly string[]).includes(message.to))) &&
        message.hop < (peer.wakeMaxHops ?? DEFAULT_MAX_HOPS) && !isQuietMessage(message) && !message.conversationId.endsWith(":note"));
    }).map((peer) => peer.name);
    return result;
  }

  /** A pending response is one frame, unlike streamed replay events. Bound it by bytes as well as rows. */
  private pendingMail(recipient: string, limit: number): BridgeMessage[] {
    const result: BridgeMessage[] = [];
    const unavailable = this.connByName(recipient)?.peer?.unavailable;
    let bytes = 1_024; // response envelope and separators
    for (const message of this.unreadMail(recipient, limit)) {
      // Explicit refills must not bypass the live/replay availability fence.
      // Ordinary peer and sibling mail still flow; job reports stay durable.
      if (unavailable && message.from.id.startsWith("job:") && !message.conversationId.startsWith("siblings-")) continue;
      const size = Buffer.byteLength(JSON.stringify(message)) + 1;
      if (size + 1_024 > MAX_FRAME_BYTES) {
        // AB-380: an item that can never fit must not block every item behind it. It stays stored; doctor lists it.
        this.logOversizedOnce(`skip:${message.id}`, () => this.log.error("skipping unsendable pending message; it remains stored (see doctor)", { recipient, id: message.id, bytes: size }));
        continue;
      }
      if (bytes + size > MAX_FRAME_BYTES) break;
      result.push(message);
      bytes += size;
    }
    return result;
  }

  /** Where full texts of oversized messages are kept: the bridge home, or none for an in-memory test broker. */
  private quarantineHome(): string | null {
    return this.jobsPath ? dirname(this.jobsPath) : this.store.file !== ":memory:" ? dirname(this.store.file) : null;
  }

  /** Oversized-message logs, once per id and kind per process (replay and refills see the same rows repeatedly). */
  private readonly oversizedLogged = new Set<string>();
  private logOversizedOnce(key: string, log: () => void): void {
    if (this.oversizedLogged.has(key)) return;
    if (this.oversizedLogged.size >= 10_000) this.oversizedLogged.clear();
    this.oversizedLogged.add(key);
    log();
  }

  /**
   * AB-380: a transport-safe copy; an oversized body becomes a stub (same id) naming its quarantined full text.
   * `retainedAt` names where the original is still stored; without it a stub requires a confirmed file write.
   */
  private wireMessage(message: BridgeMessage, retainedAt?: string): BridgeMessage {
    const wired = quarantineMessage(this.quarantineHome(), message, retainedAt);
    if (wired !== message) this.logOversizedOnce(`stub:${message.id}`, () => this.log.warn("oversized message quarantined; sending a stub", { id: message.id, recipient: message.recipient }));
    return wired;
  }

  private unreadMail(recipient: string, limit: number): BridgeMessage[] {
    const messages = this.store.unread(recipient, limit).map((m) => this.wireMessage(m, "the bridge database"));
    if (!this.jobsPath) return messages;
    const noteSenders = new Set(messages.filter((m) => !isQuietMessage(m) && m.conversationId.endsWith(SIBLING_NOTE_SUFFIX)).map((m) => m.from.id));
    if (!noteSenders.size) return messages;
    const finished = new Set(this.storedJobs().filter((j) => noteSenders.has(`job:${j.id}`) && j.status && j.status !== "running" &&
      (!primaryFor(j) || (!j.projectRoot && !j.deliveryHistory && !j.ownershipHistory && !this.groups.jobRoot(j, this.localPeers())))).map((j) => `job:${j.id}`));
    // Preserve the established retirement of old job status notes. Observer copies and quiet
    // acknowledgements remain available on demand even after the originating job finishes.
    const obsolete = messages.filter((m) => !isQuietMessage(m) && m.conversationId.endsWith(SIBLING_NOTE_SUFFIX) && finished.has(m.from.id));
    this.store.markRead(recipient, obsolete.map((m) => m.id), this.now());
    return messages.filter((m) => !obsolete.includes(m));
  }

  private remoteReceipt(id: string, sender: string, recipient?: string): number | null {
    const message = this.store.byId(id);
    const current = this.network?.peers().find((p) => p.id === sender);
    const sameSender = message && (message.from.id === sender || sender.includes("/") &&
      message.from.id.split("/")[0] === sender.split("/")[0] && current?.name === message.from.name && current.agent === message.from.agent);
    if (!message || !sameSender) throw new BridgeError("unauthorized", "receipt is only available to the sender");
    const receipts = this.store.receipts(id);
    const receipt = recipient ? receipts.find((r) => r.recipient === recipient) : receipts[0];
    // A queued direct envelope may have moved from a retained alias to the reclaimed name.
    const addressedAlias = recipient && message.to !== BROADCAST && message.to.split("/").at(-1) === recipient;
    return (receipt ?? (addressedAlias ? receipts.find((r) => r.recipient === message.recipient) : undefined))?.readAt ?? null;
  }

  private async messageReceipt(conn: Conn, id: string) {
    const sender = this.requirePeer(conn);
    const message = this.store.byId(z.uuid().parse(id));
    if (!message || message.from.name !== sender.name) throw new BridgeError("unauthorized", "receipt is only available to the sender");
    const receipts = this.store.receipts(id);
    return Promise.all(receipts.map(async (r) => r.recipient.includes("/") && !isNativeChildAddress(r.recipient)
      ? { ...r, readAt: await this.requireNetwork().receipt(r.recipient, id, message.from.id,
        receipts.filter((other) => other.recipient.startsWith(`${r.recipient.split("/")[0]}/`)).length > 1) }
      : r));
  }

  private requireNetwork(): NetworkService {
    if (!this.network) throw new BridgeError("bad_request", "networking is disabled or unavailable; enable it and restart the broker");
    return this.network;
  }

  private async onSendFiles(conn: Conn, args: RequestMap["sendFiles"][0]): Promise<TransferResult | TransferStarted> {
    const sender = this.requirePeer(conn);
    const parsed = z.object({ to: z.string().min(1).max(MAX_FILE_ADDRESS_CHARS), paths: z.array(z.string().min(1).max(MAX_FILE_PATH_CHARS)).min(1).max(MAX_STREAM_ENTRIES) }).parse(args);
    const remote = parsed.to.includes("/");
    if (remote) return this.requireNetwork().startFiles(parsed.to, parsed.paths, sender.cwd, { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent });
    const target = parsed.to;
    const transfer = collectTransfer(parsed.paths, sender.cwd, target, { id: sender.id, name: sender.name, agent: sender.jobAgent ?? sender.agent });
    if (!this.connByName(target)) throw new BridgeError("unknown_target", "file recipient must be online");
    const home = this.networking?.home;
    if (!home) throw new BridgeError("bad_request", "file inbox home is unavailable");
    const result = receiveTransfer(home, transfer);
    this.receiveRemote({ id: transfer.id, from: transfer.from, to: target, recipient: target, conversationId: transfer.id, replyTo: null, hop: 0, body: `Received ${result.files} files (${result.bytes} bytes) in ${result.inbox}`, createdAt: this.now(), readAt: null });
    return result;
  }

  private receiveRemote(message: BridgeMessage): { delivered: boolean; recipient: string; stored: boolean; recovered?: boolean; readAt: number | null } {
    if (isNativeChildAddress(message.recipient) || isNativeChildAddress(message.to) || isNativeChildAddress(message.from.name)) throw new BridgeError("unauthorized", "Native child addresses are local scoped queues; paired-PC delivery is not authorized.");
    message = { ...message, jobControlAuthorized: undefined };
    const target = this.recipientConn(message.recipient);
    if (target?.peer) message = { ...message, recipient: target.peer.name };
    const existing = this.store.byId(message.id);
    if (existing) {
      const broadcastCopy = existing.to === BROADCAST && message.to === BROADCAST;
      // A reloaded sending session has a new process id, but retains its authenticated paired
      // origin and stable name. Those identities and the full content must still match.
      const sameSender = existing.from.id === message.from.id || message.from.id.includes("/") &&
        existing.from.id.split("/")[0] === message.from.id.split("/")[0] && existing.from.name === message.from.name;
      const projectRetry = message.to.startsWith("project:") || /^[^/]+\/project:/.test(message.to);
      const sameRecipient = existing.recipient === message.recipient || projectRetry || !broadcastCopy && target?.peer && this.recipientConn(existing.recipient) === target;
      if (!sameSender || existing.from.name !== message.from.name || existing.from.agent !== message.from.agent || (!broadcastCopy && !sameRecipient) || existing.to !== message.to || existing.body !== message.body || existing.conversationId !== message.conversationId || existing.replyTo !== message.replyTo || existing.hop !== message.hop) throw new BridgeError("bad_request", "Message id already stored with different content; use a new id for a new message.");
      const receipt = this.store.receipts(message.id).find((r) => (!broadcastCopy && r.recipient === existing.recipient) || r.recipient === message.recipient);
      if (receipt) return { delivered: Boolean(this.recipientConn(receipt.recipient)), recipient: receipt.recipient, stored: true, recovered: true, readAt: receipt.readAt };
    }
    this.store.insert(message);
    if (target) this.emit(target, "message", message);
    return { delivered: Boolean(target), recipient: message.recipient, stored: true, readAt: null };
  }
}
