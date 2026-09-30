/**
 * The dashboard served by `agent-bridge ui`: one self-contained page, no external resources.
 * Overview of all sessions, plus a tab per session with the subagents it started, each shown as a
 * conversation (task, steps, answer, follow-ups).
 */
import { FAVICON_HREF, LOGO_SVG } from "./logo.js";
import { renderMarkdown } from "./markdown.js";

/**
 * The renderer as page script. Bundlers may wrap functions in a __name(...) helper (keepNames); the page
 * has no such helper, so the source brings a no-op one along.
 */
export const MARKDOWN_SOURCE = `(() => { const __name = (f) => f; return ${renderMarkdown.toString()}; })()`;

export const UI_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-bridge</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">
<script>try { const t = localStorage.getItem("ab-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch {}</script>
<style>
:root {
  --bg: #f4f5f7; --panel: #ffffff; --panel-2: #f8f9fb; --text: #161b26; --muted: #6b7385; --faint: #9aa1b1; --line: #e4e7ec;
  --accent: #4f46e5; --accent-soft: #eef0ff; --ok: #15803d; --ok-soft: #e8f6ed; --warn: #b45309; --warn-soft: #fdf3e2;
  --bad: #c2410c; --bad-soft: #fdeee6; --busy: #2563eb; --busy-soft: #e8efff;
  --claude: #d97757; --codex: #0f9d76; --opencode: #3b82f6; --other: #8b93a5;
  --shadow: 0 1px 2px rgba(16, 24, 40, .05);
  --mono: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0e1116; --panel: #161a21; --panel-2: #1b2029; --text: #e7e9ee; --muted: #9aa3b5; --faint: #6b7385; --line: #262c37;
    --accent: #8b87ff; --accent-soft: #23234a; --ok: #4ade80; --ok-soft: #14301f; --warn: #fbbf24; --warn-soft: #33280f;
    --bad: #fb923c; --bad-soft: #3a2012; --busy: #60a5fa; --busy-soft: #16263f;
    --shadow: none;
    color-scheme: dark;
  }
}
/* Chosen in the header: dark regardless of the system. */
:root[data-theme="dark"] {
  --bg: #0e1116; --panel: #161a21; --panel-2: #1b2029; --text: #e7e9ee; --muted: #9aa3b5; --faint: #6b7385; --line: #262c37;
  --accent: #8b87ff; --accent-soft: #23234a; --ok: #4ade80; --ok-soft: #14301f; --warn: #fbbf24; --warn-soft: #33280f;
  --bad: #fb923c; --bad-soft: #3a2012; --busy: #60a5fa; --busy-soft: #16263f;
  --shadow: none;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
.wrap { max-width: 1320px; margin: 0 auto; padding: 0 24px; }
@media (max-width: 700px) { .wrap { padding: 0 16px; } }

header { position: sticky; top: 0; z-index: 5; background: var(--panel); border-bottom: 1px solid var(--line); }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 56px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 650; font-size: 15px; }
.logo { width: 28px; height: 28px; display: block; }
.logo svg { width: 100%; height: 100%; display: block; }
.right { display: flex; align-items: center; gap: 14px; }
.theme { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.theme button { background: transparent; color: var(--muted); border: 0; border-radius: 0; padding: 4px 10px; font-size: 12px; font-weight: 500; cursor: pointer; }
.theme button + button { border-left: 1px solid var(--line); }
.theme button.on { background: var(--accent-soft); color: var(--text); }
.conn { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--muted); }
nav { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
nav a { display: inline-flex; align-items: center; gap: 7px; padding: 10px 12px; color: var(--muted); border-bottom: 2px solid transparent; white-space: nowrap; font-size: 13.5px; }
nav a:hover { color: var(--text); }
nav a.on { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
nav a.ended { opacity: .7; }
.count { min-width: 18px; padding: 0 6px; border-radius: 9px; background: var(--busy-soft); color: var(--busy); font-size: 11px; font-weight: 700; text-align: center; }

main.wrap { padding-top: 28px; padding-bottom: 48px; }
h3 { font-size: 13px; font-weight: 650; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
h3 .n { color: var(--faint); font-weight: 500; }
.block { margin-bottom: 32px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }
.empty { padding: 28px 20px; color: var(--muted); text-align: center; }

.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
.dot.busy { background: var(--busy); box-shadow: 0 0 0 3px var(--busy-soft); }
.dot.idle { background: var(--ok); }
.dot.off { background: var(--faint); }
.av { width: 34px; height: 34px; border-radius: 9px; flex: none; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 14px; background: var(--other); }
.av.sm { width: 26px; height: 26px; border-radius: 7px; font-size: 12px; }
.av.claude { background: var(--claude); } .av.codex { background: var(--codex); } .av.opencode { background: var(--opencode); }
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.pill.running { background: var(--busy-soft); color: var(--busy); }
.pill.done { background: var(--ok-soft); color: var(--ok); }
.pill.failed { background: var(--bad-soft); color: var(--bad); }
.pill.interrupted { background: var(--warn-soft); color: var(--warn); }
.pill.running::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse 1.4s infinite; }
@keyframes pulse { 50% { opacity: .3; } }
.chip.effort { display: inline-flex; align-items: center; gap: 5px; }
.meter { display: inline-flex; align-items: flex-end; gap: 1.5px; height: 10px; }
.meter i { width: 2.5px; border-radius: 1px; background: var(--line); }
.meter i:nth-child(1) { height: 4px; } .meter i:nth-child(2) { height: 6px; } .meter i:nth-child(3) { height: 8px; } .meter i:nth-child(4) { height: 10px; }
.meter i.on { background: var(--accent); }
.chip { display: inline-block; padding: 1px 7px; border-radius: 6px; background: var(--panel-2); border: 1px solid var(--line); color: var(--muted); font-size: 11.5px; white-space: nowrap; }
.chip.old { color: var(--bad); border-color: var(--bad); }
.muted { color: var(--muted); } .faint { color: var(--faint); }
.small { font-size: 12.5px; }
.ell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.hidden { display: none !important; }

/* Overview: figures */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.stat { padding: 14px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
.stat b { display: block; font-size: 24px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
.stat span { font-size: 12.5px; color: var(--muted); }
.stat.busy b { color: var(--busy); } .stat.ok b { color: var(--ok); } .stat.bad b { color: var(--bad); }
.counts { font-size: 12px; font-weight: 500; text-transform: none; letter-spacing: 0; color: var(--muted); }
.counts .w { color: var(--busy); } .counts .d { color: var(--ok); } .counts .f { color: var(--bad); }
/* Overview: session cards */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
.card { display: flex; flex-direction: column; gap: 12px; padding: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); transition: border-color .15s, transform .15s; }
.card:hover { border-color: var(--accent); transform: translateY(-1px); }
.card.ended { background: transparent; box-shadow: none; }
.card .head { display: flex; gap: 12px; align-items: center; min-width: 0; }
.card .title { font-weight: 650; font-size: 15px; }
.card .stats { display: flex; gap: 16px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--muted); }
.card .stats b { color: var(--text); font-size: 15px; font-weight: 650; margin-right: 4px; }
.kids { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--muted); }

/* Subagent rows */
.rows > a { position: relative; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 13px 16px; border-bottom: 1px solid var(--line); }
.rows > a:last-child { border-bottom: 0; }
.archive > summary { cursor: pointer; padding: 11px 16px; color: var(--muted); font-size: 13px; list-style: none; border-top: 1px solid var(--line); }
.archive > summary::-webkit-details-marker { display: none; }
.archive > summary::before { content: "▸ "; }
.archive[open] > summary::before { content: "▾ "; }
.archive > a { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 13px 16px; border-top: 1px solid var(--line); opacity: .8; }
.archive > a:hover { background: var(--panel-2); opacity: 1; }
.rows > a:hover { background: var(--panel-2); }
.rows > a.sel { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.rows .line1 { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rows .task { color: var(--muted); font-size: 13px; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.rows .side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; font-size: 12px; color: var(--faint); }

.bar { position: absolute; left: 16px; right: 16px; bottom: 5px; height: 3px; border-radius: 2px; background: var(--line); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--busy); border-radius: 2px; transition: width .4s; }

/* Messages */
.msgs { max-height: 420px; overflow: auto; }
.msg { padding: 12px 16px; border-bottom: 1px solid var(--line); }
.msg:last-child { border-bottom: 0; }
.msg .meta { font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.msg .meta b { color: var(--text); font-weight: 600; }
.msg .body { overflow-wrap: anywhere; }
form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--line); background: var(--panel-2); flex-wrap: wrap; }
select, textarea, button { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
textarea { flex: 1 1 220px; min-height: 40px; resize: vertical; }
button { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; cursor: pointer; padding: 8px 16px; }
button:disabled { opacity: .6; cursor: default; }
#sendInfo { width: 100%; color: var(--muted); font-size: 12px; }
#sendInfo:empty { display: none; }

/* Session view */
.split { display: grid; grid-template-columns: minmax(300px, 380px) minmax(0, 1fr); gap: 20px; align-items: start; }
@media (max-width: 960px) { .split { grid-template-columns: 1fr; } }
.side-col { display: flex; flex-direction: column; gap: 20px; }
.sess { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.kv { display: grid; grid-template-columns: 72px 1fr; gap: 4px 10px; font-size: 12.5px; }
.kv span:nth-child(odd) { color: var(--faint); }
.kv span:nth-child(even) { overflow-wrap: anywhere; }
.conv { display: flex; flex-direction: column; min-width: 0; height: calc(100vh - 150px); min-height: 480px; position: sticky; top: 124px; }
.conv-head { padding: 14px 18px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: center; }
.conv-head .grow { flex: 1; min-width: 0; }
.conv-head .title { font-weight: 650; font-size: 15px; display: flex; gap: 8px; align-items: center; }
.follow { font-size: 12px; color: var(--muted); display: flex; gap: 5px; align-items: center; white-space: nowrap; }
.hint { padding: 9px 18px; font-size: 12.5px; color: var(--muted); background: var(--panel-2); border-bottom: 1px solid var(--line); }
.hint code { font-family: var(--mono); font-size: 12px; color: var(--text); }
.chat { flex: 1; overflow: auto; padding: 20px 22px; display: flex; flex-direction: column; gap: 10px; }
.chat .sys { align-self: center; font-size: 12px; color: var(--faint); }
.chat .turn { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); margin: 10px 0 2px; }
.chat .turn::before, .chat .turn::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.msgrow { display: flex; gap: 10px; align-items: flex-start; max-width: 88%; }
.msgrow.me { align-self: flex-end; flex-direction: row-reverse; }
.bubble { padding: 10px 14px; border-radius: 12px; background: var(--panel-2); border: 1px solid var(--line); overflow-wrap: anywhere; min-width: 0; }
.bubble p, .msg .body p { margin: 0 0 .55em; }
.bubble > :last-child, .msg .body > :last-child { margin-bottom: 0; }
.bubble h3, .bubble h4, .bubble h5, .bubble h6, .msg .body h3, .msg .body h4 { margin: .7em 0 .35em; font-size: 14px; }
.bubble ul, .bubble ol, .msg .body ul, .msg .body ol { margin: .3em 0 .55em; padding-left: 1.4em; }
.bubble li.sub { margin-left: 1.2em; }
.bubble code, .msg .body code { font-family: var(--mono); font-size: 12px; background: var(--code-bg, rgba(127,127,127,.15)); padding: 1px 5px; border-radius: 4px; }
.bubble pre, .msg .body pre { margin: .4em 0 .6em; padding: 10px 12px; border-radius: 8px; background: rgba(127,127,127,.12); overflow-x: auto; white-space: pre; }
.bubble pre code, .msg .body pre code { background: none; padding: 0; }
.bubble blockquote { margin: .4em 0; padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); }
.bubble table { border-collapse: collapse; margin: .4em 0 .6em; font-size: 12.5px; display: block; overflow-x: auto; }
.bubble th, .bubble td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
.bubble hr { border: 0; border-top: 1px solid var(--line); margin: .6em 0; }
.bubble a, .msg .body a { color: var(--accent); }
.msgrow.me .bubble { background: var(--accent-soft); border-color: transparent; }
.bubble .who { display: block; font-size: 11.5px; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
.bubble.answer { background: var(--ok-soft); border-color: transparent; }
.bubble.answer .who { color: var(--ok); }
.bubble.clamp { max-height: 220px; overflow: hidden; position: relative; cursor: pointer; padding-bottom: 34px; }
.bubble.clamp::before { content: ""; position: absolute; left: 0; right: 0; bottom: 30px; height: 48px; background: linear-gradient(transparent, var(--accent-soft)); pointer-events: none; }
.bubble.clamp::after { content: "Show all ▾"; position: absolute; left: 0; right: 0; bottom: 0; height: 30px; line-height: 30px; padding: 0 14px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 600; }
.steps { margin-left: 36px; border-left: 2px solid var(--line); padding-left: 12px; display: flex; flex-direction: column; gap: 3px; min-width: 0; width: calc(88% - 36px); overflow: hidden; }
.steps details, .steps summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat > * { min-width: 0; flex-shrink: 0; } /* the panel scrolls; rows must never be squeezed (steps hide overflow) */
.steps summary { cursor: pointer; font-size: 12.5px; color: var(--muted); padding: 2px 0; list-style: none; }
.steps summary::-webkit-details-marker { display: none; }
.steps summary::before { content: "▸ "; }
details[open] > summary::before { content: "▾ "; }
.step { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; min-width: 0; max-width: 100%; }
.step .t { color: var(--faint); font-size: 11px; flex: none; width: 52px; font-variant-numeric: tabular-nums; }
.step .k { flex: none; font-size: 11px; font-weight: 500; color: var(--accent); }
.step code { font-family: var(--mono); font-size: 11.5px; font-weight: 400; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="top">
      <div class="brand"><span class="logo">${LOGO_SVG}</span>agent-bridge</div>
      <div class="right">
        <span class="conn" id="status">connecting…</span>
        <div class="theme" id="theme" role="group" aria-label="Theme"><button data-theme="auto">Auto</button><button data-theme="light">Light</button><button data-theme="dark">Dark</button></div>
      </div>
    </div>
    <nav id="tabs"></nav>
  </div>
</header>

<main class="wrap">
  <div id="overview">
    <div class="block stats" id="ovStats"></div>
    <div class="block"><h3>Sessions <span class="n" id="ovCount"></span></h3><div id="ovSessions" class="cards"></div></div>
    <div class="block"><h3>Subagents <span class="n">working first, then newest finished</span></h3><div class="panel rows" id="ovRuns"></div></div>
    <div class="block" id="ovMsgBox"><h3>Messages</h3><div class="panel"><div id="ovMsgs" class="msgs"></div></div></div>
  </div>

  <div id="session" class="split hidden">
    <div class="side-col">
      <div class="panel sess" id="sHead"></div>
      <div><h3>Subagents <span class="counts" id="sCount"></span></h3><div class="panel rows" id="sGroups"></div></div>
      <div id="sMsgBox"><h3>Messages</h3><div class="panel"><div id="sMsgs" class="msgs"></div></div></div>
    </div>
    <div class="panel conv">
      <div class="conv-head">
        <div id="cAvatar"></div>
        <div class="grow"><div class="title" id="cTitle">Conversation</div><div class="small muted ell" id="cSub"></div></div>
        <label class="follow"><input type="checkbox" id="follow" checked> follow</label>
      </div>
      <div class="hint hidden" id="cHint"></div>
      <div id="chat" class="chat"></div>
    </div>
  </div>
</main>

<form id="send">
  <select id="to" aria-label="Recipient"></select>
  <textarea id="body" placeholder="Message the session (sent as &quot;you&quot;)" aria-label="Message"></textarea>
  <button type="submit" id="sendBtn">Send</button>
  <div id="sendInfo"></div>
</form>

<script>
const POLL_MS = 1500;
const LOG_PAGES = 20;
/** Runs of more commands than this fold into one expandable row. */
const FOLD_STEPS = 3;
/** Finished subagents older than this move into the session's archive. */
const ARCHIVE_AFTER_MS = 30 * 60_000;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/** Markdown of agent messages (escaped first; see markdown.ts). */
const md = ${MARKDOWN_SOURCE};
const time = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : Math.floor(s / 86400) + "d ago"; };
const up = (t) => { const m = Math.max(0, Math.floor((Date.now() - t) / 60000)); return m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m"; };
const norm = (p) => String(p || "").replace(/\\\\/g, "/").replace(/\\/+$/, "").toLowerCase();
const folder = (p) => String(p || "").replace(/[\\\\/]+$/, "").split(/[\\\\/]/).pop() || p;
const av = (agent, sm) => '<span class="av ' + (sm ? "sm " : "") + esc(agent) + '">' + esc((agent || "?")[0].toUpperCase()) + "</span>";
const dot = (activity) => '<span class="dot ' + (activity === "busy" ? "busy" : activity === "idle" ? "idle" : "off") + '"></span>';
// Effort as a chip with a small level meter (unknown names, e.g. opencode variants, get no meter).
    const EFFORT_LEVELS = { minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
    const effortChip = (e) => {
      const n = EFFORT_LEVELS[String(e).toLowerCase()];
      const bars = n ? '<span class="meter">' + [1, 2, 3, 4].map((i) => "<i" + (i <= n ? ' class="on"' : "") + "></i>").join("") + "</span>" : "";
      return '<span class="chip effort" title="reasoning effort">' + bars + esc(e) + "</span>";
    };
    const pill = (status, percent) => '<span class="pill ' + status + '">' + (status === "running" ? (typeof percent === "number" ? "working · " + percent + "%" : "working") : status) + "</span>";

let state = null, model = null, route = parseRoute(), lastTo = "", pulling = false, lastChat = "";
/** Loaded run logs: name -> { raw, offset, done }. */
const logs = new Map();
/** Expanded step groups and bubbles survive re-renders. */
const opened = new Set();

function parseRoute() {
  const m = /^#\\/s\\/([^/]+)(?:\\/(.+))?$/.exec(location.hash);
  return m ? { session: decodeURIComponent(m[1]), group: m[2] ? decodeURIComponent(m[2]) : null } : { session: null, group: null };
}
function href(session, group) {
  return session ? "#/s/" + encodeURIComponent(session) + (group ? "/" + encodeURIComponent(group) : "") : "#/";
}
window.addEventListener("hashchange", () => {
  const previous = route.session;
  route = parseRoute(); lastChat = "";
  // A new tab starts at the top; picking a subagent in the same session keeps the list where it is.
  if (route.session !== previous) window.scrollTo(0, 0);
  render();
});

/** Which session started a run: its peer name, or (renamed since) the live session of that agent in that folder. */
function ownerOf(r, live) {
  if (r.by && live.some((p) => p.name === r.by)) return r.by;
  const same = r.byCwd && live.find((p) => (!r.byAgent || p.agent === r.byAgent) && norm(p.cwd) === norm(r.byCwd));
  return same ? same.name : r.by || ownerOfFolder(r.workdir, live) || "earlier runs";
}

/** Older runs do not say who started them: the live session in that project (or whose worktree it is). */
function ownerOfFolder(dir, live) {
  const d = norm(dir);
  if (!d) return null;
  const exact = live.filter((p) => norm(p.cwd) === d);
  if (exact.length === 1) return exact[0].name;
  const wt = /\\/worktrees\\/([^/]+)-[0-9a-f]{8}$/.exec(d);
  const repo = wt && live.filter((p) => norm(p.cwd).split("/").pop() === wt[1]);
  return repo && repo.length === 1 ? repo[0].name : null;
}

/** Sessions -> subagents (a job and its follow-ups) -> turns (runs). */
function buildModel(s) {
  const live = s.peers.filter((p) => p.name !== "you" && !p.subagent);
  const subPeers = s.peers.filter((p) => p.subagent);
  const groups = new Map(), ofSession = new Map();
  for (const r of [...s.runs].sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name))) {
    const key = r.job || (r.continues && ofSession.get(r.continues)) || r.name;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, job: r.job || null, agent: r.agent, model: null, owner: ownerOf(r, live), turns: [] }));
    g.turns.push(r);
    if (r.model) g.model = r.model;
      if (r.effort) g.effort = r.effort;
    if (r.session) ofSession.set(r.session, key);
  }
  for (const g of groups.values()) {
    const last = g.turns[g.turns.length - 1];
    g.status = last.status; g.updatedAt = last.updatedAt; g.last = last.last; g.task = g.turns[0].task;
    g.startedAt = g.turns[0].startedAt;
    g.title = (g.turns.find((t) => t.title) || {}).title || "";
    // Progress the subagent reported in its current turn (only meaningful while it runs).
    g.percent = g.status === "running" && typeof last.percent === "number" ? last.percent : null;
    g.progressNote = last.progressNote || "";
  }
  const sessions = live.map((p) => ({ name: p.name, peer: p, live: true, groups: [], children: [] }));
  const byName = new Map(sessions.map((x) => [x.name, x]));
  // Working subagents first (newest started first), then finished ones (newest finished first). Stable: a
  // row only moves when its subagent finishes or is continued, never while it reports progress.
  const running = (g) => g.status === "running";
  const sorted = [...groups.values()].sort((a, b) =>
    running(a) !== running(b) ? (running(a) ? -1 : 1)
    : running(a) ? b.startedAt - a.startedAt || (a.key < b.key ? -1 : 1)
    : b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : 1));
  for (const g of sorted) {
    let x = byName.get(g.owner);
    if (!x) { x = { name: g.owner, peer: null, live: false, groups: [], children: [] }; byName.set(g.owner, x); sessions.push(x); }
    x.groups.push(g);
  }
  const orphans = [];
  for (const c of subPeers) {
    const parent = byName.get(c.parent || ownerOfFolder(c.cwd, live));
    (parent ? parent.children : orphans).push(c);
  }
  for (const x of sessions) x.running = x.groups.filter((g) => g.status === "running").length;
  return { sessions, byName, groups, sorted, orphans };
}

