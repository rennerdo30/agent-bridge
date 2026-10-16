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
import { formatMessages } from "./format.js";
import type { ClaudeMailScopes } from "./claude-mail-scope.js";

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
  /** Main turns that ended (busy to idle); ages the hand-outs of a mod that stopped polling. */
  private turnEnds = 0;
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

  constructor(
    private readonly home: string,
    private readonly node: BridgeNode,
    /** Messages that should wake the session. */
    private readonly shouldWake: (m: BridgeMessage) => boolean,
    private readonly log: Logger,
    private readonly activity?: (event: import("./hook-ownership.js").ModActivity) => boolean,
    private readonly mailScopes?: ClaudeMailScopes,
  ) {}

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
        if (busy) { this.confirmDelivery(); this.confirmMod([...this.modHandedOut.keys()]); }
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
      // With the mod, the turn-end hooks end at once: the mod does the waking.
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
  }

  private reply(res: ServerResponse, text: string, superseded: boolean): void {
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "application/json" });
    // superseded: a newer turn's hook waits now, so this one should end quietly.
    res.end(JSON.stringify({ text, superseded }));
  }

  /** Hand the waiting messages to a wake-up; they stay unread until the session shows activity. */
  private handOut(toMod = false): string {
    const msgs = this.node.unread().filter(this.shouldWake);
    // Not marked read yet: Claude Code does not always turn a hook's wake-up into a turn. They count as
    // delivered once the session shows activity (confirmDelivery) or, for the mod, once their own prompt
    // runs or the mod acknowledges them; until then a retry or the next poll still gets them.
    for (const m of msgs) {
      if (toMod) this.modHandedOut.set(m.id, this.turnEnds);
      else this.handedOut.add(m.id);
    }
    return formatMessages(msgs, { header: WAKE_HEADER, repeat: (m) => this.repeated(m.id) });
  }

  /** The turn-end hook: wakes the session for the next message that should wake it. */
  private waitPrimary(res: ServerResponse): void {
    // A new waiter means a turn ended since the last wake-up, so that wake-up was delivered.
    this.confirmDelivery();
    this.waiter?.abort("superseded");
    const ac = new AbortController();
    this.waiter = ac;
    res.on("close", () => ac.abort("closed"));
    void this.node.waitForMessage(REWAKE_POLL_MS, this.shouldWake, ac.signal).then((first) => {
      if (this.waiter === ac) this.waiter = null;
      let text = "";
      if (first && !res.destroyed) {
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
        .waitForMessage(REWAKE_POLL_MS, (m) => this.shouldWake(m) && !this.handedOut.has(m.id) && !this.waiter, ac.signal)
        .then((m) => {
          if (done) return;
          if (!m) return finish("", false);
          setTimeout(() => {
            if (done) return;
            if (this.waiter || this.handedOut.has(m.id)) return loop();
            this.log.info("waking the session (standby)", { reason: "no other hook waiting" });
            this.standby?.wake();
          }, STANDBY_GRACE_MS).unref();
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
    this.modWaiter?.abort("superseded");
    const ac = new AbortController();
    this.modWaiter = ac;
    res.on("close", () => ac.abort("closed"));
    const deadline = Date.now() + REWAKE_POLL_MS;
    void (async () => {
      while (!ac.signal.aborted && Date.now() < deadline) {
        const waiting = this.node.unread().some(this.shouldWake);
        if (waiting && !this.busy) break;
        // Busy with a message already waiting: check again shortly (waitForMessage would return it at once).
        if (waiting) await new Promise<void>((r) => setTimeout(r, MOD_TICK_MS).unref());
        else await this.node.waitForMessage(MOD_TICK_MS, this.shouldWake, ac.signal);
      }
      if (this.modWaiter === ac) this.modWaiter = null;
      if (ac.signal.aborted || Date.now() >= deadline || res.destroyed) return this.reply(res, "", ac.signal.reason === "superseded");
      const text = this.handOut(true);
      this.log.info("waking the session (mod)", { count: this.modHandedOut.size });
      this.reply(res, text, false);
    })();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    // A turn started: a message now goes out with the tool hooks, not as a wake-up queued behind the turn.
    if (busy) this.modWaiter?.abort("superseded");
  }

  /** Whether the mod wakes this session (the Stop hook then leaves messages to it instead of blocking). */
  get modActive(): boolean {
    return this.modSeen;
  }

  /** A turn ended (the Stop hook ran). */
  sessionIdle(): void {
    if (this.busy) this.turnEnds++;
    this.setBusy(false);
  }

  /** Read mod hand-outs: shown in their own turn or acknowledged by the mod. */
  private confirmMod(ids: string[]): void {
    const shown = ids.filter((id) => this.modHandedOut.delete(id));
    if (shown.length) this.node.markRead(shown);
  }

  /**
   * A message on its way to its own wake turn: the mod gave it to Claude Code as a prompt, so a hook must not
   * inject it as well (AB-396). A hand-out that outlived MOD_HANDOUT_TURNS turn ends without the mod taking it
   * again goes back to the hooks, as a repeat.
   */
  inFlight(id: string): boolean {
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
    const ids = new Set(wakeMessageIds(prompt));
    if (!ids.size) return;
    for (const id of ids) { this.handedOut.delete(id); this.modHandedOut.delete(id); }
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
    if (this.handedOut.size === 0) return;
    // The mod polls again by itself when its wake-up started no turn, and gets the same messages.
    if (this.modSeen) return;
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
    const file = sessionFile(this.home, sessionId);
    mkdirSync(join(this.home, SESSIONS_DIR), { recursive: true });
    const reg: RewakeRegistration = { port: this.port, secret: this.secret, pid: process.pid };
    writeFileSync(file, JSON.stringify(reg), { mode: 0o600 });
    if (this.registered) rmSync(sessionFile(this.home, this.registered), { force: true });
    this.registered = sessionId;
    this.log.debug("rewake endpoint registered", { sessionId });
  }

  async stop(): Promise<void> {
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
