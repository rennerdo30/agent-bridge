import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  escapeAttr,
  formatMessage,
  formatMessages,
  neutralizeMarkup
} from "./chunk-4LO2CFBP.mjs";
import {
  tokensEqual
} from "./chunk-DNAUDSOJ.mjs";
import {
  discoverDriveAliases
} from "./chunk-HYOPFLLN.mjs";
import {
  AGENT_KINDS,
  BROADCAST,
  isQuietMessage
} from "./chunk-IYJ5P7ML.mjs";

// src/mcp/rewake.ts
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

// src/mcp/output-bounds.ts
import { realpathSync } from "node:fs";
var MCP_RESULT_MAX_BYTES = 18e4;
var MCP_RESULT_MARGIN_BYTES = 4096;
var MCP_RESULT_BUDGET_BYTES = MCP_RESULT_MAX_BYTES - MCP_RESULT_MARGIN_BYTES;
function mcpContentBytes(texts) {
  return Buffer.byteLength(JSON.stringify(texts.map((text) => ({ type: "text", text }))), "utf8");
}
function fitsMcpResult(texts, budget = MCP_RESULT_BUDGET_BYTES) {
  const list = typeof texts === "string" ? [texts] : texts;
  if (list.reduce((sum, text) => sum + text.length, 0) * 6 + 64 * (list.length + 1) < budget) return true;
  return mcpContentBytes(list) <= budget;
}
function lineBytes(line) {
  return Buffer.byteLength(JSON.stringify(line), "utf8");
}
var isHigh = (code) => code >= 55296 && code <= 56319;
var isLow = (code) => code >= 56320 && code <= 57343;
function sliceWhole(value, start, end = value.length) {
  start = Math.max(0, Math.min(start, value.length));
  end = Math.max(start, Math.min(end, value.length));
  if (start > 0 && start < value.length && isLow(value.charCodeAt(start)) && isHigh(value.charCodeAt(start - 1))) start--;
  if (end > start && end < value.length && isHigh(value.charCodeAt(end - 1)) && isLow(value.charCodeAt(end))) end--;
  return value.slice(start, end);
}
function longestFittingPrefix(value, fits) {
  let low = 0, high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(sliceWhole(value, 0, mid))) low = mid;
    else high = mid - 1;
  }
  return sliceWhole(value, 0, low).length;
}
var DEFAULT_HINT = "Narrow the query or request a smaller page.";
function boundMcpTexts(texts, hint = DEFAULT_HINT, budget = MCP_RESULT_BUDGET_BYTES) {
  if (fitsMcpResult(texts, budget)) return [...texts];
  const value = texts.join("\n");
  const trimmed = value.trimStart();
  let parsed, isJson = false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      parsed = JSON.parse(value);
      isJson = true;
    } catch {
      isJson = false;
    }
  }
  if (isJson && Array.isArray(parsed)) {
    const items = parsed;
    const render = (count) => [
      JSON.stringify(items.slice(0, count)),
      `[Result shortened: showing ${count} of ${items.length} items to stay within the MCP result limit. ${hint}]`
    ];
    let low = 0, high = items.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fitsMcpResult(render(mid), budget)) low = mid;
      else high = mid - 1;
    }
    if (low > 0) return render(low);
  }
  if (isJson) {
    const wrap = (preview) => JSON.stringify({ truncated: true, totalCharacters: value.length, hint, preview });
    return [wrap(sliceWhole(value, 0, longestFittingPrefix(value, (prefix) => fitsMcpResult(wrap(prefix), budget))))];
  }
  const note = (shown) => `
[Output shortened from ${value.length} to ${shown} characters to stay within the MCP result limit. ${hint}]`;
  const length = longestFittingPrefix(value, (prefix) => fitsMcpResult(prefix + note(value.length), budget));
  return [sliceWhole(value, 0, length) + note(length)];
}
function boundMcpText(value, hint = DEFAULT_HINT, budget = MCP_RESULT_BUDGET_BYTES) {
  return boundMcpTexts([value], hint, budget).join("\n");
}
function pageListing(lines, options, budget = MCP_RESULT_BUDGET_BYTES) {
  const entries = lines.flatMap((line, index) => "entry" in line ? [index] : []);
  const total = entries.length, offset = Math.min(Math.max(0, options.offset ?? 0), total);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const render = (selected2, footer2, shortened2) => {
    const categories = new Set([...selected2].map((index) => lines[index].category));
    const out = [];
    lines.forEach((line, index) => {
      if ("info" in line) out.push(line.info);
      else if ("header" in line) {
        if (categories.has(line.category)) out.push(line.header);
      } else if (selected2.has(index)) out.push(shortened2?.get(index) ?? line.entry);
    });
    if (footer2) out.push(footer2);
    return out.join("\n");
  };
  const footer = (shown2) => {
    const next = offset + shown2 < total ? offset + shown2 : null;
    if (next === null && offset === 0 && options.limit === void 0) return null;
    return `[Showing entries ${shown2 ? offset + 1 : offset}-${offset + shown2} of ${total}; ${next === null ? "last page" : `next page: offset=${next}`}. ${options.hint}]`;
  };
  const headerOf = /* @__PURE__ */ new Map();
  for (const line of lines) if ("header" in line && !headerOf.has(line.category)) headerOf.set(line.category, line.header);
  const longestFooter = `[Showing entries ${total}-${total} of ${total}; next page: offset=${total}. ${options.hint}]`;
  let bytes = mcpContentBytes([render(/* @__PURE__ */ new Set(), longestFooter)]);
  const selected = /* @__PURE__ */ new Set(), seen = /* @__PURE__ */ new Set();
  let shortened;
  for (let i = offset; i < total && selected.size < limit; i++) {
    const index = entries[i], line = lines[index];
    const header = !seen.has(line.category) ? headerOf.get(line.category) : void 0;
    const headerBytes = header === void 0 ? 0 : lineBytes(header);
    let cost = headerBytes + lineBytes(line.entry);
    if (bytes + cost > budget) {
      if (selected.size > 0) break;
      const marker = " [entry shortened]", room = budget - bytes - headerBytes;
      const length = longestFittingPrefix(line.entry, (prefix) => lineBytes(prefix + marker) <= room);
      const short = sliceWhole(line.entry, 0, length) + marker;
      shortened = /* @__PURE__ */ new Map([[index, short]]);
      cost = headerBytes + lineBytes(short);
    }
    selected.add(index);
    seen.add(line.category);
    bytes += cost;
  }
  let text = render(selected, footer(selected.size), shortened);
  if (!fitsMcpResult(text, budget)) text = boundMcpText(text, options.hint, budget);
  const shown = selected.size;
  return { text, shown, total, nextOffset: offset + shown < total ? offset + shown : null };
}
function selectForDelivery(messages, render, measure, budget = MCP_RESULT_BUDGET_BYTES, standalone = render) {
  const shown = [], oversized = [], deferred = [];
  let bytes = mcpContentBytes([render([], [], [...messages])]), full = false;
  const empty = mcpContentBytes([standalone([], [], [])]);
  const fitsAlone = (message, cost) => empty + cost <= budget - 4096 || mcpContentBytes([standalone([message], [], [])]) <= budget;
  for (const message of messages) {
    const cost = lineBytes(measure(message)) + 16;
    if (!full && bytes + cost <= budget) {
      shown.push(message);
      bytes += cost;
      continue;
    }
    if (fitsAlone(message, cost)) {
      deferred.push(message);
      full = true;
    } else oversized.push(message);
  }
  while (shown.length && !fitsMcpResult(render(shown, oversized, deferred), budget)) {
    const last = shown.pop();
    if (shown.length) {
      deferred.unshift(last);
      continue;
    }
    if (fitsMcpResult(standalone([last], oversized, deferred), budget)) deferred.unshift(last);
    else oversized.unshift(last);
  }
  return { shown, oversized, deferred };
}
function unshownMessageNotes(oversized, deferred, pageCall) {
  const notes = oversized.map((m) => neutralizeMarkup(`[agent-bridge] Message ${m.id} from ${m.from.name} (${m.body.length} characters) is too large to show in one result; it stays unread. Read it in pages with ${pageCall(m.id)}.`));
  if (deferred > 0) notes.push(`[agent-bridge] ${deferred} more unread message(s) did not fit this result; they stay unread for the next call.`);
  return notes;
}
function messageBodyPage(body, offset, render, budget = MCP_RESULT_BUDGET_BYTES) {
  const start = body.length - sliceWhole(body, offset).length;
  const rest = body.slice(start);
  const length = longestFittingPrefix(rest, (prefix) => fitsMcpResult(render(prefix, start, start + prefix.length), budget));
  const end = start + length;
  return { text: render(body.slice(start, end), start, end), start, end };
}
function projectPathKey(path, canonical = realpathSync.native, mappings = discoverDriveAliases(), platform = process.platform) {
  let value = path.trim();
  try {
    value = canonical(value);
  } catch {
    const drive = /^[a-z]:/i.exec(value)?.[0]?.toUpperCase();
    const mapping = drive ? mappings.find((m) => m.alias.slice(0, 2).toUpperCase() === drive) : void 0;
    if (mapping) value = mapping.real.slice(0, 2) + value.slice(2);
  }
  value = value.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? value.toLowerCase() : value;
}
function projectFilter(filter, key = projectPathKey) {
  if (!filter) return null;
  const cache = /* @__PURE__ */ new Map();
  const keyOf = (path) => {
    let k = cache.get(path);
    if (k === void 0) {
      k = key(path);
      cache.set(path, k);
    }
    return k;
  };
  const absolute = /^(?:[a-z]:(?:[\\/]|$)|\/|\\\\)/i.test(filter);
  const wanted = absolute ? key(filter) : filter.replace(/\\/g, "/").toLowerCase();
  return (paths) => paths.some((path) => {
    if (!path) return false;
    const k = keyOf(path);
    if (absolute) return k === wanted || k.startsWith(`${wanted}/`);
    return k.toLowerCase().includes(wanted) || path.replace(/\\/g, "/").toLowerCase().includes(wanted);
  });
}