function render() {
  if (!state) return;
  model = buildModel(state);
  renderTabs();
  const inSession = Boolean(route.session);
  $("overview").classList.toggle("hidden", inSession);
  $("session").classList.toggle("hidden", !inSession);
  if (inSession) renderSession(); else renderOverview();
  renderSendForm(inSession);
}

function renderTabs() {
  const tabs = model.sessions.filter((x) => x.live);
  const cur = route.session && model.byName.get(route.session);
  if (route.session && !(cur && cur.live)) tabs.push(cur || { name: route.session, live: false, running: 0 });
  $("tabs").innerHTML = '<a href="#/" class="' + (route.session ? "" : "on") + '">Overview</a>' + tabs.map((t) =>
    '<a href="' + href(t.name) + '" class="' + (t.name === route.session ? "on" : "") + (t.live ? "" : " ended") + '">' +
    (t.live ? dot(t.peer.activity) : "") + esc(t.name) + (t.running ? '<span class="count" title="subagents working">' + t.running + "</span>" : "") + "</a>").join("");
}

/** "0.12.0" vs "0.11.3": negative when a is older. */
const cmpVersion = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
/** The newest agent-bridge version on the bridge (the dashboard's host may itself be an older session). */
const newestVersion = () => [state.version, ...state.peers.map((p) => p.version)].filter(Boolean).reduce((m, v) => (cmpVersion(v, m) > 0 ? v : m), "0.0.0");
const versionChip = (p) => p.version && cmpVersion(p.version, newestVersion()) < 0 ? '<span class="chip old">v' + esc(p.version) + " · outdated</span>" : "";
const childLine = (c) => '<div class="ell">' + dot(c.activity) + " subagent session <b>" + esc(c.name) + "</b></div>";

