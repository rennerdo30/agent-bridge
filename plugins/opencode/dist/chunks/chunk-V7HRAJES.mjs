import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  formatMessages
} from "./chunk-RAQCWDAY.mjs";
import {
  tokensEqual
} from "./chunk-V4WDBMEN.mjs";
import {
  AGENT_KINDS,
  BROADCAST,
  isQuietMessage
} from "./chunk-4QXHCXBU.mjs";

// src/mcp/rewake.ts
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
var SESSIONS_DIR = "sessions";
var WAKE_HEADER = "[agent-bridge] New actionable message(s) arrived:";
var HOST = "127.0.0.1";
var SECRET_BYTES = 24;
var REWAKE_POLL_MS = 4 * 60 * 1e3;
var WAKE_CONFIRM_MS = 2e4;
var STANDBY_GRACE_MS = 3e3;
var MOD_TICK_MS = 2e3;
function sessionFile(home, sessionId) {
  return join(home, SESSIONS_DIR, `${sessionId.replace(/[^\w-]/g, "_")}.json`);
}
function shouldWakeClaudeMessage(node, cfg, m) {
  if (m.hop >= cfg.maxHops || isQuietMessage(m) || m.conversationId.endsWith(":note")) return false;
  const direct = m.to === node.name || m.recipient === node.name && m.to !== BROADCAST && !AGENT_KINDS.includes(m.to) || m.from.id.includes("/") && m.to.slice(m.to.indexOf("/") + 1) === node.name;
  return node.autoWakeEnabled || node.isNotificationAwaited(m) || direct && (m.from.id.startsWith("job:") || node.isAwaitedReply(m)) || (direct || m.to === BROADCAST) && cfg.wakeOnDirect;
}
var RewakeEndpoint = class {
  constructor(home, node, shouldWake, log) {
    this.home = home;
    this.node = node;
    this.shouldWake = shouldWake;
    this.log = log;
  }
  home;
  node;
  shouldWake;
  log;
  server = null;
  secret = randomBytes(SECRET_BYTES).toString("hex");
  port = 0;
  registered = null;
  /** Only the newest waiter gets messages; an older one (from an earlier turn) is released empty. */
  waiter = null;
  /** Messages handed to a wake-up that the session has not shown activity for yet. */
  handedOut = /* @__PURE__ */ new Set();
  /** The second hook of a turn end, waiting to retry a wake-up that did not start a turn. */
  standby = null;
  confirmTimer;
  /**
   * The agent-bridge mod (Claude Code 2.1.287+, plugins/claude/hooks/wake.ts) wakes the session itself with
   * $.prompt.submit, a real turn: once it has shown up, the Stop hooks step aside and leave waking to it.
   */
  modWaiter = null;
  /** The bridge gave this session to another server of it: this endpoint stays quiet (see retire). */
  retired = false;
  modSeen = false;
  /** A turn is running (from the hooks and the mod): the mod waits until the session is idle. */
  busy = false;
  async start() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${HOST}`);
      if (url.pathname === "/mod" && tokensEqual(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), this.secret)) {
        this.modSeen = true;
        const busy = url.searchParams.get("busy") === "1";
        if (busy) this.confirmDelivery();
        this.setBusy(busy);
        res.writeHead(204).end();
        return;
      }
      if (url.pathname !== "/wait" || !tokensEqual(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), this.secret)) {
        res.writeHead(403).end();
        return;
      }
      if (this.retired) this.reply(res, "", true);
      else if (url.searchParams.get("role") === "mod") this.waitMod(res);
      else if (this.modSeen) this.reply(res, "", true);
      else if (url.searchParams.get("role") === "standby") this.waitStandby(res);
      else this.waitPrimary(res);
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, HOST, () => resolve());
    });
    this.port = this.server.address().port;
  }
  reply(res, text, superseded) {
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text, superseded }));
  }
  /** Hand the waiting messages to a wake-up; they stay unread until the session shows activity. */
  handOut() {
    const msgs = this.node.unread().filter(this.shouldWake);
    for (const m of msgs) this.handedOut.add(m.id);
    return formatMessages(msgs, { header: WAKE_HEADER });
  }
  /** The turn-end hook: wakes the session for the next message that should wake it. */
  waitPrimary(res) {
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
  waitStandby(res) {
    this.standby?.release("superseded");
    const ac = new AbortController();
    let done = false;
    const finish = (text, superseded) => {
      if (done) return;
      done = true;
      ac.abort("done");
      if (this.standby?.ac === ac) this.standby = null;
      this.reply(res, text, superseded);
    };
    this.standby = { ac, release: () => finish("", true), wake: () => finish(this.handOut(), false) };
    res.on("close", () => finish("", false));
    const loop = () => void this.node.waitForMessage(REWAKE_POLL_MS, (m) => this.shouldWake(m) && !this.handedOut.has(m.id) && !this.waiter, ac.signal).then((m) => {
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
  waitMod(res) {
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
        if (waiting) await new Promise((r) => setTimeout(r, MOD_TICK_MS).unref());
        else await this.node.waitForMessage(MOD_TICK_MS, this.shouldWake, ac.signal);
      }
      if (this.modWaiter === ac) this.modWaiter = null;
      if (ac.signal.aborted || Date.now() >= deadline) return this.reply(res, "", ac.signal.reason === "superseded");
      const text = this.handOut();
      this.log.info("waking the session (mod)", { count: this.handedOut.size });
      this.reply(res, text, false);
    })();
  }
  setBusy(busy) {
    this.busy = busy;
    if (busy) this.modWaiter?.abort("superseded");
  }
  /** Whether the mod wakes this session (the Stop hook then leaves messages to it instead of blocking). */
  get modActive() {
    return this.modSeen;
  }
  /** A turn ended (the Stop hook ran). */
  sessionIdle() {
    this.setBusy(false);
  }
  /** The first wake-up was not confirmed: give the same messages to the standby hook. */
  retryWake() {
    if (this.handedOut.size === 0) return;
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
   * last wake-up reached it. Called before hooks inject unread mail, so they are not shown twice.
   */
  confirmDelivery() {
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
  sessionActive() {
    this.setBusy(true);
    this.waiter?.abort("superseded");
    this.standby?.release("active");
  }
  /** The wake-up was lost (a new prompt came first): its messages go out with that prompt instead. */
  releaseUndelivered() {
    if (this.handedOut.size) this.log.warn("a wake-up did not reach the session; delivering its messages with the next prompt", { count: this.handedOut.size });
    this.handedOut.clear();
  }
  /** Whether a hook is currently waiting (used by tests and diagnostics). */
  get waiting() {
    return this.waiter !== null;
  }
  /** Another server of this session took over the bridge: stop handing out wake-ups from here. */
  retire() {
    this.retired = true;
    this.waiter?.abort("superseded");
    this.modWaiter?.abort("superseded");
    this.standby?.release("superseded");
  }
  /** This server took its place back: serve again, and point the session's hooks and mod here again. */
  unretire() {
    this.retired = false;
    const sessionId = this.registered;
    this.registered = null;
    if (sessionId) this.register(sessionId);
  }
  /** Publish the endpoint for this Claude session id so the hook can find it. */
  register(sessionId) {
    if (!this.server || this.retired || this.registered === sessionId) return;
    const file = sessionFile(this.home, sessionId);
    mkdirSync(join(this.home, SESSIONS_DIR), { recursive: true });
    const reg = { port: this.port, secret: this.secret, pid: process.pid };
    writeFileSync(file, JSON.stringify(reg), { mode: 384 });
    if (this.registered) rmSync(sessionFile(this.home, this.registered), { force: true });
    this.registered = sessionId;
    this.log.debug("rewake endpoint registered", { sessionId });
  }
  async stop() {
    this.waiter?.abort("superseded");
    this.modWaiter?.abort("superseded");
    this.standby?.release("superseded");
    clearTimeout(this.confirmTimer);
    if (this.registered) rmSync(sessionFile(this.home, this.registered), { force: true });
    const s = this.server;
    this.server = null;
    if (s) await new Promise((r) => s.close(() => r()));
  }
};

export {
  WAKE_HEADER,
  sessionFile,
  shouldWakeClaudeMessage,
  RewakeEndpoint
};
