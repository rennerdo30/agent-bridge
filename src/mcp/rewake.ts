import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { BridgeConfig } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import { AGENT_KINDS, BROADCAST, isQuietMessage, type BridgeMessage } from "../core/protocol.js";
import { tokensEqual } from "../core/token.js";
import { escapeAttr, formatMessage, formatMessages } from "./format.js";
import { selectForDelivery, unshownMessageNotes } from "./output-bounds.js";
import type { ClaudeMailScopes } from "./claude-mail-scope.js";
import type { T3SendOutcome } from "../core/t3-chat.js";

/**
 * AB-481: inside a T3 Code chat, Stop-hook and mod wake-ups start turns T3 does not show, so the user never sees
 * the message that woke the agent. With this, an idle session's wake-up goes into its T3 chat as a visible chat
 * message instead (through T3's own CLI); T3 starts the turn and keeps the message in the chat's history.
 */
export interface T3Delivery {
  /** The T3 chat this Claude session runs in, or undefined. */
  chat(sessionId: string): string | undefined;
  /** The signal aborts a pending send when the endpoint stops. */
  send(threadId: string, text: string, signal: AbortSignal): Promise<T3SendOutcome>;
}
/** Messages arriving together go out as one chat message. */
const T3_COALESCE_MS = 1_500;
/** A T3 delivery whose prompt did not show up within this much idle time: T3 delivery stops and the mod or hooks take over. */
export const T3_TURN_CONFIRM_MS = 20_000;
/** A session whose chat was not found is looked up again at most this often. */
const T3_LOOKUP_RETRY_MS = 60_000;
/** Abort reason that tells a waiting Stop hook to wake the session: T3 delivery handed its messages back. */
const T3_FALLBACK = "t3-fallback";

/**
 * Wake an idle Claude Code session when something it is waiting for arrives: a background subagent's
 * result, a reply to a question it asked, a direct session message, or (with auto-wake) any peer message.
 *
 * Claude Code's `asyncRewake` Stop hook (`agent-bridge rewake-hook`) runs in the background after a turn
 * ends and long-polls this endpoint. When it returns messages, the hook prints them and exits 2, which
 * wakes the session with them. So the turn never has to stay open waiting.
 */
export const SESSIONS_DIR = "sessions";
/** How a wake-up's text starts; the prompt hook recognizes its own wake-up turn by it. */
export const WAKE_HEADER = "[agent-bridge] New actionable message(s) arrived:";
const HOST = "127.0.0.1";
const SECRET_BYTES = 24;
/** One long poll; the hook polls again until its own timeout. */
export const REWAKE_POLL_MS = 4 * 60 * 1000; // below fetch's 5-minute response-headers timeout
/** No session activity this long after a wake-up: Claude Code did not take it, retry through the standby hook. */
export const WAKE_CONFIRM_MS = 20_000;
/** The standby waits this long before taking a message, so a starting turn's own hook gets it first. */
const STANDBY_GRACE_MS = 3_000;
/** How often the mod's wait re-checks whether the session went idle (messages themselves end it at once). */
const MOD_TICK_MS = 2_000;
/**
 * Turn ends after which a mod hand-out that was neither shown nor acknowledged goes back to the hooks (AB-396).
 * A live mod polls after every turn end and either submits or acknowledges what it is handed, so the hand-out
 * is refreshed or confirmed long before this. Two, because the queued wake turn itself may end before its
 * prompt hook confirmed it. Only a mod that stopped polling lets a hand-out age out; it is then a repeat.
 */
const MOD_HANDOUT_TURNS = 2;
/** Remembered ids of messages that may have been shown before (bounded). */
const MAX_REPEATS = 500;

/** Ids of the agent-bridge messages in a wake-up text (or a prompt that carries one). */
export function wakeMessageIds(text: string): string[] {
  return [...text.matchAll(/<agent-bridge-message id="([^"]+)"/g)].map((m) => m[1]!);
}

/**
 * AB-404: a wake-up's note for a message too large to show carries its id in this tag, so the wake-up's own prompt
 * confirms the note. It never matches `<agent-bridge-message id=`: a note never marks its message read.
 */
export function oversizedNoteMarker(id: string): string {
  // Ids from paired links are not format-checked: escaped, a crafted id cannot carry another note's marker.
  return `<agent-bridge-oversized id="${escapeAttr(id)}"/>`;
}
/** Ids of the oversized-message notes in a wake-up text (or a prompt that carries one). */
export function wakeNoteIds(text: string): string[] {
  return [...text.matchAll(/<agent-bridge-oversized id="([^"]+)"\/>/g)].map((m) => m[1]!);
}