function groupRow(g, sel, showOwner) {
  return '<a href="' + href(g.owner, g.key) + '" class="' + (sel ? "sel" : "") + '">' + av(g.agent) +
    // Like a chat list: the title the starting agent gave it, with agent and model below; else the task.
    (g.title
      ? '<div style="min-width:0"><div class="line1"><b class="ell">' + esc(g.title) + "</b></div>" +
        '<div class="task">' + esc(g.agent) + (g.model ? " · " + esc(g.model) : "") + (g.effort ? " · " + esc(g.effort) + " effort" : "") + (g.turns.length > 1 ? " · " + g.turns.length + " turns" : "") + "</div></div>"
      : '<div style="min-width:0"><div class="line1"><b>' + esc(g.agent) + "</b>" + (g.model ? '<span class="chip ell">' + esc(g.model) + "</span>" : "") + (g.effort ? effortChip(g.effort) : "") +
        (g.turns.length > 1 ? '<span class="chip">' + g.turns.length + " turns</span>" : "") + "</div>" +
        '<div class="task">' + esc(g.task || g.last) + "</div></div>") +
    '<div class="side">' + pill(g.status, g.percent) + "<span>" + (showOwner ? esc(g.owner) + " · " : "") + ago(g.updatedAt) + "</span></div>" +
    (g.percent !== null ? '<div class="bar" title="' + esc(g.percent + "% · " + g.progressNote) + '"><i style="width:' + g.percent + '%"></i></div>' : "") + "</a>";
}