// src/mcp/rewake.ts
var SESSIONS_DIR = "sessions";
var WAKE_HEADER = "[agent-bridge] New actionable message(s) arrived:";
var HOST = "127.0.0.1";
var SECRET_BYTES = 24;
var REWAKE_POLL_MS = 4 * 60 * 1e3;
var WAKE_CONFIRM_MS = 2e4;
var STANDBY_GRACE_MS = 3e3;
var MOD_TICK_MS = 2e3;
var MOD_HANDOUT_TURNS = 2;
var MAX_REPEATS = 500;
function wakeMessageIds(text) {
  return [...text.matchAll(/<agent-bridge-message id="([^"]+)"/g)].map((m) => m[1]);
}
function oversizedNoteMarker(id) {
  return `<agent-bridge-oversized id="${escapeAttr(id)}"/>`;
}
function sessionFile(home, sessionId) {
  return join(home, SESSIONS_DIR, `${sessionId.replace(/[^\w-]/g, "_")}.json`);
}
function shouldWakeClaudeMessage(node, cfg, m) {
  if (m.hop >= cfg.maxHops || isQuietMessage(m) || m.conversationId.endsWith(":note")) return false;
  const direct = m.to === node.name || m.recipient === node.name && m.to !== BROADCAST && !AGENT_KINDS.includes(m.to) || m.from.id.includes("/") && m.to.slice(m.to.indexOf("/") + 1) === node.name;
  return node.autoWakeEnabled || node.isNotificationAwaited(m) || direct && (m.from.id.startsWith("job:") || node.isAwaitedReply(m)) || (direct || m.to === BROADCAST) && cfg.wakeOnDirect;
}
var RewakeEndpoint = class {
  constructor(home, node, shouldWake, log, activity, mailScopes, oversized, standbyGraceMs = STANDBY_GRACE_MS) {
    this.home = home;
    this.node = node;
    this.shouldWake = shouldWake;
    this.log = log;
    this.activity = activity;
    this.mailScopes = mailScopes;
    this.oversized = oversized;
    this.standbyGraceMs = standbyGraceMs;
  }
  home;
  node;
  shouldWake;
  log;
  activity;
  mailScopes;
  oversized;
  standbyGraceMs;
  server = null;
  secret = randomBytes(SECRET_BYTES).toString("hex");
  port = 0;
  registered = null;
  /** Only the newest waiter gets messages; an older one (from an earlier turn) is released empty. */
  waiter = null;
  /** Messages handed to a Stop-hook wake-up that the session has not shown activity for yet. */
  handedOut = /* @__PURE__ */ new Set();
  /**
   * Messages handed to the mod, with the turn-end count at hand-out. The mod submits them as a prompt, which
   * Claude Code queues behind a turn that starts meanwhile: they are on their way to their own turn, so the
   * hooks must not show them too (AB-396). Read when that prompt's hook runs or the mod acknowledges them.
   */
  modHandedOut = /* @__PURE__ */ new Map();
  /**
   * AB-404: oversized-message notes handed to a Stop-hook wake-up. A note counts as shown (OversizedMessages.note)
   * only when the wake-up is confirmed like its messages; a lost wake-up's notes are listed again.
   */
  handedNotes = /* @__PURE__ */ new Set();
  /** AB-404: notes handed to the mod, with the turn-end and turn-start counts at hand-out (see modNoteInFlight). */
  modNotes = /* @__PURE__ */ new Map();
  /**
   * AB-404: notes taken back at an acknowledgement although the mod may have submitted them: a mod of v0.30.12 or
   * older acknowledges at its own turn start, before that prompt's hook. Their prompt still confirms them; they are
   * not in flight, and the mod's next poll hands them out again (and forgets them here).
   */
  ackedNotes = /* @__PURE__ */ new Set();
  /** Main turns that ended (busy to idle); ages the hand-outs of a mod that stopped polling. */
  turnEnds = 0;
  /** Main turns that started (idle to busy): a mod note whose re-poll saw no turn start was not taken. */
  turnStarts = 0;
  /** Messages whose earlier hand-out may have reached the model: a later copy is marked as a repeat. */
  repeats = /* @__PURE__ */ new Set();
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
  /**
   * A message a wake-up may carry: it should wake the session, and it is not an oversized message whose note was
   * shown (AB-404) or is on its way to its own mod turn.
   */
  deliverable = (m) => this.shouldWake(m) && !this.oversized?.noted(m.id) && !this.modNoteInFlight(m.id);
  /** A message that should start a wake-up: deliverable, and not a note this endpoint handed out and awaits (AB-404). */
  wakeable = (m) => this.deliverable(m) && !this.handedNotes.has(m.id);
  async start() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${HOST}`);
      if (url.pathname === "/mail-scope" && tokensEqual(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), this.secret)) {
        const session = url.searchParams.get("session_id");
        if (req.method !== "POST" || this.retired || !this.mailScopes || !session || session !== this.registered || session !== this.node.currentSessionId) {
          res.writeHead(409).end();
          return;
        }
        res.setHeader("cache-control", "no-store");
        try {
          const token = this.mailScopes.issue(url.searchParams.get("tool") ?? "", session, url.searchParams.get("agent_id") ?? void 0);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token }));
        } catch {
          res.writeHead(403).end();
        }
        return;
      }
      if (url.pathname === "/activity" && tokensEqual(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), this.secret)) {
        const accepted = !this.retired && this.activity?.({ sessionId: url.searchParams.get("session_id") ?? "", turnId: url.searchParams.get("turn_id") ?? "", sequence: Number(url.searchParams.get("sequence")), busy: url.searchParams.get("busy") === "1", instance: url.searchParams.get("instance") ?? void 0 });
        if (accepted) this.modSeen = true;
        res.writeHead(accepted ? 204 : 409).end();
        return;
      }
      if (url.pathname === "/mod" && tokensEqual(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), this.secret)) {
        this.modSeen = true;
        const busy = url.searchParams.get("busy") === "1";
        if (busy) {
          this.confirmDelivery();
          this.confirmMod([...this.modHandedOut.keys()]);
          this.acknowledgeNotes();
        }
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
  /**
   * Hand the waiting messages to a wake-up; they stay unread until the session shows activity. AB-404: the
   * wake-up text is bounded like a hook result. Only messages shown in full are handed out; one too large to
   * show is listed by id once (it stays unread and inbox pages it), and the rest wait for the next wake-up.
   */
  handOut(toMod = false) {
    const render = (shown2, oversized2, deferred2) => [
      shown2.length ? formatMessages(shown2, { header: WAKE_HEADER, repeat: (m) => this.repeated(m.id) }) : WAKE_HEADER,
      ...unshownMessageNotes(oversized2, deferred2.length, (id) => `inbox(id="${id}", offset=0)`).map((note, i) => i < oversized2.length ? `${oversizedNoteMarker(oversized2[i].id)} ${note}` : note)
    ].join("\n\n");
    const { shown, oversized, deferred } = selectForDelivery(this.node.unread().filter(this.deliverable), render, formatMessage);
    for (const m of shown) {
      if (toMod) this.modHandedOut.set(m.id, this.turnEnds);
      else this.handedOut.add(m.id);
    }
    for (const m of oversized) {
      if (toMod) this.modNotes.set(m.id, { ends: this.turnEnds, starts: this.turnStarts });
      else this.handedNotes.add(m.id);
    }
    return shown.length || oversized.length ? render(shown, oversized, deferred) : "";
  }
  /** The turn-end hook: wakes the session for the next message that should wake it. */
  waitPrimary(res) {
    this.confirmDelivery();
    this.waiter?.abort("superseded");
    const ac = new AbortController();
    this.waiter = ac;
    res.on("close", () => ac.abort("closed"));
    void this.node.waitForMessage(REWAKE_POLL_MS, this.wakeable, ac.signal).then((first) => {
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
    const loop = () => void this.node.waitForMessage(REWAKE_POLL_MS, (m) => this.wakeable(m) && !this.pendingWake() && !this.waiter, ac.signal).then((m) => {
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
  waitMod(res) {
    this.modSeen = true;
    this.handedNotes.clear();
    this.ackedNotes.clear();
    for (const [id, at] of this.modNotes) if (at.starts === this.turnStarts) this.modNotes.delete(id);
    this.modWaiter?.abort("superseded");
    const ac = new AbortController();
    this.modWaiter = ac;
    res.on("close", () => ac.abort("closed"));
    const deadline = Date.now() + REWAKE_POLL_MS;
    void (async () => {
      while (!ac.signal.aborted && Date.now() < deadline) {
        const waiting = this.node.unread().some(this.wakeable);
        if (waiting && !this.busy) break;
        if (waiting) await new Promise((r) => setTimeout(r, MOD_TICK_MS).unref());
        else await this.node.waitForMessage(MOD_TICK_MS, this.wakeable, ac.signal);
      }
      if (this.modWaiter === ac) this.modWaiter = null;
      if (ac.signal.aborted || Date.now() >= deadline || res.destroyed) return this.reply(res, "", ac.signal.reason === "superseded");
      const text = this.handOut(true);
      this.log.info("waking the session (mod)", { count: this.modHandedOut.size });
      this.reply(res, text, false);
    })();
  }
  setBusy(busy) {
    if (busy && !this.busy) this.turnStarts++;
    this.busy = busy;
    if (busy) this.modWaiter?.abort("superseded");
  }
  /** Whether the mod wakes this session (the Stop hook then leaves messages to it instead of blocking). */
  get modActive() {
    return this.modSeen;
  }
  /** A turn ended (the Stop hook ran). */
  sessionIdle() {
    if (this.busy) this.turnEnds++;
    this.setBusy(false);
  }
  /** Read mod hand-outs: shown in their own turn or acknowledged by the mod. */
  confirmMod(ids) {
    const shown = ids.filter((id) => this.modHandedOut.delete(id));
    if (shown.length) this.node.markRead(shown);
  }
  /**
   * AB-404: the mod acknowledged a hand-out (its message ids were all submitted before), so it did not submit this
   * text. A note in it counts as shown only when its hand-out came before a real turn start: an earlier hand-out the
   * mod submitted, queued behind that turn. A note handed out since (no turn started) was in the acknowledged text
   * only, so it is not confirmed but handed out again on the mod's re-poll, as a note-only wake-up it submits.
   */
  acknowledgeNotes() {
    const queued = [];
    for (const [id, at] of this.modNotes) {
      if (at.starts < this.turnStarts) queued.push(id);
      else {
        this.modNotes.delete(id);
        this.ackedNotes.add(id);
      }
    }
    this.confirmNotes(queued);
  }
  /** AB-404: these oversized-message notes were shown; the messages themselves stay unread. */
  confirmNotes(ids) {
    const noted = [...ids];
    for (const id of noted) {
      this.handedNotes.delete(id);
      this.modNotes.delete(id);
      this.ackedNotes.delete(id);
    }
    if (noted.length) this.oversized?.note(noted);
  }
  /** Whether a Stop-hook wake-up (messages or notes) waits for its confirmation. */
  pendingWake() {
    return this.handedOut.size > 0 || this.handedNotes.size > 0;
  }
  /**
   * A note handed to the mod is on its way to its own wake turn. One that outlived MOD_HANDOUT_TURNS turn ends goes
   * back to the hooks and wake-ups, like a mod hand-out (AB-396).
   */
  modNoteInFlight(id) {
    const at = this.modNotes.get(id);
    if (at === void 0) return false;
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
  inFlight(id) {
    if (this.modNoteInFlight(id)) return true;
    const at = this.modHandedOut.get(id);
    if (at === void 0) return false;
    if (this.turnEnds - at < MOD_HANDOUT_TURNS) return true;
    this.modHandedOut.delete(id);
    this.markRepeat([id]);
    this.log.warn("a mod wake-up was neither shown nor acknowledged; the hooks deliver it as a repeat", { id });
    return false;
  }
  /** A turn's prompt: a wake-up's own prompt shows its messages, wherever they were handed out. */
  confirmPrompt(prompt) {
    if (!prompt.includes(WAKE_HEADER)) return;
    this.confirmNotes([.../* @__PURE__ */ new Set([...this.handedNotes, ...this.modNotes.keys(), ...this.ackedNotes])].filter((id) => prompt.includes(oversizedNoteMarker(id))));
    const ids = new Set(wakeMessageIds(prompt));
    if (!ids.size) return;
    for (const id of ids) {
      this.handedOut.delete(id);
      this.modHandedOut.delete(id);
    }
    const shown = this.node.unread().filter((m) => ids.has(m.id)).map((m) => m.id);
    if (shown.length) this.node.markRead(shown);
  }
  /** These messages may already have reached the model; a later copy says so. */
  markRepeat(ids) {
    for (const id of ids) {
      this.repeats.delete(id);
      this.repeats.add(id);
    }
    while (this.repeats.size > MAX_REPEATS) this.repeats.delete(this.repeats.values().next().value);
  }
  /** Whether a copy of this message repeats an earlier hand-out. */
  repeated(id) {
    return this.repeats.has(id);
  }
  /** The first wake-up was not confirmed: give the same messages to the standby hook. */
  retryWake() {
    if (!this.pendingWake()) return;
    if (this.modSeen) {
      this.handedNotes.clear();
      return;
    }
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
  confirmDelivery() {
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
  sessionActive() {
    this.setBusy(true);
    this.waiter?.abort("superseded");
    this.standby?.release("active");
  }
  /**
   * The Stop-hook wake-up looks lost (a new prompt came first): its messages go out with that prompt instead,
   * marked as repeats because Claude Code may still start the wake-up's turn. Mod hand-outs are not lost: the
   * mod's prompt is queued behind this one and shows them in its own turn.
   */
  releaseUndelivered() {
    if (this.handedOut.size) this.log.warn("a wake-up did not reach the session; delivering its messages with the next prompt", { count: this.handedOut.size });
    this.markRepeat(this.handedOut);
    this.handedOut.clear();
    this.handedNotes.clear();
  }
  /** The hooks' view of this endpoint (ServerContext.wakeDelivery). */
  delivery() {
    return {
      confirm: () => this.confirmDelivery(),
      release: () => this.releaseUndelivered(),
      active: () => this.sessionActive(),
      idle: () => this.sessionIdle(),
      modActive: () => this.modActive,
      confirmPrompt: (prompt) => this.confirmPrompt(prompt),
      inFlight: (id) => this.inFlight(id),
      repeat: (ids) => this.markRepeat(ids),
      repeated: (id) => this.repeated(id)
    };
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
  fitsMcpResult,
  sliceWhole,
  longestFittingPrefix,
  boundMcpTexts,
  pageListing,
  selectForDelivery,
  unshownMessageNotes,
  messageBodyPage,
  projectFilter,
  WAKE_HEADER,
  sessionFile,
  shouldWakeClaudeMessage,
  RewakeEndpoint
};