/** AB-404: messages already listed by id as too large for one result (shared with the hooks and inbox tools). */
export interface OversizedMessages {
  noted(id: string): boolean;
  note(ids: readonly string[]): void;
}

export interface RewakeRegistration {
  port: number;
  secret: string;
  pid: number;
}

export function sessionFile(home: string, sessionId: string): string {
  return join(home, SESSIONS_DIR, `${sessionId.replace(/[^\w-]/g, "_")}.json`);
}

/** Remote envelopes preserve host/name in to; recipient is the receiving PC's local name. */
export function shouldWakeClaudeMessage(node: BridgeNode, cfg: BridgeConfig, m: BridgeMessage): boolean {
  if (m.hop >= cfg.maxHops || isQuietMessage(m) || m.conversationId.endsWith(":note")) return false;
  const direct = m.to === node.name ||
    (m.recipient === node.name && m.to !== BROADCAST && !(AGENT_KINDS as readonly string[]).includes(m.to)) ||
    (m.from.id.includes("/") && m.to.slice(m.to.indexOf("/") + 1) === node.name);
  return node.autoWakeEnabled || node.isNotificationAwaited(m) || (direct && (m.from.id.startsWith("job:") || node.isAwaitedReply(m))) ||
    ((direct || m.to === BROADCAST) && cfg.wakeOnDirect);
}

export class RewakeEndpoint {
  private server: Server | null = null;
  private readonly secret = randomBytes(SECRET_BYTES).toString("hex");
  private port = 0;
  private registered: string | null = null;
  /** Only the newest waiter gets messages; an older one (from an earlier turn) is released empty. */
  private waiter: AbortController | null = null;
  /** Messages handed to a Stop-hook wake-up that the session has not shown activity for yet. */
  private readonly handedOut = new Set<string>();
  /**
   * Messages handed to the mod, with the turn-end count at hand-out. The mod submits them as a prompt, which
   * Claude Code queues behind a turn that starts meanwhile: they are on their way to their own turn, so the
   * hooks must not show them too (AB-396). Read when that prompt's hook runs or the mod acknowledges them.
   */
  private readonly modHandedOut = new Map<string, number>();
  /**
   * AB-404: oversized-message notes handed to a Stop-hook wake-up. A note counts as shown (OversizedMessages.note)
   * only when the wake-up is confirmed like its messages; a lost wake-up's notes are listed again.
   */
  private readonly handedNotes = new Set<string>();
  /** AB-404: notes handed to the mod, with the turn-end and turn-start counts at hand-out (see modNoteInFlight). */
  private readonly modNotes = new Map<string, { ends: number; starts: number }>();
  /**
   * AB-404: notes taken back at an acknowledgement although the mod may have submitted them: a mod of v0.30.12 or
   * older acknowledges at its own turn start, before that prompt's hook. Their prompt still confirms them; they are
   * not in flight, and the mod's next poll hands them out again (and forgets them here).
   */
  private readonly ackedNotes = new Set<string>();
  /** Main turns that ended (busy to idle); ages the hand-outs of a mod that stopped polling. */
  private turnEnds = 0;
  /** Main turns that started (idle to busy): a mod note whose re-poll saw no turn start was not taken. */
  private turnStarts = 0;
  /** Messages whose earlier hand-out may have reached the model: a later copy is marked as a repeat. */
  private readonly repeats = new Set<string>();
  /** The second hook of a turn end, waiting to retry a wake-up that did not start a turn. */
  private standby: { ac: AbortController; release: (reason: string) => void; wake: () => void } | null = null;
  private confirmTimer: NodeJS.Timeout | undefined;
  /**
   * The agent-bridge mod (Claude Code 2.1.287+, plugins/claude/hooks/wake.ts) wakes the session itself with
   * $.prompt.submit, a real turn: once it has shown up, the Stop hooks step aside and leave waking to it.
   */
  private modWaiter: AbortController | null = null;
  /** The bridge gave this session to another server of it: this endpoint stays quiet (see retire). */
  private retired = false;
  private modSeen = false;
  /** A turn is running (from the hooks and the mod): the mod waits until the session is idle. */
  private busy = false;
  /** AB-481: the T3 chat of this session, once found. */
  private t3Thread: string | undefined;
  private t3LookedUpAt = 0;
  /** T3 delivery failed or started no turn: the mod and the Stop hooks wake this session again. */
  private t3Off = false;
  /**
   * The one T3 delivery in progress. Its messages and notes belong to it alone (not to the mod's hand-outs): no other
   * hand-out takes them and no mod acknowledgement confirms them; only that delivery's own prompt does (confirmPrompt).
   */
  private t3Pending: { ids: Set<string>; notes: Set<string>; abort: AbortController } | null = null;
  /** Every CLI send still running, also after its prompt settled the delivery: stop() ends them all. */
  private readonly t3Sends = new Set<AbortController>();
  private t3Timer: NodeJS.Timeout | undefined;
  private t3ConfirmTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly onT3Message = () => this.scheduleT3();