/** How many subagents are working, finished, failed (overall and since midnight). */
function countGroups(groups) {
  const midnight = new Date().setHours(0, 0, 0, 0);
  const c = { working: 0, done: 0, failed: 0, total: groups.length, today: 0, doneToday: 0, failedToday: 0 };
  for (const g of groups) {
    const today = g.updatedAt >= midnight;
    if (g.status === "running") c.working++;
    else if (g.status === "done") c.done++, (c.doneToday += today ? 1 : 0);
    else c.failed++, (c.failedToday += today ? 1 : 0);
    if (g.startedAt >= midnight) c.today++;
  }
  return c;
}

function countsLine(c) {
  return [c.working && '<span class="w">' + c.working + " working</span>", c.done && '<span class="d">' + c.done + " done</span>", c.failed && '<span class="f">' + c.failed + " failed</span>", c.total + " total"].filter(Boolean).join(" · ");
}
function renderOverview() {
  const live = model.sessions.filter((x) => x.live), ended = model.sessions.filter((x) => !x.live && x.groups.length);
  $("ovCount").textContent = live.length || "";
  const c = countGroups(model.sorted);
  const stat = (n, label, cls) => '<div class="stat ' + (cls || "") + '"><b>' + n + "</b><span>" + label + "</span></div>";
  $("ovStats").innerHTML =
    stat(live.length, "sessions connected") +
    stat(c.working, "subagents working", c.working ? "busy" : "") +
    stat(c.today, "started today") +
    stat(c.doneToday, "finished today", c.doneToday ? "ok" : "") +
    stat(c.failedToday, "failed or interrupted today", c.failedToday ? "bad" : "") +
    stat(c.total, "subagents in the log");
  const card = (x) => {
    const p = x.peer;
    const head = p
      ? '<div class="head">' + av(p.agent) + '<div style="min-width:0;flex:1"><div class="title ell">' + esc(folder(p.cwd)) + '</div><div class="small muted ell">' + esc(x.name) + "</div></div>" + dot(p.activity) + "</div>"
      : '<div class="head">' + av("other") + '<div style="min-width:0;flex:1"><div class="title ell">' + esc(x.name) + '</div><div class="small muted">not connected</div></div></div>';
    const stats = '<div class="stats"><span><b>' + x.groups.length + "</b>subagents</span>" + (x.running ? '<span style="color:var(--busy)"><b style="color:inherit">' + x.running + "</b>working</span>" : "") +
      (p ? "<span><b>" + up(p.startedAt) + "</b>up</span>" : x.groups[0] ? "<span>last " + ago(x.groups[0].updatedAt) + "</span>" : "") + "</div>";
    const kids = x.children.length ? '<div class="kids">' + x.children.map(childLine).join("") + "</div>" : "";
    return '<a class="card' + (x.live ? "" : " ended") + '" href="' + href(x.name) + '">' + head + (p ? versionChip(p) : "") + kids + stats + "</a>";
  };
  $("ovSessions").innerHTML =
    (live.length ? live.map(card).join("") : '<div class="panel empty">No sessions connected. Start Claude Code, Codex or opencode with agent-bridge installed.</div>') +
    ended.map(card).join("") +
    (model.orphans.length ? '<div class="card ended"><div class="small muted">Subagent sessions in worktrees</div><div class="kids">' + model.orphans.map(childLine).join("") + "</div></div>" : "");
  $("ovRuns").innerHTML = model.sorted.length ? model.sorted.filter((g) => g.status === "running" || Date.now() - g.updatedAt < ARCHIVE_AFTER_MS).concat(model.sorted.filter((g) => !(g.status === "running" || Date.now() - g.updatedAt < ARCHIVE_AFTER_MS))).slice(0, 12).map((g) => groupRow(g, false, true)).join("") : '<div class="empty">No subagents yet. They appear here when a session uses ask_* or spawn_*.</div>';
  $("ovMsgs").innerHTML = messagesHtml(state.messages);
}