  constructor(
    private readonly home: string,
    private readonly node: BridgeNode,
    /** Messages that should wake the session. */
    private readonly shouldWake: (m: BridgeMessage) => boolean,
    private readonly log: Logger,
    private readonly activity?: (event: import("./hook-ownership.js").ModActivity) => boolean,
    private readonly mailScopes?: ClaudeMailScopes,
    private readonly oversized?: OversizedMessages,
    /** How long the standby waits before taking a message (tests shorten it). */
    private readonly standbyGraceMs = STANDBY_GRACE_MS,
    /** AB-481: set in a T3 Code chat with T3's CLI available. */
    private readonly t3?: T3Delivery,
    /** How long a T3 delivery may take to start a turn (tests shorten it). */
    private readonly t3ConfirmMs = T3_TURN_CONFIRM_MS,
  ) {}

  /** T3 delivers this session's wake-ups: its T3 chat is known and delivery has not failed. */
  get t3Active(): boolean {
    return Boolean(this.t3) && !this.t3Off && !this.retired && !this.stopped && this.t3Chat() !== undefined;
  }

  /**
   * A message a wake-up may carry: it should wake the session, and it is not an oversized message whose note was
   * shown (AB-404) or is on its way to its own mod turn.
   */
  private readonly deliverable = (m: BridgeMessage): boolean =>
    this.shouldWake(m) && !this.oversized?.noted(m.id) && !this.modNoteInFlight(m.id) && !this.t3Pending?.ids.has(m.id) && !this.t3Pending?.notes.has(m.id);
  /** A message a Stop-hook waiter may wake for: not while T3 delivers this session's wake-ups (AB-481). */
  private readonly hookWakeable = (m: BridgeMessage): boolean => this.wakeable(m) && !this.t3Active;
  /** A message that should start a wake-up: deliverable, and not a note this endpoint handed out and awaits (AB-404). */
  private readonly wakeable = (m: BridgeMessage): boolean => this.deliverable(m) && !this.handedNotes.has(m.id);

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${HOST}`);
      if (url.pathname === "/mail-scope" && tokensEqual(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), this.secret)) {
        const session = url.searchParams.get("session_id");
        if (req.method !== "POST" || this.retired || !this.mailScopes || !session || session !== this.registered || session !== this.node.currentSessionId) {
          res.writeHead(409).end(); return;
        }
        res.setHeader("cache-control", "no-store");
        try {
          const token = this.mailScopes.issue(url.searchParams.get("tool") ?? "", session, url.searchParams.get("agent_id") ?? undefined);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token }));
        } catch { res.writeHead(403).end(); }
        return;
      }
      if (url.pathname === "/activity" && tokensEqual(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), this.secret)) {
        const accepted = !this.retired && this.activity?.({ sessionId: url.searchParams.get("session_id") ?? "", turnId: url.searchParams.get("turn_id") ?? "", sequence: Number(url.searchParams.get("sequence")), busy: url.searchParams.get("busy") === "1", instance: url.searchParams.get("instance") ?? undefined });
        if (accepted) this.modSeen = true;
        res.writeHead(accepted ? 204 : 409).end();
        return;
      }
      if (url.pathname === "/mod" && tokensEqual(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), this.secret)) {
        // The mod reports turns starting and ending.
        this.modSeen = true;
        const busy = url.searchParams.get("busy") === "1";
        // The mod acknowledges a hand-out it submitted before (older mods: a turn started after its submission):
        // it is in Claude Code's prompt queue or was shown. Confirmed here, where it was handed out, so it is
        // never handed out again, even when the session's hooks reach another server of it.
        if (busy) { this.confirmDelivery(); this.confirmMod([...this.modHandedOut.keys()]); this.acknowledgeNotes(); }
        this.setBusy(busy);
        res.writeHead(204).end();
        return;
      }
      if (url.pathname !== "/wait" || !tokensEqual(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), this.secret)) {
        res.writeHead(403).end();
        return;
      }
      // Another server of this session took over: nothing is handed out here (it would be handed out twice).
      if (this.retired) this.reply(res, "", true);
      else if (url.searchParams.get("role") === "mod") this.waitMod(res);
      // With the mod, the turn-end hooks end at once: the mod does the waking. With T3 delivery they keep
      // waiting without waking (hookWakeable), as the fallback should T3 delivery stop (AB-481).
      else if (this.modSeen) this.reply(res, "", true);
      else if (url.searchParams.get("role") === "standby") this.waitStandby(res);
      else this.waitPrimary(res);
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, HOST, () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    if (this.t3) this.node.on("message", this.onT3Message);
  }

  private reply(res: ServerResponse, text: string, superseded: boolean): void {
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "application/json" });
    // superseded: a newer turn's hook waits now, so this one should end quietly.
    res.end(JSON.stringify({ text, superseded }));
  }

  /**
   * Hand the waiting messages to a wake-up; they stay unread until the session shows activity. AB-404: the
   * wake-up text is bounded like a hook result. Only messages shown in full are handed out; one too large to
   * show is listed by id once (it stays unread and inbox pages it), and the rest wait for the next wake-up.
   */
  private handOut(toMod: boolean | "t3" = false): string {
    const render = (shown: BridgeMessage[], oversized: BridgeMessage[], deferred: BridgeMessage[]) => [
      shown.length ? formatMessages(shown, { header: WAKE_HEADER, repeat: (m) => this.repeated(m.id) }) : WAKE_HEADER,
      ...unshownMessageNotes(oversized, deferred.length, (id) => `inbox(id="${id}", offset=0)`)
        .map((note, i) => i < oversized.length ? `${oversizedNoteMarker(oversized[i]!.id)} ${note}` : note),
    ].join("\n\n");
    // A retry carries the notes of the wake-up it repeats: they were never confirmed.
    const { shown, oversized, deferred } = selectForDelivery(this.node.unread().filter(this.deliverable), render, formatMessage);
    // Not marked read yet: Claude Code does not always turn a hook's wake-up into a turn. They count as
    // delivered once the session shows activity (confirmDelivery) or, for the mod, once their own prompt
    // runs or the mod acknowledges them; until then a retry or the next poll still gets them. A note for an
    // oversized message is confirmed the same way, and only then is it not listed again (AB-404).
    // A T3 delivery records its own hand-out (flushT3).
    if (toMod !== "t3") {
      for (const m of shown) {
        if (toMod) this.modHandedOut.set(m.id, this.turnEnds);
        else this.handedOut.add(m.id);
      }
      for (const m of oversized) {
        if (toMod) this.modNotes.set(m.id, { ends: this.turnEnds, starts: this.turnStarts });
        else this.handedNotes.add(m.id);
      }
    }
    return shown.length || oversized.length ? render(shown, oversized, deferred) : "";
  }

  /** The turn-end hook: wakes the session for the next message that should wake it. */
  private waitPrimary(res: ServerResponse): void {
    // A new waiter means a turn ended since the last wake-up, so that wake-up was delivered.
    this.confirmDelivery();
    this.waiter?.abort("superseded");
    const ac = new AbortController();
    this.waiter = ac;
    res.on("close", () => ac.abort("closed"));
    void this.node.waitForMessage(REWAKE_POLL_MS, this.hookWakeable, ac.signal).then((first) => {
      if (this.waiter === ac) this.waiter = null;
      let text = "";
      // AB-481: T3 delivery stopped while this hook waited; it wakes the session with the messages it handed back.
      if ((first || ac.signal.reason === T3_FALLBACK) && !res.destroyed) {
        text = this.handOut();
        this.log.info("waking the session", { count: this.handedOut.size });
        // If no activity follows, Claude Code dropped the wake-up: the standby hook tries again.
        clearTimeout(this.confirmTimer);
        this.confirmTimer = setTimeout(() => this.retryWake(), WAKE_CONFIRM_MS);
        this.confirmTimer.unref();
      }
      this.reply(res, text, ac.signal.reason === "superseded");
    });
  }

  /**
   * A second hook from the same turn end. It wakes the session when the first one's wake-up was not taken
   * (retryWake), or when a message arrives while nothing else waits (the first one already woke the session
   * once and Claude Code did not start a turn). Released as soon as the session is active again.
   */
  private waitStandby(res: ServerResponse): void {
    this.standby?.release("superseded");
    const ac = new AbortController();
    let done = false;
    const finish = (text: string, superseded: boolean) => {
      if (done) return;
      done = true;
      ac.abort("done");
      if (this.standby?.ac === ac) this.standby = null;
      this.reply(res, text, superseded);
    };
    // Released (a newer turn end, or the session is active again): the hook ends instead of polling on.
    this.standby = { ac, release: () => finish("", true), wake: () => finish(this.handOut(), false) };
    res.on("close", () => finish("", false));
    // A message nobody else waits for: take it (after a short grace, in case a new turn's hook is starting).
    const loop = () =>
      void this.node
        // Not while a wake-up is unconfirmed: that one is retried (retryWake), and handing out again here would
        // repeat its messages without marking them as repeats (a deferred message would re-select them).
        .waitForMessage(REWAKE_POLL_MS, (m) => this.hookWakeable(m) && !this.pendingWake() && !this.waiter, ac.signal)
        .then((m) => {
          if (done) return;
          if (!m) return finish("", false);
          setTimeout(() => {
            if (done) return;
            if (this.waiter || this.pendingWake()) return loop();
            this.log.info("waking the session (standby)", { reason: "no other hook waiting" });
            this.standby?.wake();
          }, this.standbyGraceMs).unref();
        });
    loop();
  }

  /**
   * The mod's long poll, while the session is idle: answers with the messages that should wake it. Messages
   * handed out before but not yet confirmed are handed out again (the mod polls again when its wake-up did
   * not start a turn).
   */
  private waitMod(res: ServerResponse): void {
    this.modSeen = true;
    // AB-404: a Stop-hook wake-up's notes are not confirmed by the mod's turns, and wakeable() would keep them from
    // the mod: they go back to the hand-outs (at worst one duplicate note). Stop-hook wake-ups end once the mod polls.
    this.handedNotes.clear();
    this.ackedNotes.clear();
    // The mod polls again while idle: when no turn started since a note was handed to it, that wake-up started
    // no turn, so the note goes out again (AB-404). After a turn start it is queued and waits for its own prompt.
    for (const [id, at] of this.modNotes) if (at.starts === this.turnStarts) this.modNotes.delete(id);
    this.modWaiter?.abort("superseded");
    const ac = new AbortController();
    this.modWaiter = ac;
    res.on("close", () => ac.abort("closed"));
    const deadline = Date.now() + REWAKE_POLL_MS;
    void (async () => {
      while (!ac.signal.aborted && Date.now() < deadline) {
        const waiting = this.node.unread().some(this.wakeable);
        // AB-481: T3 delivery wakes this session; the mod stays the fallback should it stop.
        if (waiting && !this.busy && !this.t3Active) break;
        // Busy with a message already waiting: check again shortly (waitForMessage would return it at once).
        if (waiting) await new Promise<void>((r) => setTimeout(r, MOD_TICK_MS).unref());
        else await this.node.waitForMessage(MOD_TICK_MS, this.wakeable, ac.signal);
      }
      if (this.modWaiter === ac) this.modWaiter = null;
      if (ac.signal.aborted || Date.now() >= deadline || res.destroyed) return this.reply(res, "", ac.signal.reason === "superseded");
      const text = this.handOut(true);
      this.log.info("waking the session (mod)", { count: this.modHandedOut.size });
      this.reply(res, text, false);
    })();
  }

  private setBusy(busy: boolean): void {
    if (busy && !this.busy) this.turnStarts++;
    this.busy = busy;
    // A turn started: a message now goes out with the tool hooks, not as a wake-up queued behind the turn.
    if (busy) this.modWaiter?.abort("superseded");
  }

  /** Whether the mod wakes this session (the Stop hook then leaves messages to it instead of blocking). */
  get modActive(): boolean {
    return this.modSeen || this.t3Active;
  }

  /** A turn ended (the Stop hook ran). */
  sessionIdle(): void {
    if (this.busy) this.turnEnds++;
    this.setBusy(false);
    // A pending T3 delivery's window starts over: only a full idle window without its prompt counts.
    if (this.t3Pending && this.t3ConfirmTimer) this.armT3Confirm(this.t3Pending);
    this.scheduleT3();
  }

  private scheduleT3(): void {
    if (!this.t3 || this.t3Off || this.t3Timer) return;
    this.t3Timer = setTimeout(() => { this.t3Timer = undefined; void this.flushT3(); }, T3_COALESCE_MS);
    this.t3Timer.unref();
  }

  /** The session's T3 chat; while unknown, looked up again at most once a minute. */
  private t3Chat(): string | undefined {
    if (this.t3Thread || !this.t3 || !this.registered) return this.t3Thread;
    if (this.t3LookedUpAt && Date.now() - this.t3LookedUpAt < T3_LOOKUP_RETRY_MS) return undefined;
    this.t3LookedUpAt = Date.now();
    try { this.t3Thread = this.t3.chat(this.registered); } catch { this.t3Thread = undefined; }
    if (this.t3Thread) this.log.info("T3 chat found; wake-ups go into it as chat messages", { thread: this.t3Thread });
    return this.t3Thread;
  }

  /**
   * AB-481: an idle session's waiting messages go into its T3 chat as one chat message. The delivery owns them until
   * its own prompt shows them (confirmPrompt): no hook injects them, no other wake-up takes them, nothing re-sends them.
   */
  private async flushT3(): Promise<void> {
    if (!this.t3 || this.t3Off || this.retired || this.stopped || this.busy || this.t3Pending) return;
    const thread = this.t3Chat();
    if (!thread || !this.node.unread().some(this.wakeable)) return;
    const text = this.handOut("t3");
    if (!text) return;
    const pending = { ids: new Set(wakeMessageIds(text)), notes: new Set(wakeNoteIds(text)), abort: new AbortController() };
    this.t3Pending = pending;
    this.t3Sends.add(pending.abort);
    let outcome: T3SendOutcome;
    try { outcome = await this.t3.send(thread, text, pending.abort.signal); }
    catch (error) { outcome = { state: "unknown", reason: String(error) }; }
    finally { this.t3Sends.delete(pending.abort); }
    // Stopped meanwhile, or the delivery was already settled: nothing more to do here.
    if (this.stopped || this.t3Pending !== pending) return;
    if (outcome.state === "failed") {
      // Never reached T3: the messages go straight back to the mod and the hooks.
      this.log.warn("T3 delivery refused; wake-ups go back to the mod and hooks", { reason: outcome.reason });
      this.takeBackT3(pending, false);
      return;
    }
    this.log.info(outcome.state === "accepted" ? "wake-up sent into the T3 chat" : "T3 delivery outcome unknown; not retried",
      { count: pending.ids.size, ...(outcome.state === "accepted" ? { delivery: outcome.delivery, runId: outcome.runId } : { reason: outcome.reason }) });
    this.armT3Confirm(pending);
  }

  /**
   * The delivery's prompt should show up soon. T3 queues it behind a running turn, so busy time does not count:
   * only a session that stayed idle for the whole window without that prompt gets its messages back (as repeats).
   */
  private armT3Confirm(pending: NonNullable<RewakeEndpoint["t3Pending"]>): void {
    clearTimeout(this.t3ConfirmTimer);
    this.t3ConfirmTimer = setTimeout(() => {
      this.t3ConfirmTimer = undefined;
      if (this.t3Pending !== pending || this.stopped) return;
      if (this.busy) { this.armT3Confirm(pending); return; }
      this.log.warn("a T3 delivery's prompt never showed up; wake-ups go back to the mod and hooks", { count: pending.ids.size });
      this.takeBackT3(pending, true);
    }, this.t3ConfirmMs);
    this.t3ConfirmTimer.unref();
  }

  /** The delivery's prompt showed its messages: the next waiting mail may go out. */
  private settleT3(pending: NonNullable<RewakeEndpoint["t3Pending"]>): void {
    if (this.t3Pending !== pending || pending.ids.size || pending.notes.size) return;
    clearTimeout(this.t3ConfirmTimer);
    this.t3ConfirmTimer = undefined;
    this.t3Pending = null;
    this.scheduleT3();
  }

  /** T3 delivery stops for this session; its messages return (as repeats, if T3 may have shown them) and a fallback wakes it. */
  private takeBackT3(pending: NonNullable<RewakeEndpoint["t3Pending"]>, maybeShown: boolean): void {
    this.t3Off = true;
    if (this.t3Pending === pending) this.t3Pending = null;
    clearTimeout(this.t3ConfirmTimer);
    this.t3ConfirmTimer = undefined;
    if (maybeShown) this.markRepeat(pending.ids);
    // The mod re-checks within MOD_TICK_MS by itself; a waiting Stop hook is woken now.
    if (this.modSeen) return;
    if (this.waiter) this.waiter.abort(T3_FALLBACK);
    else if (this.standby) this.standby.wake();
    else this.log.warn("no wake-up hook waits; the returned messages go out with the next turn", { count: pending.ids.size });
  }

  /** Read mod hand-outs: shown in their own turn or acknowledged by the mod. */
  private confirmMod(ids: string[]): void {
    const shown = ids.filter((id) => this.modHandedOut.delete(id));
    if (shown.length) this.node.markRead(shown);
  }

  /**
   * AB-404: the mod acknowledged a hand-out (its message ids were all submitted before), so it did not submit this
   * text. A note in it counts as shown only when its hand-out came before a real turn start: an earlier hand-out the
   * mod submitted, queued behind that turn. A note handed out since (no turn started) was in the acknowledged text
   * only, so it is not confirmed but handed out again on the mod's re-poll, as a note-only wake-up it submits.
   */
  private acknowledgeNotes(): void {
    const queued: string[] = [];
    for (const [id, at] of this.modNotes) {
      if (at.starts < this.turnStarts) queued.push(id);
      else { this.modNotes.delete(id); this.ackedNotes.add(id); }
    }
    this.confirmNotes(queued);
  }

  /** AB-404: these oversized-message notes were shown; the messages themselves stay unread. */
  private confirmNotes(ids: Iterable<string>): void {
    const noted = [...ids];
    for (const id of noted) { this.handedNotes.delete(id); this.modNotes.delete(id); this.ackedNotes.delete(id); }
    if (noted.length) this.oversized?.note(noted);
  }

  /** Whether a Stop-hook wake-up (messages or notes) waits for its confirmation. */
  private pendingWake(): boolean {
    return this.handedOut.size > 0 || this.handedNotes.size > 0;
  }

  /**
   * A note handed to the mod is on its way to its own wake turn. One that outlived MOD_HANDOUT_TURNS turn ends goes
   * back to the hooks and wake-ups, like a mod hand-out (AB-396).
   */
  private modNoteInFlight(id: string): boolean {
    const at = this.modNotes.get(id);
    if (at === undefined) return false;
    if (this.turnEnds - at.ends < MOD_HANDOUT_TURNS) return true;
    this.modNotes.delete(id);
    this.log.warn("a mod wake-up's note for an oversized message was not shown; it is listed again", { id });
    return false;
  }

  /**
   * A message on its way to its own wake turn: the mod gave it to Claude Code as a prompt, so a hook must not
   * inject it as well (AB-396). A hand-out that outlived MOD_HANDOUT_TURNS turn ends without the mod taking it
   * again goes back to the hooks, as a repeat.
   */
  inFlight(id: string): boolean {
    if (this.t3Pending?.ids.has(id) || this.t3Pending?.notes.has(id)) return true;
    if (this.modNoteInFlight(id)) return true;
    const at = this.modHandedOut.get(id);
    if (at === undefined) return false;
    if (this.turnEnds - at < MOD_HANDOUT_TURNS) return true;
    this.modHandedOut.delete(id);
    this.markRepeat([id]);
    this.log.warn("a mod wake-up was neither shown nor acknowledged; the hooks deliver it as a repeat", { id });
    return false;
  }

  /** A turn's prompt: a wake-up's own prompt shows its messages, wherever they were handed out. */
  confirmPrompt(prompt: string): void {
    if (!prompt.includes(WAKE_HEADER)) return;
    // AB-404: only notes this endpoint handed out and awaits; a marker for any other id is not one of its notes.
    const pending = this.t3Pending;
    const shownNotes = [...new Set([...this.handedNotes, ...this.modNotes.keys(), ...this.ackedNotes, ...(pending?.notes ?? [])])].filter((id) => prompt.includes(oversizedNoteMarker(id)));
    for (const id of shownNotes) pending?.notes.delete(id);
    this.confirmNotes(shownNotes);
    const ids = new Set(wakeMessageIds(prompt));
    for (const id of ids) { this.handedOut.delete(id); this.modHandedOut.delete(id); pending?.ids.delete(id); }
    if (pending) this.settleT3(pending);
    if (!ids.size) return;
    const shown = this.node.unread().filter((m) => ids.has(m.id)).map((m) => m.id);
    if (shown.length) this.node.markRead(shown);
  }

  /** These messages may already have reached the model; a later copy says so. */
  markRepeat(ids: Iterable<string>): void {
    for (const id of ids) {
      this.repeats.delete(id);
      this.repeats.add(id);
    }
    while (this.repeats.size > MAX_REPEATS) this.repeats.delete(this.repeats.values().next().value!);
  }

  /** Whether a copy of this message repeats an earlier hand-out. */
  repeated(id: string): boolean {
    return this.repeats.has(id);
  }

  /** The first wake-up was not confirmed: give the same messages to the standby hook. */
  private retryWake(): void {
    if (!this.pendingWake()) return;
    // The mod polls again by itself when its wake-up started no turn, and gets the same messages. AB-404: the notes
    // go to it too; kept here they would be kept from its hand-outs and confirmed by its turns unshown.
    if (this.modSeen) { this.handedNotes.clear(); return; }
    if (!this.standby) {
      this.log.warn("a wake-up was not taken and no standby hook waits; the messages go out with the next prompt", { count: this.handedOut.size });
      return;
    }
    this.log.warn("a wake-up was not taken; trying again through the standby hook", { count: this.handedOut.size });
    this.standby.wake();
  }
  /**
   * The session is active (a hook of it ran, or a new waiter started after a turn): the messages of the
   * last Stop-hook wake-up reached it. Called before hooks inject unread mail, so they are not shown twice.
   * Mod hand-outs are not confirmed by unrelated activity: the mod drops a hand-out when a turn started first,
   * and only their own prompt (confirmPrompt) or the mod's acknowledgement (/mod) proves delivery.
   */
  confirmDelivery(): void {
    clearTimeout(this.confirmTimer);
    this.confirmNotes(this.handedNotes);
    if (this.handedOut.size === 0) return;
    this.node.markRead([...this.handedOut]);
    this.handedOut.clear();
  }

  /**
   * A turn is running (tool calls, a prompt): the hooks of the previous turn end are not needed anymore.
   * The primary one must go too: a message it took mid-turn would become a wake-up Claude Code does not start
   * while busy, and the next tool call would count it as delivered. Mid-turn messages go out with the tool
   * hooks instead, and the next turn end starts a fresh waiter.
   */
  sessionActive(): void {
    this.setBusy(true);
    this.waiter?.abort("superseded");
    this.standby?.release("active");
  }

  /**
   * The Stop-hook wake-up looks lost (a new prompt came first): its messages go out with that prompt instead,
   * marked as repeats because Claude Code may still start the wake-up's turn. Mod hand-outs are not lost: the
   * mod's prompt is queued behind this one and shows them in its own turn.
   */
  releaseUndelivered(): void {
    if (this.handedOut.size) this.log.warn("a wake-up did not reach the session; delivering its messages with the next prompt", { count: this.handedOut.size });
    this.markRepeat(this.handedOut);
    this.handedOut.clear();
    // AB-404: its notes were not shown either; the next hook or wake-up lists the oversized messages again.
    this.handedNotes.clear();
  }

  /** The hooks' view of this endpoint (ServerContext.wakeDelivery). */
  delivery(): NonNullable<import("./server.js").ServerContext["wakeDelivery"]> {
    return {
      confirm: () => this.confirmDelivery(), release: () => this.releaseUndelivered(), active: () => this.sessionActive(), idle: () => this.sessionIdle(), modActive: () => this.modActive,
      confirmPrompt: (prompt) => this.confirmPrompt(prompt), inFlight: (id) => this.inFlight(id), repeat: (ids) => this.markRepeat(ids), repeated: (id) => this.repeated(id),
    };
  }

  /** Whether a hook is currently waiting (used by tests and diagnostics). */
  get waiting(): boolean {
    return this.waiter !== null;
  }

  /** Another server of this session took over the bridge: stop handing out wake-ups from here. */
  retire(): void {
    this.retired = true;
    this.waiter?.abort("superseded");
    this.modWaiter?.abort("superseded");
    this.standby?.release("superseded");
  }

  /** This server took its place back: serve again, and point the session's hooks and mod here again. */
  unretire(): void {
    this.retired = false;
    const sessionId = this.registered;
    this.registered = null;
    if (sessionId) this.register(sessionId);
  }

  /** Publish the endpoint for this Claude session id so the hook can find it. */
  register(sessionId: string): void {
    if (!this.server || this.retired || this.registered === sessionId) return;
    // Another session id: its T3 chat is looked up again.
    this.t3Thread = undefined;
    this.t3LookedUpAt = 0;
    const file = sessionFile(this.home, sessionId);
    mkdirSync(join(this.home, SESSIONS_DIR), { recursive: true });
    const reg: RewakeRegistration = { port: this.port, secret: this.secret, pid: process.pid };
    writeFileSync(file, JSON.stringify(reg), { mode: 0o600 });
    if (this.registered) rmSync(sessionFile(this.home, this.registered), { force: true });
    this.registered = sessionId;
    this.log.debug("rewake endpoint registered", { sessionId });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.t3) this.node.off("message", this.onT3Message);
    clearTimeout(this.t3Timer);
    clearTimeout(this.t3ConfirmTimer);
    for (const send of this.t3Sends) send.abort();
    this.waiter?.abort("superseded");
    this.modWaiter?.abort("superseded");
    this.standby?.release("superseded");
    clearTimeout(this.confirmTimer);
    if (this.registered) rmSync(sessionFile(this.home, this.registered), { force: true });
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}