function renderSession() {
  const x = model.byName.get(route.session) || { name: route.session, peer: null, live: false, groups: [], children: [] };
  const p = x.peer;
  $("sHead").innerHTML = p
    ? '<div class="head" style="display:flex;gap:12px;align-items:center">' + av(p.agent) + '<div style="min-width:0;flex:1"><div class="title ell" style="font-weight:650;font-size:15px">' + esc(folder(p.cwd)) + '</div><div class="small muted ell">' + esc(p.name) + "</div></div>" + dot(p.activity) + "</div>" +
      '<div class="kv"><span>status</span><span>' + esc(p.activity || "unknown") + "</span><span>folder</span><span>" + esc(p.cwd) + "</span><span>up</span><span>" + up(p.startedAt) + "</span>" +
      (p.sessionId ? "<span>session</span><span>" + esc(p.sessionId) + "</span>" : "") + "<span>version</span><span>" + esc(p.version || "?") + " " + versionChip(p) + "</span></div>" +
      (x.children.length ? '<div class="kids">' + x.children.map(childLine).join("") + "</div>" : "")
    : '<div class="head" style="display:flex;gap:12px;align-items:center">' + av("other") + '<div><div style="font-weight:650">' + esc(x.name) + '</div><div class="small muted">' +
      (x.name === "earlier runs" ? "Runs from before sessions were recorded, or from sessions in other folders." : "This session has ended. Its subagents are kept for reference.") + "</div></div></div>";
  $("sCount").innerHTML = x.groups.length ? countsLine(countGroups(x.groups)) : "";
  const sel = route.group && x.groups.find((g) => g.key === route.group) ? route.group : x.groups[0] && x.groups[0].key;
  // Running and recently finished subagents on top; older ones in a folded archive (the selected one stays visible).
  const fresh = (g) => g.status === "running" || Date.now() - g.updatedAt < ARCHIVE_AFTER_MS || g.key === sel;
  const active = x.groups.filter(fresh), archived = x.groups.filter((g) => !fresh(g));
  const archiveOpen = opened.has("archive:" + x.name);
  $("sGroups").innerHTML = x.groups.length
    ? (active.length ? active.map((g) => groupRow(g, g.key === sel, false)).join("") : '<div class="empty">Nothing running or recent.</div>') +
      (archived.length ? '<details class="archive" data-open="archive:' + esc(x.name) + '"' + (archiveOpen ? " open" : "") + '><summary>Archive · ' + archived.length + " older subagent" + (archived.length === 1 ? "" : "s") + "</summary>" + archived.map((g) => groupRow(g, false, false)).join("") + "</details>" : "")
    : '<div class="empty">No subagents started from this session yet.</div>';
  const mine = state.messages.filter((m) => m.from_name === x.name || m.to_target === x.name || String(m.recipients || "").split(", ").includes(x.name));
  $("sMsgs").innerHTML = messagesHtml(mine);
  const g = sel && model.groups.get(sel);
  if (g) void showGroup(g);
  else {
    $("cAvatar").innerHTML = ""; $("cTitle").textContent = "No subagent selected"; $("cSub").textContent = ""; $("cHint").classList.add("hidden");
    $("chat").innerHTML = '<div class="empty">Pick a subagent on the left to see its conversation.</div>'; lastChat = "";
  }
}

function messagesHtml(msgs) {
  return msgs.length ? msgs.slice(0, 100).map((m) =>
    '<div class="msg"><div class="meta"><b>' + esc(m.from_name) + "</b> → " + esc(m.recipients || m.to_target) + " · " + time(m.created_at) + "</div>" +
    '<div class="body">' + md(m.body) + "</div></div>").join("") : '<div class="empty">No messages yet.</div>';
}

function renderSendForm(inSession) {
  const form = $("send"), box = inSession ? $("sMsgs") : $("ovMsgs");
  if (form.previousElementSibling !== box) box.after(form);
  const to = $("to"), current = to.value;
  const names = model.sessions.filter((x) => x.live).map((x) => x.name);
  to.innerHTML = names.map((n) => "<option>" + esc(n) + "</option>").join("") + '<option value="*">everyone</option>';
  // Opening a session tab addresses that session; otherwise keep the user's choice.
  const want = inSession && route.session !== lastTo && names.includes(route.session) ? route.session : current;
  if ([...names, "*"].includes(want)) to.value = want;
  lastTo = inSession ? route.session : "";
}

/** Load (the rest of) every turn's log, then render the conversation. */
async function showGroup(g) {
  if (pulling) return;
  pulling = true;
  try {
    for (const r of g.turns) {
      let l = logs.get(r.name);
      if (!l) logs.set(r.name, (l = { raw: "", offset: 0, done: false }));
      if (l.done) continue;
      for (let i = 0; i < LOG_PAGES; i++) {
        const res = await fetch("/api/runs/" + encodeURIComponent(r.name) + "?from=" + l.offset);
        if (!res.ok) break;
        const d = await res.json();
        l.raw += d.text; l.offset = d.next;
        if (d.next >= d.size) break;
      }
      l.done = r.status !== "running";
    }
  } finally {
    pulling = false;
  }
  if (route.group && route.group !== g.key && model.groups.has(route.group)) return;
  renderConversation(g);
}

/** A turn's log: the task (header line, prompt, "---"), then the steps. */
function splitTurn(raw) {
  const m = /\\n *---\\n(?=\\d\\d:\\d\\d:\\d\\d started )/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw;
  const nl = head.indexOf("\\n");
  return { prompt: nl >= 0 ? head.slice(nl + 1).replace(/^ {9}/gm, "") : "", steps: m ? raw.slice(m.index + m[0].length) : "" };
}

function renderConversation(g) {
  const first = g.turns[0], last = g.turns[g.turns.length - 1];
  $("cAvatar").innerHTML = av(g.agent);
  $("cTitle").innerHTML = (g.title ? esc(g.title) + ' <span class="chip">' + esc(g.agent) + "</span>" : esc(g.agent)) + (g.model ? ' <span class="chip">' + esc(g.model) + "</span>" : "") + (g.effort ? " " + effortChip(g.effort) : "") + " " + pill(g.status, g.percent) + (g.progressNote && g.percent !== null ? ' <span class="small muted">' + esc(g.progressNote) + "</span>" : "");
  $("cSub").textContent = (g.owner === "earlier runs" ? "" : "started by " + g.owner + " · ") + time(first.startedAt) + " · " + (first.access || "default") + " access" + (first.workdir ? " · " + first.workdir : "");
  const hint = g.job && g.status !== "running"
    ? (g.status === "done" ? "Continue it with its context from " : "Recover it with its context from ") + esc(g.owner) + ': <code>message_subagent(job="' + esc(g.job) + '")</code>'
    : "";
  $("cHint").innerHTML = hint;
  $("cHint").classList.toggle("hidden", !hint);
  let n = 0;
  const html = g.turns.map((r, i) => {
    const t = splitTurn((logs.get(r.name) || { raw: "" }).raw);
    const id = r.name + ":task";
    const long = t.prompt.length > 600 && !opened.has(id);
    return (g.turns.length > 1 ? '<div class="turn">' + (i === 0 ? "Task" : "Follow-up " + i) + " · " + time(r.startedAt) + " · " + pill(r.status) + "</div>" : "") +
      '<div class="msgrow me">' + av(state.peers.find((p) => p.name === g.owner)?.agent || "other", true) +
      '<div class="bubble' + (long ? " clamp" : "") + '" data-open="' + esc(id) + '"><span class="who">' + (i === 0 ? esc(g.owner) : "follow-up from " + esc(g.owner)) + "</span>" + md(t.prompt.trim()) + "</div></div>" +
      stepsHtml(t.steps, g.agent, r.name, () => n++);
  }).join("");
  if (html === lastChat) return;
  lastChat = html;
  const chat = $("chat"), atEnd = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  chat.innerHTML = html;
  if ($("follow").checked && (atEnd || !chat.dataset.key || chat.dataset.key !== g.key)) chat.scrollTop = chat.scrollHeight;
  chat.dataset.key = g.key;
}

/** Log entries: "HH:MM:SS text" plus indented continuation lines. */
function parseEntries(text) {
  const out = [];
  for (const line of text.split("\\n")) {
    const m = /^(\\d\\d:\\d\\d:\\d\\d) (.*)$/.exec(line);
    if (m) out.push({ time: m[1], text: m[2] });
    else if (out.length && line.trim()) out[out.length - 1].text += "\\n" + line.replace(/^ {9}/, "");
  }
  return out;
}

/** "pwsh.exe -Command '...'" and friends: show just the command. */
function cleanCmd(s) {
  const m = /^"?[^"\\s]*?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\\.exe)?"?\\s+(?:-NoProfile\\s+|-NoLogo\\s+)*(?:-Command|-lc|-c|\\/c)\\s+([\\s\\S]*)$/i.exec(s.trim());
  if (!m) return s;
  let c = m[1].trim();
  if (/^'[\\s\\S]*'$|^"[\\s\\S]*"$/.test(c)) c = c.slice(1, -1);
  else if (/^['"]/.test(c)) c = c.slice(1);
  return c;
}

function stepsHtml(text, agent, run) {
  const items = [];
  for (const e of parseEntries(text)) {
    if (e.text.startsWith("answer: ")) { items.push({ kind: "answer", text: e.text.slice(8) }); continue; }
    if (/^(started|still working)/.test(e.text)) continue;
    if (/^progress \\d+%/.test(e.text)) { items.push({ kind: "sys", text: e.time.slice(0, 5) + " · " + e.text }); continue; }
    const live = /^(message from|answer to) ([^:]+): ([\\s\\S]*)$/.exec(e.text);
    if (live) { items.push({ kind: live[1] === "answer to" ? "say" : "live", who: live[2], text: live[3] }); continue; }
    if (/^finished after/.test(e.text)) { items.push({ kind: "sys", text: e.time.slice(0, 5) + " · " + e.text.replace(/ · (done|failed)$/, "").replace(/^finished/, "finished") }); continue; }
    const parts = e.text.split(" · ");
    const body = parts.slice(parts[1] && parts[1].startsWith("step ") ? 2 : 1).join(" · ");
    if (body.startsWith("says: ")) { items.push({ kind: "say", text: body.slice(6) }); continue; }
    const i = body.indexOf(": ");
    const k = i > 0 && i < 24 ? body.slice(0, i) : "";
    items.push({ kind: "step", time: e.time, label: k, text: cleanCmd(k ? body.slice(i + 2) : body) });
  }
  let html = "", buf = [], block = 0;
  const flush = () => {
    if (!buf.length) return;
    const rows = buf.map((s) => '<div class="step"><span class="t">' + esc(s.time.slice(0, 5)) + '</span>' + (s.label ? '<span class="k">' + esc(s.label) + "</span>" : "") + "<code title=\\"" + esc(s.text) + "\\">" + esc(s.text) + "</code></div>").join("");
    const id = run + ":steps:" + block++;
    html += buf.length > FOLD_STEPS
      ? '<div class="steps"><details data-open="' + esc(id) + '"' + (opened.has(id) ? " open" : "") + "><summary>" + buf.length + " steps · last: " + esc(buf[buf.length - 1].text.slice(0, 80)) + "</summary>" + rows + "</details></div>"
      : '<div class="steps">' + rows + "</div>";
    buf = [];
  };
  for (const it of items) {
    if (it.kind === "step") { buf.push(it); continue; }
    flush();
    if (it.kind === "sys") html += '<div class="sys">' + esc(it.text) + "</div>";
    else if (it.kind === "live") html += '<div class="msgrow me">' + av(state.peers.find((p) => p.name === it.who)?.agent || "other", true) + '<div class="bubble"><span class="who">' + esc(it.who) + " · while it works</span>" + md(it.text) + "</div></div>";
    else html += '<div class="msgrow">' + av(agent, true) + '<div class="bubble' + (it.kind === "answer" ? " answer" : "") + '">' + (it.kind === "answer" ? '<span class="who">Answer</span>' : "") + md(it.text) + "</div></div>";
  }
  flush();
  return html || '<div class="sys">Waiting for the first step…</div>';
}

document.addEventListener("toggle", (e) => {
  const id = e.target.dataset && e.target.dataset.open;
  if (id) e.target.open ? opened.add(id) : opened.delete(id);
}, true);
document.addEventListener("click", (e) => {
  const b = e.target.closest(".bubble.clamp");
  if (b) { opened.add(b.dataset.open); b.classList.remove("clamp"); }
});

async function poll() {
  try {
    const r = await fetch("/api/state");
    if (!r.ok) throw new Error(r.status === 403 ? "not authorized: open the link printed by agent-bridge ui" : "HTTP " + r.status);
    state = await r.json();
    $("status").innerHTML = state.brokerPid
      ? '<span class="dot idle"></span>bridge running · v' + esc(state.version)
      : '<span class="dot off"></span>no bridge running';
    render();
  } catch (e) {
    $("status").innerHTML = '<span class="dot" style="background:var(--bad)"></span>' + esc(e.message);
  }
}

$("send").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = $("body").value.trim(), to = $("to").value;
  if (!body || !to) return;
  $("sendBtn").disabled = true;
  try {
    const r = await fetch("/api/send", { method: "POST", headers: { "content-type": "application/json", "x-agent-bridge": "1" }, body: JSON.stringify({ to, body }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    $("sendInfo").textContent = d.deliveredTo?.length ? "Delivered to " + d.deliveredTo.join(", ") : "Queued for " + (d.queuedFor || []).join(", ");
    $("body").value = "";
    poll();
  } catch (err) {
    $("sendInfo").textContent = "Not sent: " + err.message;
  } finally {
    $("sendBtn").disabled = false;
  }
});

/** Auto follows the system; Light and Dark override it. Remembered in this browser. */
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    if (theme === "light" || theme === "dark") localStorage.setItem("ab-theme", theme);
    else localStorage.removeItem("ab-theme");
  } catch {}
  document.querySelectorAll("#theme button").forEach((b) => b.classList.toggle("on", b.dataset.theme === (theme || "auto")));
}
$("theme").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) applyTheme(b.dataset.theme);
});
applyTheme(document.documentElement.dataset.theme || "auto");
poll();
setInterval(poll, POLL_MS);
</script>
</body>
</html>
`;
