/**
 * The dashboard served by `agent-bridge ui`: one self-contained page, no external resources.
 * Overview of all sessions, plus a tab per session with the subagents it started, each shown as a
 * conversation (task, steps, answer, follow-ups).
 */
import { FAVICON_HREF, LOGO_SVG } from "./logo.js";
import { renderMarkdown } from "./markdown.js";
import { DEFAULT_NETWORK_PORT, NETWORK_NAME_PATTERN } from "../network/constants.js";

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
/*
 * A quiet instrument panel: cool neutral surfaces separated by tone rather than frames, one signal colour (teal)
 * for "live" and selection, and amber kept for what needs the owner (approvals, failures, warnings).
 */
:root {
  --bg: #edf0f2; --panel: #ffffff; --panel-2: #f4f6f7; --sunk: #e3e8eb; --text: #12171c; --muted: #56626b; --faint: #8a959e; --line: #d9dfe3;
  --accent: #0b7a83; --accent-soft: #daeff0; --on-accent: #ffffff; --ok: #2c7a47; --ok-soft: #e1f0e6; --warn: #a86400; --warn-soft: #f9ecd4;
  --bad: #b23d2b; --bad-soft: #f7e3de; --busy: #0b7a83; --busy-soft: #daeff0;
  --claude: #d97757; --codex: #12936f; --opencode: #4f6ef0; --other: #7d8a93;
  --shadow: 0 1px 0 rgba(18, 23, 28, .04);
  --pop: 0 16px 40px rgba(18, 23, 28, .16);
  --sans: "Segoe UI Variable Text", "Segoe UI Variable", "SF Pro Text", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161b20; --panel: #1e252b; --panel-2: #252d34; --sunk: #12171b; --text: #edf2f4; --muted: #b0bcc3; --faint: #8593a0; --line: #323d45;
    --accent: #4fcfd8; --accent-soft: #17414a; --on-accent: #062a2e; --ok: #6fd69a; --ok-soft: #173424; --warn: #f4bd55; --warn-soft: #3c2d12;
    --bad: #f48a77; --bad-soft: #43221c; --busy: #4fcfd8; --busy-soft: #17414a;
    --shadow: none; --pop: 0 18px 48px rgba(0, 0, 0, .5);
    color-scheme: dark;
  }
}
/* Chosen in the sidebar: dark regardless of the system. */
:root[data-theme="dark"] {
  --bg: #161b20; --panel: #1e252b; --panel-2: #252d34; --sunk: #12171b; --text: #edf2f4; --muted: #b0bcc3; --faint: #8593a0; --line: #323d45;
  --accent: #4fcfd8; --accent-soft: #17414a; --on-accent: #062a2e; --ok: #6fd69a; --ok-soft: #173424; --warn: #f4bd55; --warn-soft: #3c2d12;
  --bad: #f48a77; --bad-soft: #43221c; --busy: #4fcfd8; --busy-soft: #17414a;
  --shadow: none; --pop: 0 18px 48px rgba(0, 0, 0, .5);
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 var(--sans); font-feature-settings: "tnum" 0; -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
.wrap { max-width: 1320px; margin: 0 auto; padding: 0 24px; }
@media (max-width: 700px) { .wrap { padding: 0 16px; } }

/* App shell: sessions sidebar on the left (a drawer on narrow screens), content on the right. */
.app { display: grid; grid-template-columns: var(--side-w, 288px) minmax(0, 1fr); min-height: 100vh; }
.app.collapsed { --side-w: 0px; }
.app.collapsed .side { visibility: hidden; }
.side { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; background: var(--panel); border-right: 1px solid var(--line); min-width: 0; overflow: hidden; z-index: 30; }
.side-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 12px 10px 16px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 650; font-size: 15px; }
.logo { width: 28px; height: 28px; display: block; }
.logo svg { width: 100%; height: 100%; display: block; }
.icon-btn { background: transparent; color: var(--muted); border: 1px solid transparent; border-radius: 7px; padding: 3px 9px; font-size: 14px; font-weight: 500; line-height: 1.4; }
.icon-btn:hover { color: var(--text); background: var(--panel-2); border-color: var(--line); }
.side-search { padding: 0 12px 8px; }
.side-search input { width: 100%; padding: 7px 10px; font-size: 13px; background: var(--panel-2); }
.side-nav { display: flex; flex-direction: column; gap: 1px; padding: 0 8px 8px; border-bottom: 1px solid var(--line); }
.side-nav a, .tree-row { display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 7px; color: var(--muted); font-size: 13.5px; min-width: 0; }
.side-nav a:hover, .tree-row:hover { background: var(--panel-2); color: var(--text); }
.side-nav a.on { background: var(--accent-soft); color: var(--text); font-weight: 600; }
.side-nav .ico { width: 16px; text-align: center; color: var(--faint); }
.side-tree { flex: 1; overflow-y: auto; padding: 6px 8px 16px; scrollbar-width: thin; }
.tree-pc { display: flex; justify-content: space-between; padding: 12px 8px 4px; font-size: 11px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); }
.tree-sess { display: flex; align-items: center; gap: 2px; border-radius: 7px; }
.tree-sess:hover { background: var(--panel-2); }
.tree-sess.cur { background: var(--accent-soft); }
.tree-sess.ended { opacity: .6; }
.twist { flex: none; width: 22px; height: 26px; padding: 0; background: none; border: 0; color: var(--faint); font-size: 10px; cursor: pointer; transition: transform .12s; }
.twist[aria-expanded="true"] { transform: rotate(90deg); }
.twist:disabled { visibility: hidden; }
.tree-sess > a { flex: 1; display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 2px; min-width: 0; color: var(--text); font-size: 13.5px; }
.tree-sess.cur > a { font-weight: 600; }
.tree-sess .lbl { flex: 1; min-width: 0; }
.tree-sess .lbl small { display: block; font-size: 11.5px; color: var(--faint); font-weight: 400; }
.tree-kids { margin: 1px 0 4px 21px; padding-left: 9px; border-left: 1px solid var(--line); display: flex; flex-direction: column; gap: 1px; }
.tree-row { padding: 4px 8px; font-size: 12.5px; }
.tree-row.sel { background: var(--accent-soft); color: var(--text); font-weight: 600; }
.tree-row .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-row .meta { flex: none; font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
.tree-row.more { background: none; border: 0; font: inherit; font-size: 12px; color: var(--faint); cursor: pointer; text-align: left; }
.sdot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--faint); }
.sdot.running { background: var(--busy); animation: pulse 1.4s infinite; } .sdot.done { background: var(--ok); }
.sdot.failed { background: var(--bad); } .sdot.interrupted { background: var(--warn); }
.chip.own { color: var(--accent); background: var(--accent-soft); border-color: transparent; font-size: 10.5px; padding: 0 6px; }
.tree-row .ico { width: 12px; display: inline-flex; justify-content: center; color: var(--accent); }
.tree-empty { padding: 16px 8px; color: var(--faint); font-size: 12.5px; }
.side-foot { border-top: 1px solid var(--line); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.side-foot .theme { align-self: flex-start; }
.mbar { display: none; position: sticky; top: 0; z-index: 20; align-items: center; gap: 10px; height: 48px; padding: 0 12px; background: var(--panel); border-bottom: 1px solid var(--line); }
.app.collapsed .mbar { display: flex; }
.mtitle { font-weight: 600; font-size: 14px; }
.scrim { display: none; }
@media (max-width: 860px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  .side { position: fixed; left: 0; top: 0; bottom: 0; width: min(320px, 86vw); transform: translateX(-100%); transition: transform .18s ease; box-shadow: 0 0 40px rgba(0, 0, 0, .25); }
  .app.open .side { transform: none; visibility: visible; }
  .app.open .scrim { display: block; position: fixed; inset: 0; z-index: 25; background: rgba(0, 0, 0, .35); }
  .mbar { display: flex; }
  .app.collapsed .side { visibility: visible; }
}
.theme { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.theme button { background: transparent; color: var(--muted); border: 0; border-radius: 0; padding: 4px 10px; font-size: 12px; font-weight: 500; cursor: pointer; }
.theme button + button { border-left: 1px solid var(--line); }
.theme button.on { background: var(--accent-soft); color: var(--text); }
.conn { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--muted); }
.pc-head { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 650; color: var(--muted); margin-top: 6px; }
.pc-head:first-child { margin-top: 0; }
.pc-head::after { content: ""; flex: 1; height: 1px; background: var(--line); }
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
.linkbtn { margin-left: 8px; background: none; border: 0; padding: 0; color: var(--accent); font: inherit; font-size: 11.5px; text-transform: none; letter-spacing: 0; cursor: pointer; }
.linkbtn:disabled { color: var(--faint); cursor: default; }
.usage .card { display: flex; flex-direction: column; gap: 10px; }
.usage .head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.limit .top { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; }
.limit .top b { font-variant-numeric: tabular-nums; }
.limit .track { height: 6px; border-radius: 3px; background: var(--panel-2); border: 1px solid var(--line); overflow: hidden; margin: 4px 0 2px; }
.limit .track i { display: block; height: 100%; border-radius: 3px; background: var(--ok); }
.limit.warn .track i { background: var(--warn); } .limit.bad .track i { background: var(--bad); }
.limit.bad .top b { color: var(--bad); }
.chip.perm.low { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
.chip.perm.mid { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
.chip.perm.high { color: var(--bad); background: var(--bad-soft); border-color: transparent; font-weight: 600; }
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
select, textarea, button, input { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
textarea { flex: 1 1 220px; min-height: 40px; resize: vertical; }
button { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; cursor: pointer; padding: 8px 16px; }
button:disabled { opacity: .6; cursor: default; }
#sendInfo, #jobSendInfo { width: 100%; color: var(--muted); font-size: 12px; }
#sendInfo:empty, #jobSendInfo:empty { display: none; }
.model-list { max-height: 260px; overflow: auto; font-size: 12.5px; }
.model-list ul { padding-left: 18px; }

/* Network */
.net-card { padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }
.net-card h4 { margin: 0; font-size: 15px; font-weight: 650; }
.net-card p { margin: 0; color: var(--muted); font-size: 13px; }
.net-head { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: baseline; justify-content: space-between; }
.net-title { display: flex; align-items: center; gap: 9px; font-size: 16px; }
.net-two { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 16px; }
form.net-form { border: 0; background: none; padding: 0; gap: 12px 14px; align-items: flex-end; }
.net-form label { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; font-weight: 600; color: var(--muted); flex: 1 1 180px; min-width: 0; }
.net-form label.narrow { flex: 0 1 110px; }
.net-form label.check { flex-direction: row; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; color: var(--text); flex: 0 1 auto; padding-bottom: 9px; }
.net-form input:not([type="checkbox"]), .net-form select { width: 100%; padding: 7px 10px; font-weight: 400; }
.net-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.net-card .note { font-size: 12.5px; color: var(--muted); width: 100%; }
.net-card .note.ok { color: var(--ok); } .net-card .note.err { color: var(--bad); }
.net-card .note:empty { display: none; }
.net-fw { border-top: 1px solid var(--line); padding-top: 14px; display: flex; flex-direction: column; gap: 10px; font-size: 13px; }
.net-fw .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.cmds { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line); font-family: var(--mono); font-size: 11.5px; overflow-x: auto; white-space: pre; }
.confirm { padding: 12px 14px; border-radius: 10px; background: var(--warn-soft); display: flex; flex-direction: column; gap: 10px; }
.code { display: flex; gap: 8px; align-items: stretch; }
.code output { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 8px; background: var(--accent-soft); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; user-select: all; }
.steps-list { margin: 0; padding-left: 20px; font-size: 13px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
.steps-list b { color: var(--text); font-weight: 600; }
.found { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.found > div { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--line); }
.found > div:last-child { border-bottom: 0; }
.found .grow, .peer-row .grow { flex: 1; min-width: 0; }
.peer-row { display: flex; align-items: center; gap: 12px; padding: 13px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.peer-row:last-child { border-bottom: 0; }
.peer-row .acts { display: flex; gap: 6px; flex-wrap: wrap; }
button.danger { background: var(--bad); border-color: var(--bad); }
button.ghost.danger { background: transparent; color: var(--bad); border-color: var(--line); }
.big-ok { display: flex; gap: 10px; align-items: center; padding: 12px 14px; border-radius: 10px; background: var(--ok-soft); color: var(--ok); font-weight: 600; }
.disabled-hint { padding: 10px 12px; border-radius: 8px; background: var(--panel-2); color: var(--muted); font-size: 12.5px; }

/* Session view */
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); gap: 20px; align-items: start; }
.split > .side-col { order: 2; }
@media (max-width: 1180px) { .split { grid-template-columns: 1fr; } .conv { position: static; height: 72vh; } }
.side-col { display: flex; flex-direction: column; gap: 20px; }
.sess { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.kv { display: grid; grid-template-columns: 72px 1fr; gap: 4px 10px; font-size: 12.5px; }
.kv span:nth-child(odd) { color: var(--faint); }
.kv span:nth-child(even) { overflow-wrap: anywhere; }
.conv { display: flex; flex-direction: column; min-width: 0; height: calc(100vh - 56px); min-height: 480px; position: sticky; top: 28px; }
.conv-head { padding: 14px 18px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: center; }
.conv-head .grow { flex: 1; min-width: 0; }
.conv-head .title { font-weight: 650; font-size: 15px; display: flex; gap: 8px; align-items: center; }
.follow { font-size: 12px; color: var(--muted); display: flex; gap: 5px; align-items: center; white-space: nowrap; }
button.ghost { background: transparent; color: var(--muted); border-color: var(--line); font-weight: 500; font-size: 12.5px; padding: 4px 10px; }
button.ghost:hover, button.ghost[aria-expanded="true"] { color: var(--text); border-color: var(--accent); background: var(--accent-soft); }
.chip.next { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
/* Next-turn settings of a subagent */
form.settings { border-top: 0; border-bottom: 1px solid var(--line); padding: 12px 18px; gap: 10px 12px; align-items: flex-end; }
.settings label { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; font-weight: 600; color: var(--muted); flex: 1 1 150px; min-width: 0; }
.settings label.wide { flex-basis: 220px; }
.settings input, .settings select { width: 100%; padding: 6px 9px; font-size: 13px; font-weight: 400; }
.settings button[type="submit"] { padding: 6px 14px; }
.settings .note { width: 100%; font-size: 12px; color: var(--muted); }
.settings .note.err { color: var(--bad); }
.settings .note:empty { display: none; }
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

/* ---- Visual system: tone instead of frames, one live signal, attention in amber ---- */
::selection { background: var(--accent-soft); }
a:focus-visible, button:focus-visible, summary:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
input, select, textarea { background: var(--panel); border-color: var(--line); transition: border-color .12s; }
input:hover, select:hover, textarea:hover { border-color: color-mix(in srgb, var(--line) 50%, var(--muted)); }
button { background: var(--accent); color: var(--on-accent); border-color: var(--accent); border-radius: 8px; font-weight: 600; letter-spacing: .005em; }
button:hover:not(:disabled) { filter: brightness(1.06); }
button.ghost, .icon-btn { filter: none; }
h3 { text-transform: none; letter-spacing: 0; font-size: 14px; font-weight: 650; color: var(--text); margin-bottom: 10px; }
h3 .n { font-weight: 400; color: var(--faint); }
.panel { border-radius: 10px; box-shadow: var(--shadow); }
.block { margin-bottom: 36px; }
main.wrap { padding-top: 32px; max-width: 1240px; }

/* Sidebar: a darker strip; the selection is a tinted row with the live signal on its left edge. */
.side { background: var(--sunk); border-right-color: transparent; }
.brand { font-size: 15px; letter-spacing: -.01em; }
.side-search input { background: var(--panel); border-color: transparent; border-radius: 8px; padding: 7px 11px; }
.side-search input:focus { border-color: var(--accent); outline: none; }
.side-nav { border-bottom: 0; padding-bottom: 4px; }
.side-nav a { color: var(--muted); font-weight: 500; }
.side-nav a.on { background: var(--panel); color: var(--text); box-shadow: var(--shadow); }
.side-nav a .dot { margin-left: auto; }
.tree-pc { text-transform: none; letter-spacing: 0; font-size: 12px; font-weight: 600; color: var(--muted); padding: 16px 8px 6px; }
.tree-pc span:last-child { color: var(--faint); font-weight: 400; }
.tree-sess { position: relative; border-radius: 8px; }
.tree-sess:hover { background: color-mix(in srgb, var(--panel) 60%, transparent); }
.tree-sess.cur { background: var(--panel); box-shadow: var(--shadow); }
.tree-sess > a { font-weight: 550; }
.tree-sess .lbl small { margin-top: 1px; }
.tree-kids { border-left-color: color-mix(in srgb, var(--line) 70%, transparent); margin-left: 22px; }
.tree-row { position: relative; color: var(--muted); border-radius: 6px; }
.tree-row.sel { background: var(--panel); color: var(--text); box-shadow: var(--shadow); }
/* The one bold element: anything working carries a thin live bar on its left edge. */
.tree-row:has(.sdot.running)::before, .rows > a:has(.pill.running)::before { content: ""; position: absolute; left: -10px; top: 6px; bottom: 6px; width: 2px; border-radius: 2px; background: var(--accent); }
.rows > a:has(.pill.running)::before { left: 0; top: 0; bottom: 0; border-radius: 0; }
.tree-row.tree-chat .lbl { color: var(--text); font-weight: 500; }
.side-foot { border-top-color: color-mix(in srgb, var(--line) 70%, transparent); }
.theme { background: var(--panel); border-color: transparent; }
.theme button + button { border-left-color: var(--line); }
.theme button.on { background: var(--accent-soft); color: var(--text); font-weight: 600; }
.count { background: var(--accent-soft); color: var(--accent); border-radius: 6px; font-variant-numeric: tabular-nums; }

/* Status vocabulary */
.dot.busy { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.pill { border-radius: 6px; font-weight: 600; padding: 1px 8px; }
.pill.running { background: var(--accent-soft); color: var(--accent); }
.pill.failed, .pill.interrupted { background: var(--warn-soft); color: var(--warn); }
.pill.failed { background: var(--bad-soft); color: var(--bad); }
.chip { border-radius: 5px; border-color: transparent; background: var(--panel-2); }
.av { border-radius: 8px; font-weight: 700; letter-spacing: -.02em; }
.av.sm { width: 24px; height: 24px; border-radius: 6px; font-size: 11.5px; }

/* Overview: one figures strip instead of a card per number. */
#ovStats { display: flex; flex-wrap: wrap; gap: 0; background: var(--panel); border-radius: 10px; box-shadow: var(--shadow); overflow: hidden; }
#ovStats .stat { flex: 1 1 150px; background: none; border: 0; border-right: 1px solid var(--line); border-radius: 0; box-shadow: none; padding: 16px 20px; }
#ovStats .stat:last-child { border-right: 0; }
#ovStats .stat b { font-size: 26px; font-weight: 650; letter-spacing: -.02em; }
.card { border-color: transparent; border-radius: 10px; transition: border-color .12s; }
.card:hover { transform: none; border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.card.ended { border: 1px dashed var(--line); }
.card .stats { border-top-color: var(--panel-2); }
.rows > a { border-bottom-color: var(--panel-2); }
.rows > a.sel { box-shadow: none; }
.limit .track { background: var(--panel-2); border: 0; height: 5px; }

/* Conversation: the agent writes on the page like a document; your messages are bubbles on the right. */
.conv { border-radius: 12px; }
.conv-head { padding: 16px 22px; border-bottom-color: var(--panel-2); }
.conv-head .title { font-size: 16px; letter-spacing: -.01em; flex-wrap: wrap; }
.chat { padding: 24px 28px 32px; gap: 14px; }
.msgrow { max-width: min(780px, 100%); }
.msgrow:not(.me) { align-self: stretch; max-width: 780px; gap: 12px; }
.msgrow:not(.me) .bubble { background: none; border: 0; padding: 2px 0 0; line-height: 1.6; }
.msgrow:not(.me) .bubble.answer { background: var(--ok-soft); border-left: 3px solid var(--ok); border-radius: 4px 10px 10px 4px; padding: 10px 14px; }
.msgrow.me .bubble { background: var(--accent-soft); border: 0; border-radius: 14px 14px 4px 14px; padding: 10px 14px; }
.msgrow.me .bubble.clamp::before { background: linear-gradient(transparent, var(--accent-soft)); }
.bubble .who { font-weight: 600; color: var(--muted); }
.bubble pre, .msg .body pre { background: var(--panel-2); border-radius: 8px; }
.steps { margin-left: 12px; border-left: 1px solid var(--line); padding-left: 22px; width: min(780px, calc(100% - 12px)); }
.step .k { color: var(--accent); font-weight: 600; }
.chat .sys { align-self: flex-start; margin-left: 36px; color: var(--faint); font-size: 12px; }
.chat .turn { color: var(--faint); margin: 18px 0 4px; }
.hint { background: var(--warn-soft); color: var(--text); border-bottom: 0; }
form#jobSend { background: var(--panel); border-top-color: var(--panel-2); padding: 12px 16px; }
form#jobSend textarea { background: var(--panel-2); border-color: transparent; border-radius: 10px; }

/* Messages and the composer */
.msg { border-bottom-color: var(--panel-2); }
form#send { background: transparent; border-top: 0; padding: 12px 0 0; }

/* Pages: approvals and decisions */
.page-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px 24px; flex-wrap: wrap; margin-bottom: 20px; }
.page-head h2 { margin: 0 0 4px; font-size: 22px; font-weight: 650; letter-spacing: -.015em; }
.page-head p { margin: 0; max-width: 640px; font-size: 13.5px; }
/* Attention is amber, and only here. */
.count.attn { background: var(--warn-soft); color: var(--warn); }
.side-nav a.attn { color: var(--text); }
.side-nav a.attn .ico { color: var(--warn); font-weight: 800; }
.side-nav a .count { margin-left: auto; }
.attn-banner { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; padding: 12px 16px; border-radius: 10px; background: var(--warn-soft); color: var(--text); font-size: 13.5px; }
.attn-banner:hover .attn-go { text-decoration: underline; }
.attn-mark { flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--warn); color: var(--panel); font-weight: 800; font-size: 13px; }
.attn-go { margin-left: auto; font-weight: 600; color: var(--warn); white-space: nowrap; }
.ap-card { background: var(--panel); border-radius: 10px; box-shadow: var(--shadow); padding: 16px 18px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 10px; border-left: 3px solid var(--warn); }
.ap-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ap-head .grow { flex: 1; min-width: 0; }
.ap-time { flex: none; font-size: 12px; font-weight: 600; color: var(--warn); font-variant-numeric: tabular-nums; }
.ap-tool { font-size: 12px; color: var(--muted); font-family: var(--mono); }
.ap-card .cmds { max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.ap-reason { margin: 0; font-size: 13.5px; color: var(--text); }
.ap-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ap-actions .ap-why { flex: 1 1 260px; min-width: 0; padding: 7px 10px; }
.ap-note, .ap-done .note { font-size: 12.5px; margin: -4px 0 12px; }
.ap-done { margin-top: 18px; display: flex; flex-direction: column; gap: 4px; }
.note.ok { color: var(--ok); } .note.err { color: var(--bad); }
.dec-search { padding: 0 0 12px; max-width: 420px; }
.dec { padding: 16px 20px; border-bottom: 1px solid var(--panel-2); }
.dec:last-child { border-bottom: 0; }
.dec-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.dec-head h4 { margin: 0; font-size: 15px; font-weight: 650; }
.dec-text { max-width: 760px; line-height: 1.6; }
.dec-text p { margin: 0 0 .5em; } .dec-text > :last-child { margin-bottom: 0; }
.dec .linkbtn { margin: 8px 0 0; font-size: 12.5px; }
.dec-hist { margin-top: 10px; padding-left: 14px; border-left: 2px solid var(--line); display: flex; flex-direction: column; gap: 10px; color: var(--muted); }
.dec-hist p { margin: 2px 0 0; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<div class="app" id="app">
<aside class="side" id="side" aria-label="Sessions and subagents">
  <div class="side-top">
    <a class="brand" href="#/"><span class="logo">${LOGO_SVG}</span>agent-bridge</a>
    <button type="button" class="icon-btn" id="sideHide" title="Hide the sidebar" aria-label="Hide the sidebar">«</button>
  </div>
  <div class="side-search"><input id="sessFilter" type="search" placeholder="Search sessions and subagents" autocomplete="off" spellcheck="false" aria-label="Search sessions and subagents"></div>
  <nav class="side-nav">
    <a href="#/" id="tabOverview"><span class="ico" aria-hidden="true">▦</span>Overview</a>
    <a href="#/approvals" id="tabApprovals"><span class="ico" aria-hidden="true">!</span>Waiting for you</a>
    <a href="#/network" id="tabNet"><span class="ico" aria-hidden="true">⇄</span>Network</a>
    <a href="#/decisions" id="tabDecisions"><span class="ico" aria-hidden="true">✓</span>Decisions</a>
  </nav>
  <div class="side-tree" id="sideTree"></div>
  <div class="side-foot">
    <span class="conn" id="status">connecting…</span>
    <div class="theme" id="theme" role="group" aria-label="Theme"><button data-theme="auto">Auto</button><button data-theme="light">Light</button><button data-theme="dark">Dark</button></div>
  </div>
</aside>
<div class="scrim" id="scrim"></div>
<div class="main-col">
<div class="mbar" id="mbar"><button type="button" class="icon-btn" id="sideShow" aria-label="Show sessions" aria-controls="side">☰</button><span class="mtitle ell" id="mTitle">agent-bridge</span></div>

<main class="wrap">
  <div id="overview">
    <div id="ovAttn"></div>
    <div class="block stats" id="ovStats"></div>
    <div class="block"><h3>Usage left <span class="n" id="usageAt"></span><button class="linkbtn" id="usageRefresh" title="Read the limits again">refresh</button></h3><div id="ovUsage" class="cards usage"><div class="panel empty small muted">Reading the agents' limits…</div></div></div>
    <div class="block"><details><summary class="small muted">Available models</summary><div id="ovModels" class="cards usage"><div class="panel empty small muted">Open to read the available models.</div></div></details></div>
    <div class="block"><h3>Sessions <span class="n" id="ovCount"></span></h3><div id="ovSessions" class="cards"></div></div>
    <div class="block"><h3>Subagents <span class="n">working first, then newest finished</span></h3><div class="panel rows" id="ovRuns"></div></div>
    <div class="block" id="ovMsgBox"><h3>Messages</h3><div class="panel"><div id="ovMsgs" class="msgs"></div></div></div>
  </div>

  <div id="approvals" class="hidden">
    <div class="page-head">
      <div><h2>Waiting for you</h2><p class="muted">Subagents asking before they run something. Unanswered requests count as "deny" when their time runs out.</p></div>
      <button type="button" class="ghost" id="notifyBtn">Notify me in this browser</button>
    </div>
    <div id="apList"></div>
  </div>

  <div id="decisions" class="hidden">
    <div class="page-head">
      <div><h2>Decisions</h2><p class="muted">What you decided, as every session sees it. A newer decision on a topic replaces the older one, which stays in its history.</p></div>
    </div>
    <div class="side-search dec-search"><input id="decFilter" type="search" placeholder="Search topics and text" autocomplete="off" aria-label="Search decisions"></div>
    <div id="decList" class="panel"></div>
  </div>

  <div id="network" class="hidden">
    <div class="block"><div class="panel net-card">
      <div class="net-head">
        <div class="net-title"><span class="dot off" id="netDot"></span><b id="netState">Reading the network status…</b></div>
        <div class="small muted" id="netWhere"></div>
      </div>
      <p>Paired PCs can message each other's agents and send files. Traffic is encrypted, and only PCs you pair with a code can connect.</p>
      <form id="netConfig" class="net-form">
        <label>Name of this PC<input id="netName" maxlength="40" autocomplete="off" spellcheck="false" placeholder="e.g. office-pc"></label>
        <label>Reachable from<select id="netBind"><option value="0.0.0.0">Other PCs on this network</option><option value="127.0.0.1">This PC only (for testing)</option></select></label>
        <label class="narrow">Port<input id="netPort" type="number" min="1" max="65535"></label>
        <label class="check"><input type="checkbox" id="netDiscovery"> Find PCs automatically</label>
        <div class="net-actions"><button type="submit" id="netSave">Turn on</button><button type="button" class="ghost hidden" id="netOff">Turn off</button></div>
        <div class="note" id="netConfigInfo" role="status" aria-live="polite"></div>
      </form>
      <div class="net-fw hidden" id="netFw"></div>
    </div></div>
    <div class="block net-two">
      <div class="panel net-card" id="netShare"></div>
      <div class="panel net-card">
        <div><h4>Connect to another PC</h4><p>Enter the code shown on the other PC.</p></div>
        <div id="netFound"></div>
        <form id="netJoin" class="net-form">
          <label>Address<input id="netAddr" placeholder="192.168.1.20:48148" autocomplete="off" spellcheck="false"></label>
          <label>Pairing code<input id="netCode" type="password" autocomplete="off" spellcheck="false" placeholder="paste the code"></label>
          <div class="net-actions"><button type="submit" id="netJoinBtn">Connect</button></div>
          <div class="note" id="netJoinInfo" role="status" aria-live="polite"></div>
        </form>
      </div>
    </div>
    <div class="block"><h3>Paired PCs <span class="n" id="netPairedN"></span></h3><div class="panel" id="netPaired"></div></div>
  </div>

  <div id="session" class="split hidden">
    <div class="side-col">
      <div class="panel sess" id="sHead"></div>
      <div class="small muted" id="sCount"></div>
      <div id="sMsgBox"><h3>Messages</h3><div class="panel"><div id="sMsgs" class="msgs"></div></div></div>
    </div>
    <div class="panel conv">
      <div class="conv-head">
        <div id="cAvatar"></div>
        <div class="grow"><div class="title" id="cTitle">Conversation</div><div class="small muted ell" id="cSub"></div></div>
        <button type="button" class="ghost hidden" id="setToggle" aria-expanded="false" aria-controls="jobSettings" title="Model, effort and permission for its next turn">Settings</button>
        <label class="follow"><input type="checkbox" id="follow" checked> follow</label>
      </div>
      <form id="jobSettings" class="settings hidden" aria-label="Settings for the next turn">
        <label class="wide">Model<input id="setModel" list="setModels" autocomplete="off" spellcheck="false"><datalist id="setModels"></datalist></label>
        <label>Effort<select id="setEffort"></select></label>
        <label class="wide">Permission<select id="setPerm"></select></label>
        <button type="submit" id="setApply">Apply</button>
        <div class="note" id="setInfo" role="status" aria-live="polite"></div>
      </form>
      <div class="hint hidden" id="cHint"></div>
      <div id="chat" class="chat"></div>
      <form id="jobSend" class="hidden">
        <textarea id="jobBody" placeholder="Message this subagent" aria-label="Message this subagent"></textarea>
        <button type="submit" id="jobSendBtn">Send</button>
        <div id="jobSendInfo" role="status" aria-live="polite"></div>
      </form>
    </div>
  </div>
</main>

<form id="send">
  <select id="to" aria-label="Recipient"></select>
  <textarea id="body" placeholder="Message the session (sent as &quot;you&quot;)" aria-label="Message"></textarea>
  <button type="submit" id="sendBtn">Send</button>
  <div id="sendInfo"></div>
</form>
</div>
</div>

<script>
const POLL_MS = 1500;
const LOG_PAGES = 20;
/** Runs of more commands than this fold into one expandable row. */
const FOLD_STEPS = 3;
/** Finished subagents older than this move into the session's archive. */
const ARCHIVE_AFTER_MS = 30 * 60_000;
const NETWORK_HASH = "#/network", APPROVALS_HASH = "#/approvals", DECISIONS_HASH = "#/decisions";
/** Open approval requests are re-read this often (they expire into a "deny" after a few minutes). */
const APPROVALS_POLL_MS = 3000;
/** Network status refresh while the tab is open, and faster while a pairing code waits for the other PC. */
const NET_POLL_MS = 3000, NET_PAIR_POLL_MS = 1500;
const DEFAULT_NETWORK_PORT = ${DEFAULT_NETWORK_PORT};
const NETWORK_NAME = /${NETWORK_NAME_PATTERN.source}/;
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
    // Permission level as a chip, colored by what it allows: look only, edit its workspace, anything.
    function permChip(p) {
      const risk = { "read-only": "low", read: "low", ask: "low", default: "low", manual: "low", plan: "low", "workspace-write": "mid", edit: "mid", acceptEdits: "mid", "danger-full-access": "high", bypassPermissions: "high", "auto-approve": "high", auto: "high" }[p] || "mid";
      const tip = { low: "can look; changes need approval", mid: "can change files in its workspace", high: "no sandbox: can change anything your account can" }[risk];
      return '<span class="chip perm ' + risk + '" title="permission level: ' + tip + '">' + esc(p) + "</span>";
    }
    const pill = (status, percent) => '<span class="pill ' + status + '">' + (status === "running" ? (typeof percent === "number" ? "working · " + percent + "%" : "working") : status) + "</span>";

/** Next-turn settings the dashboard can change, per agent (the values message_subagent accepts). */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PERMISSIONS = {
  codex: { key: "sandbox", options: [["read-only", "read-only · looks only"], ["workspace-write", "workspace-write · edits its folder"], ["danger-full-access", "danger-full-access · no sandbox"]] },
  claude: { key: "permission_mode", options: [["manual", "manual · asks first"], ["plan", "plan · plans only"], ["acceptEdits", "acceptEdits · edits files"], ["auto", "auto · decides itself"], ["bypassPermissions", "bypassPermissions · anything"]] },
  opencode: { key: "auto_approve", options: [["false", "asks first"], ["true", "auto-approve · anything"]] },
};
/** The permission a job's saved settings give its next turn, named like the run's own permission. */
function nextPermission(next) {
  if (next.sandbox) return next.sandbox;
  if (next.permission_mode) return next.permission_mode;
  if (typeof next.auto_approve === "boolean") return next.auto_approve ? "auto-approve" : "ask";
  return "";
}
const nextOf = (g) => (g && g.job && state && state.jobs && state.jobs[g.job] && state.jobs[g.job].next) || {};
/** Saved settings that differ from what its current (or last) turn runs with. */
function pendingChips(g) {
  const next = nextOf(g), perm = nextPermission(next), out = [];
  if (next.model && next.model !== g.model) out.push("model " + next.model);
  if (next.effort && next.effort !== g.effort) out.push(next.effort + " effort");
  if (perm && perm !== g.permission) out.push(perm);
  return out.length ? ' <span class="chip next" title="saved; applies from its next turn">next turn: ' + esc(out.join(" · ")) + "</span>" : "";
}

let state = null, model = null, route = parseRoute(), pulling = false, lastChat = "";
let settingsGroup = null, modelLists = null;
/** Loaded run logs: name -> { raw, offset, done }. */
const logs = new Map();
/** Expanded step groups and bubbles survive re-renders. */
const opened = new Set();
const jobDrafts = new Map(), jobResults = new Map(), jobSending = new Set();
let composerGroup = null;

function parseRoute() {
  if (location.hash === NETWORK_HASH) return { session: null, group: null, network: true, page: "network" };
  if (location.hash === APPROVALS_HASH) return { session: null, group: null, page: "approvals" };
  if (location.hash === DECISIONS_HASH) return { session: null, group: null, page: "decisions" };
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
  if (route.network) void loadNetwork();
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
      // The level it really runs at; runs from before agent-bridge recorded it show their access.
      if (r.permission) g.permission = r.permission;
      else if (r.access && r.access !== "default" && !g.permission) g.permission = r.access;
    if (r.session) ofSession.set(r.session, key);
  }
  for (const g of groups.values()) {
    const last = g.turns[g.turns.length - 1];
    g.status = last.status; g.updatedAt = last.updatedAt; g.last = last.last; g.task = g.turns[0].task;
    g.startedAt = g.turns[0].startedAt;
    // The newest title: message_subagent(title=...) can rename a job between turns.
    g.title = ([...g.turns].reverse().find((t) => t.title) || {}).title || "";
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
  for (const x of model.sessions) if (hasNativeChat(x)) void loadNativeList(x);
  renderSide();
  const inSession = Boolean(route.session), inNetwork = Boolean(route.network), page = route.page || "";
  $("overview").classList.toggle("hidden", inSession || Boolean(page));
  $("session").classList.toggle("hidden", !inSession);
  $("network").classList.toggle("hidden", !inNetwork);
  $("approvals").classList.toggle("hidden", page !== "approvals");
  $("decisions").classList.toggle("hidden", page !== "decisions");
  if (inNetwork) renderNetwork();
  else if (page === "approvals") renderApprovals();
  else if (page === "decisions") renderDecisions();
  else if (inSession) renderSession();
  else renderOverview();
  renderSendForm(inSession);
}

/** Remote sessions are named "<pc>/<name>"; local ones have no PC part. */
const pcOf = (name) => { const i = String(name).indexOf("/"); return i > 0 ? name.slice(0, i) : ""; };
const shortName = (name) => { const i = String(name).indexOf("/"); return i > 0 ? name.slice(i + 1) : name; };
const LOCAL_PC = "This PC";
/** Subagents listed under a session before a "more" row. */
const SIDE_RECENT = 6;
const SIDE_TOGGLED_KEY = "ab-side-toggled", SIDE_COLLAPSED_KEY = "ab-side-collapsed";
/** Sessions whose fold state the user flipped (live ones start open, ended ones folded); kept in this browser. */
const sideToggled = new Set((() => { try { return JSON.parse(localStorage.getItem(SIDE_TOGGLED_KEY) || "[]"); } catch { return []; } })());
const saveSideToggled = () => { try { localStorage.setItem(SIDE_TOGGLED_KEY, JSON.stringify([...sideToggled])); } catch {} };
let lastTree = "";

const groupLabel = (g) => g.title || g.agent + " · " + (g.task || g.last || "subagent");
const groupMatches = (g, q) => [g.title, g.task, g.agent, g.model, g.job].some((s) => String(s || "").toLowerCase().includes(q));
const sessionMatches = (x, q) => x.name.toLowerCase().includes(q) || String((x.peer && x.peer.cwd) || "").toLowerCase().includes(q);
const sessionTitle = (x) => (x.peer ? folder(x.peer.cwd) : "") || shortName(x.name);

/** Live sessions grouped by PC (this PC first, busiest first), then ended sessions that have subagents. */
function sideGroups(q) {
  const keep = (x) => !q || sessionMatches(x, q) || x.groups.some((g) => groupMatches(g, q));
  const live = model.sessions.filter((x) => x.live && keep(x));
  const pcs = [...new Set(live.map((x) => pcOf(x.name)))].sort((a, b) => (a === "") !== (b === "") ? (a === "" ? -1 : 1) : a.localeCompare(b));
  const out = pcs.map((pc) => ({ title: pc || LOCAL_PC, items: live.filter((x) => pcOf(x.name) === pc).sort((a, b) => b.running - a.running || sessionTitle(a).localeCompare(sessionTitle(b))) }));
  const ended = model.sessions.filter((x) => !x.live && x.groups.length && keep(x));
  if (ended.length) out.push({ title: "Ended", items: ended });
  return out;
}

/* ---- The CLIs' own conversations and subagents, read from their transcripts (GET /api/sessions/...) ---- */
const CHAT_KEY = "~chat", NATIVE_PREFIX = "~native:";
/** Native subagent lists are re-read this often per session; the open chat follows like a run log. */
const NATIVE_LIST_MS = 10_000;
/** Chat items kept per conversation in the page (the oldest go first). */
const MAX_CHAT_ITEMS = 3000;
/** Session name -> { at, list } of its native subagents. */
const nativeLists = new Map();
/** "<session>|<key>" -> { items, byId, next, loading, error }. */
const chats = new Map();

/** Only sessions of this PC with a known CLI session have a transcript to read. */
const hasNativeChat = (x) => Boolean(x.live && x.peer && x.peer.sessionId && !pcOf(x.name));
function selectedKey(x) {
  if (route.group && route.group.startsWith("~")) return route.group;
  return route.group && x.groups.some((g) => g.key === route.group) ? route.group : x.groups[0] ? x.groups[0].key : hasNativeChat(x) ? CHAT_KEY : null;
}
const sessionApi = (name) => "/api/sessions/" + encodeURIComponent(name);

async function loadNativeList(x) {
  const cached = nativeLists.get(x.name);
  if (cached && Date.now() - cached.at < NATIVE_LIST_MS) return;
  nativeLists.set(x.name, { at: Date.now(), list: cached ? cached.list : [] });
  try {
    const r = await fetch(sessionApi(x.name) + "/subagents");
    if (!r.ok) return;
    const d = await r.json();
    nativeLists.set(x.name, { at: Date.now(), list: [...(d.subagents || [])].sort((a, b) => b.updatedAt - a.updatedAt) });
    if (model) renderSide();
  } catch {
    // Shown as no native subagents; the next round tries again.
  }
}

/** Fetch the new part of a transcript (several chunks when it is long) and merge it. */
async function pullChat(x, key) {
  const id = x.name + "|" + key;
  let c = chats.get(id);
  if (!c) chats.set(id, (c = { items: [], byId: new Map(), next: null, loading: false, error: "" }));
  if (c.loading) return c;
  c.loading = true;
  const url = key === CHAT_KEY ? sessionApi(x.name) + "/chat" : sessionApi(x.name) + "/subagents/" + encodeURIComponent(key.slice(NATIVE_PREFIX.length));
  try {
    for (let i = 0; i < LOG_PAGES; i++) {
      const r = await fetch(url + (c.next ? "?from=" + encodeURIComponent(c.next) : ""));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 409 ? "This session has not reported its CLI session yet: it appears after its next prompt." : d.error || "HTTP " + r.status);
      for (const item of d.items || []) {
        // opencode streams parts: a later version of the same item replaces the earlier one.
        if (item.id && c.byId.has(item.id)) c.items[c.byId.get(item.id)] = item;
        else { if (item.id) c.byId.set(item.id, c.items.length); c.items.push(item); }
      }
      if (c.items.length > MAX_CHAT_ITEMS) {
        c.items = c.items.slice(-MAX_CHAT_ITEMS);
        c.byId = new Map(c.items.flatMap((it, n) => (it.id ? [[it.id, n]] : [])));
      }
      const moved = d.next && d.next !== c.next;
      c.next = d.next || c.next;
      if (!moved || !(d.items || []).length) break;
    }
    c.error = "";
  } catch (err) {
    c.error = err.message;
  } finally {
    c.loading = false;
  }
  return c;
}

/** A transcript as chat: your prompts, the agent's answers, tool steps folded like a run log. */
function chatHtml(items, agent, session) {
  let html = "", buf = [], block = 0;
  const flush = () => {
    if (!buf.length) return;
    const rows = buf.map((s) => '<div class="step"><span class="t">' + esc(time(s.at)) + '</span><span class="k">' + esc(s.tool || "tool") + "</span><code title=\\"" + esc(s.summary || "") + "\\">" + esc(s.summary || "") + "</code></div>").join("");
    const id = session + ":native-steps:" + block++;
    html += buf.length > FOLD_STEPS
      ? '<div class="steps"><details data-open="' + esc(id) + '"' + (opened.has(id) ? " open" : "") + "><summary>" + buf.length + " steps · last: " + esc((buf[buf.length - 1].tool || "") + " " + (buf[buf.length - 1].summary || "").slice(0, 70)) + "</summary>" + rows + "</details></div>"
      : '<div class="steps">' + rows + "</div>";
    buf = [];
  };
  for (const it of items) {
    if (it.kind === "tool") { buf.push(it); continue; }
    flush();
    if (it.kind === "user") html += '<div class="msgrow me">' + av("other", true) + '<div class="bubble"><span class="who">You · ' + esc(time(it.at)) + "</span>" + md(it.text || "") + "</div></div>";
    else if (it.kind === "assistant") html += '<div class="msgrow">' + av(agent, true) + '<div class="bubble">' + md(it.text || "") + "</div></div>";
    else if (it.kind === "subagent" && it.subagent) html += '<div class="sys">↳ started its own subagent <a href="' + href(session, NATIVE_PREFIX + it.subagent.id) + '">' + esc(it.subagent.title || it.subagent.id) + "</a></div>";
  }
  flush();
  return html;
}

async function showNative(x, key) {
  const p = x.peer || {};
  const native = key.startsWith(NATIVE_PREFIX) ? ((nativeLists.get(x.name) || {}).list || []).find((s) => NATIVE_PREFIX + s.id === key) : null;
  $("cAvatar").innerHTML = av(p.agent || "other");
  $("cTitle").innerHTML = key === CHAT_KEY ? "Chat <span class=\\"chip\\">" + esc(p.agent || "") + "</span>" : esc((native && native.title) || "Subagent") + ' <span class="chip own">own subagent</span>';
  $("cSub").textContent = (key === CHAT_KEY ? "the session's own conversation" : "a subagent of " + p.agent + " itself") + " · read-only" + (p.cwd ? " · " + p.cwd : "");
  $("cHint").classList.add("hidden");
  const c = await pullChat(x, key);
  if (route.session !== x.name || route.group !== key) return;
  const body = c.error ? '<div class="empty">' + esc(c.error) + "</div>" : c.items.length ? chatHtml(c.items, p.agent || "other", x.name) : '<div class="empty">' + (c.loading ? "Loading…" : "Nothing in this conversation yet.") + "</div>";
  if (body === lastChat) return;
  lastChat = body;
  const chat = $("chat"), atEnd = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  chat.innerHTML = body;
  if ($("follow").checked && (atEnd || chat.dataset.key !== x.name + key)) chat.scrollTop = chat.scrollHeight;
  chat.dataset.key = x.name + key;
}

function sideSession(x, q) {
  const p = x.peer, searching = Boolean(q);
  const open = searching || (x.live !== sideToggled.has(x.name));
  const cur = x.name === route.session;
  const selKey = cur ? selectedKey(x) : null;
  const chat = hasNativeChat(x);
  let kids = searching && !sessionMatches(x, q) ? x.groups.filter((g) => groupMatches(g, q)) : x.groups;
  const all = searching || opened.has("side-all:" + x.name);
  const recent = kids.filter((g) => g.status === "running" || Date.now() - g.updatedAt < ARCHIVE_AFTER_MS || g.key === selKey);
  const shown = all ? kids : (recent.length ? recent : kids).slice(0, SIDE_RECENT);
  // The CLI's own subagents (read from its transcript), after agent-bridge's.
  const natives = chat ? ((nativeLists.get(x.name) || {}).list || []).filter((s) => !searching || sessionMatches(x, q) || String(s.title || "").toLowerCase().includes(q)) : [];
  const nativeRecent = natives.filter((s) => Date.now() - s.updatedAt < ARCHIVE_AFTER_MS || NATIVE_PREFIX + s.id === selKey);
  const nativeShown = all ? natives : nativeRecent.slice(0, SIDE_RECENT);
  const hidden = kids.length - shown.length + natives.length - nativeShown.length;
  const anyKids = chat || x.groups.length > 0;
  const sub = shortName(x.name) + (p ? " · " + (p.activity || "connected") : " · ended");
  const row = '<div class="tree-sess' + (cur ? " cur" : "") + (x.live ? "" : " ended") + '">' +
    '<button type="button" class="twist" data-fold="' + esc(x.name) + '" aria-expanded="' + open + '" aria-label="Show or hide its subagents"' + (anyKids ? "" : " disabled") + ">▶</button>" +
    '<a href="' + href(x.name) + '" title="' + esc(x.name + (p ? " · " + p.cwd : "")) + '"' + (cur ? ' aria-current="page"' : "") + ">" + (p ? dot(p.activity) : '<span class="dot off"></span>') +
    '<span class="lbl ell">' + esc(sessionTitle(x)) + '<small class="ell">' + esc(sub) + "</small></span>" +
    (x.running ? '<span class="count" title="subagents working">' + x.running + "</span>" : "") + "</a></div>";
  if (!open || !anyKids) return row;
  const chatRow = chat && (!searching || sessionMatches(x, q))
    ? '<a class="tree-row tree-chat' + (selKey === CHAT_KEY ? " sel" : "") + '" href="' + href(x.name, CHAT_KEY) + '" title="The session\\'s own conversation (read-only)"><span class="ico" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3.5 3v-3h-1.5z"/></svg></span><span class="lbl">Chat</span></a>'
    : "";
  const nativeRows = nativeShown.map((s) =>
    '<a class="tree-row' + (NATIVE_PREFIX + s.id === selKey ? " sel" : "") + '" href="' + href(x.name, NATIVE_PREFIX + s.id) + '" title="' + esc((s.title || "subagent") + " · its own subagent, read-only") + '">' +
    '<span class="sdot ' + esc(s.status) + '"></span><span class="lbl">' + esc(s.title || "subagent") + '</span><span class="chip own">own</span></a>').join("");
  const kidRows = chatRow + shown.map((g) => {
    const meta = g.status === "running" ? (g.percent !== null ? g.percent + "%" : "working") : ago(g.updatedAt).replace(" ago", "");
    return '<a class="tree-row' + (g.key === selKey ? " sel" : "") + '" href="' + href(x.name, g.key) + '" title="' + esc(groupLabel(g) + " · " + g.status) + '">' +
      '<span class="sdot ' + esc(g.status) + '"></span><span class="lbl">' + esc(groupLabel(g)) + '</span><span class="meta">' + esc(meta) + "</span></a>";
  }).join("");
  const more = hidden > 0 || (all && !searching && (kids.length > SIDE_RECENT || natives.length > nativeRecent.length))
    ? '<button type="button" class="tree-row more" data-more="' + esc(x.name) + '">' + (hidden > 0 ? hidden + " more" : "show fewer") + "</button>"
    : "";
  return row + '<div class="tree-kids">' + kidRows + nativeRows + more + "</div>";
}

function renderSide() {
  $("tabOverview").className = route.session || route.page ? "" : "on";
  $("tabNet").className = route.network ? "on" : "";
  $("tabApprovals").className = (route.page === "approvals" ? "on" : "") + (approvals.length ? " attn" : "");
  $("tabDecisions").className = route.page === "decisions" ? "on" : "";
  setHtml("tabNet", '<span class="ico" aria-hidden="true">⇄</span>Network' + networkTabDot());
  setHtml("tabApprovals", '<span class="ico" aria-hidden="true">!</span>Waiting for you' + (approvals.length ? '<span class="count attn">' + approvals.length + "</span>" : ""));
  const cur = route.session && model.byName.get(route.session);
  $("mTitle").textContent = route.network ? "Network" : route.page === "approvals" ? "Waiting for you" : route.page === "decisions" ? "Decisions" : route.session ? (cur ? sessionTitle(cur) : route.session) : "Overview";
  const q = $("sessFilter").value.trim().toLowerCase();
  const groups = sideGroups(q);
  const html = groups.length
    ? groups.map((pc) => '<div class="tree-pc"><span>' + esc(pc.title) + "</span><span>" + pc.items.length + "</span></div>" + pc.items.map((x) => sideSession(x, q)).join("")).join("")
    : '<div class="tree-empty">' + (q ? "Nothing matches." : "No sessions connected yet.") + "</div>";
  if (html !== lastTree) { lastTree = html; $("sideTree").innerHTML = html; }
}

const narrow = () => typeof matchMedia === "function" && matchMedia("(max-width: 860px)").matches;
function setSidebar(show) {
  const app = $("app");
  if (narrow()) { app.classList.toggle("open", show); return; }
  app.classList.toggle("collapsed", !show);
  try { show ? localStorage.removeItem(SIDE_COLLAPSED_KEY) : localStorage.setItem(SIDE_COLLAPSED_KEY, "1"); } catch {}
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
        '<div class="task">' + esc(g.agent) + (g.model ? " · " + esc(g.model) : "") + (g.effort ? " · " + esc(g.effort) + " effort" : "") + (g.permission ? " · " + esc(g.permission) : "") + (g.turns.length > 1 ? " · " + g.turns.length + " turns" : "") + "</div></div>"
      : '<div style="min-width:0"><div class="line1"><b>' + esc(g.agent) + "</b>" + (g.model ? '<span class="chip ell">' + esc(g.model) + "</span>" : "") + (g.effort ? effortChip(g.effort) : "") + (g.permission ? permChip(g.permission) : "") +
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
  renderApprovalBanner();
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
      (p ? "<span><b>" + up(p.startedAt) + "</b>connected</span>" : x.groups[0] ? "<span>last " + ago(x.groups[0].updatedAt) + "</span>" : "") + "</div>";
    const kids = x.children.length ? '<div class="kids">' + x.children.map(childLine).join("") + "</div>" : "";
    return '<a class="card' + (x.live ? "" : " ended") + '" href="' + href(x.name) + '">' + head + (p ? versionChip(p) : "") + kids + stats + "</a>";
  };
  // One heading per PC once sessions of paired PCs are online.
  const pcs = [...new Set(live.map((x) => pcOf(x.name)))].sort((a, b) => (a === "") !== (b === "") ? (a === "" ? -1 : 1) : a.localeCompare(b));
  const byPc = pcs.length > 1
    ? pcs.map((pc) => '<div class="pc-head">' + esc(pc || LOCAL_PC) + "</div>" + live.filter((x) => pcOf(x.name) === pc).map(card).join("")).join("")
    : live.map(card).join("");
  $("ovSessions").innerHTML =
    (live.length ? byPc : '<div class="panel empty">No sessions connected. Start Claude Code, Codex or opencode with agent-bridge installed.</div>') +
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
      '<div class="kv"><span>status</span><span>' + esc(p.activity || "unknown") + "</span><span>folder</span><span>" + esc(p.cwd) + "</span><span>connected</span><span>" + up(p.startedAt) + " ago</span>" +
      (p.sessionId ? "<span>session</span><span>" + esc(p.sessionId) + "</span>" : "") + "<span>version</span><span>" + esc(p.version || "?") + " " + versionChip(p) + "</span></div>" +
      (x.children.length ? '<div class="kids">' + x.children.map(childLine).join("") + "</div>" : "")
    : '<div class="head" style="display:flex;gap:12px;align-items:center">' + av("other") + '<div><div style="font-weight:650">' + esc(x.name) + '</div><div class="small muted">' +
      (x.name === "earlier runs" ? "Runs from before sessions were recorded, or from sessions in other folders." : "This session has ended. Its subagents are kept for reference.") + "</div></div></div>";
  $("sCount").innerHTML = x.groups.length ? countsLine(countGroups(x.groups)) : "";
  // The subagents themselves are listed in the sidebar under the session.
  const sel = route.group && x.groups.find((g) => g.key === route.group) ? route.group : x.groups[0] && x.groups[0].key;
  const mine = state.messages.filter((m) => m.from_name === x.name || m.to_target === x.name || String(m.recipients || "").split(", ").includes(x.name));
  $("sMsgs").innerHTML = messagesHtml(mine);
  const key = selectedKey(x);
  if (key && key.startsWith("~")) {
    renderJobForm(null);
    return void showNative(x, key);
  }
  const g = sel && model.groups.get(sel);
  renderJobForm(g);
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
  if (inSession && !names.includes(route.session)) names.push(route.session);
  to.innerHTML = names.map((n) => "<option>" + esc(n) + "</option>").join("") + '<option value="*">everyone</option>';
  // Opening a session tab addresses that session; otherwise keep the user's choice.
  const want = inSession ? route.session : current;
  if ([...names, "*"].includes(want)) to.value = want;
  to.disabled = inSession;
}

function renderJobForm(g) {
  const key = g && g.key;
  if (composerGroup !== key) {
    if (composerGroup) jobDrafts.set(composerGroup, $("jobBody").value);
    $("jobBody").value = jobDrafts.get(key) || "";
    composerGroup = key;
  }
  const controllable = Boolean(g && g.job && g.owner !== "earlier runs");
  $("jobSend").classList.toggle("hidden", !controllable);
  $("jobSendBtn").disabled = jobSending.has(key);
  $("jobSendInfo").textContent = (jobResults.get(key) || []).at(-1) || "";
  renderSettings(controllable ? g : null);
}

/** The settings row: emptied when another subagent is selected; empty fields keep what it has. */
function renderSettings(g) {
  const toggle = $("setToggle"), form = $("jobSettings");
  toggle.classList.toggle("hidden", !g);
  if (!g) { form.classList.add("hidden"); toggle.setAttribute("aria-expanded", "false"); settingsGroup = null; return; }
  if (settingsGroup === g.key) return;
  settingsGroup = g.key;
  const perm = PERMISSIONS[g.agent];
  $("setModel").value = "";
  $("setModel").placeholder = "keep: " + (g.model || "its default");
  $("setEffort").innerHTML = '<option value="">keep: ' + esc(g.effort || "default") + "</option>" + EFFORTS.map((e) => "<option>" + e + "</option>").join("");
  $("setPerm").innerHTML = perm ? '<option value="">keep: ' + esc(g.permission || "default") + "</option>" + perm.options.map((o) => '<option value="' + o[0] + '">' + esc(o[1]) + "</option>").join("") : "";
  $("setPerm").disabled = !perm;
  $("setInfo").textContent = "";
  $("setInfo").classList.remove("err");
  fillModels(g.agent);
}

/** Model suggestions from /api/models (read once, when the settings are first opened). */
async function fillModels(agent) {
  if (settingsHidden()) return;
  if (!modelLists) {
    modelLists = fetch("/api/models").then((r) => (r.ok ? r.json() : { reports: [] })).then((d) => d.reports || []).catch(() => []);
  }
  const reports = await modelLists;
  const rep = reports.find((r) => r.agent === agent);
  if (settingsGroup && model && model.groups.get(settingsGroup) && model.groups.get(settingsGroup).agent === agent) {
    $("setModels").innerHTML = (rep ? rep.models : []).map((m) => '<option value="' + esc(m) + '"></option>').join("");
  }
}
const settingsHidden = () => $("jobSettings").classList.contains("hidden");

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
  $("cTitle").innerHTML = (g.title ? esc(g.title) + ' <span class="chip">' + esc(g.agent) + "</span>" : esc(g.agent)) + (g.model ? ' <span class="chip">' + esc(g.model) + "</span>" : "") + (g.effort ? " " + effortChip(g.effort) : "") + (g.permission ? " " + permChip(g.permission) : "") + pendingChips(g) + " " + pill(g.status, g.percent) + (g.progressNote && g.percent !== null ? ' <span class="small muted">' + esc(g.progressNote) + "</span>" : "");
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
  }).join("") + (jobResults.get(g.key) || []).map((text) => '<div class="sys">' + esc(text) + "</div>").join("");
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

/** Whether one of the last few items already shows this message (the same reply logged twice). */
function sameSay(items, text) {
  const t = text.trim();
  return items.slice(-3).some((it) => it.kind === "say" && it.text.trim() === t);
}

function stepsHtml(text, agent, run) {
  const items = [];
  for (const e of parseEntries(text)) {
    if (e.text.startsWith("answer: ")) {
      // The final answer is usually also the agent's last message ("says:"): keep only the answer.
      const ans = e.text.slice(8).trim();
      for (let j = items.length - 1; j >= Math.max(0, items.length - 4); j--) if (items[j].kind === "say" && items[j].text.trim() === ans) items.splice(j, 1);
      items.push({ kind: "answer", text: e.text.slice(8) });
      continue;
    }
    if (/^(started|still working)/.test(e.text)) continue;
    if (/^progress \\d+%/.test(e.text)) { items.push({ kind: "sys", text: e.time.slice(0, 5) + " · " + e.text }); continue; }
    const live = /^(message from|answer to) ([^:]+): ([\\s\\S]*)$/.exec(e.text);
    if (live) {
      // A running Codex job's answer is also logged as its own message ("says:"): show it once.
      if (live[1] === "answer to" && sameSay(items, live[3])) continue;
      items.push({ kind: live[1] === "answer to" ? "say" : "live", who: live[2], text: live[3] });
      continue;
    }
    if (/^finished after/.test(e.text)) { items.push({ kind: "sys", text: e.time.slice(0, 5) + " · " + e.text.replace(/ · (done|failed)$/, "").replace(/^finished/, "finished") }); continue; }
    const parts = e.text.split(" · ");
    const body = parts.slice(parts[1] && parts[1].startsWith("step ") ? 2 : 1).join(" · ");
    if (body.startsWith("says: ")) {
      if (!sameSay(items, body.slice(6))) items.push({ kind: "say", text: body.slice(6) });
      continue;
    }
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

/** Each agent's account limits as bars of what is left (read by the server from the CLIs, cached a few minutes). */
async function loadUsage(refresh) {
  const btn = $("usageRefresh");
  btn.disabled = true;
  btn.textContent = "reading…";
  try {
    const r = await fetch("/api/usage" + (refresh ? "?refresh=1" : ""));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const u = await r.json();
    $("ovUsage").innerHTML = u.reports.map(usageCard).join("");
    $("usageAt").textContent = "as of " + new Date(u.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (err) {
    $("ovUsage").innerHTML = '<div class="panel empty small muted">Could not read usage: ' + esc(err.message) + "</div>";
  } finally {
    btn.disabled = false;
    btn.textContent = "refresh";
  }
}
function modelsCard(rep) {
  return '<div class="card"><div class="head">' + av(rep.agent, true) + esc(rep.agent) + '</div><div class="small muted">Default: ' + esc(rep.defaultModel || rep.agent + "'s own default") + '</div><div class="model-list">' + md(rep.lines.join("\\n")) + "</div></div>";
}
async function loadModels() {
  try {
    const r = await fetch("/api/models");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    $("ovModels").innerHTML = data.reports.map(modelsCard).join("");
  } catch (err) {
    $("ovModels").innerHTML = '<div class="panel empty small muted">Could not read models: ' + esc(err.message) + "</div>";
  }
}
function usageCard(rep) {
  const body = rep.limits.length
    ? rep.limits.map((l) => {
        const left = Math.max(0, Math.min(100, 100 - l.usedPercent));
        return '<div class="limit ' + (left < 10 ? "bad" : left < 30 ? "warn" : "") + '"><div class="top"><span>' + esc(l.name) + "</span><b>" + left + "% left</b></div>" +
          '<div class="track"><i style="width:' + left + '%"></i></div>' + (l.resets ? '<div class="small muted">resets ' + esc(l.resets) + "</div>" : "") + "</div>";
      }).join("")
    : rep.lines.slice(0, 2).map((x) => '<div class="small muted">' + esc(x) + "</div>").join("");
  const credits = rep.credits
    ? '<div class="limit"><div class="top"><span>credits' + (rep.credits.inUse ? ' <span class="chip">in use</span>' : "") + "</span><b>" + esc(rep.credits.balance) + "</b></div>" +
      (rep.credits.inUse ? '<div class="small muted">a limit is reached; work continues on credits</div>' : "") + "</div>"
    : "";
  return '<div class="card"><div class="head">' + av(rep.agent, true) + esc(rep.agent) + "</div>" + body + credits + "</div>";
}

async function poll() {  try {
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

$("jobSend").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = composerGroup, g = model.groups.get(key), body = $("jobBody").value.trim();
  if (!body || !g || !g.job || jobSending.has(key)) return;
  const run = g.turns[g.turns.length - 1].name;
  jobSending.add(key);
  renderJobForm(g);
  let result;
  try {
    const r = await fetch("/api/subagents/message", { method: "POST", headers: { "content-type": "application/json", "x-agent-bridge": "1" }, body: JSON.stringify({ run, body }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || d.text || "HTTP " + r.status);
    result = d.text;
    jobDrafts.delete(key);
    if (composerGroup === key && $("jobBody").value.trim() === body) $("jobBody").value = "";
    void poll();
  } catch (err) {
    result = "Message error: " + err.message;
  } finally {
    jobSending.delete(key);
    jobResults.set(key, [...(jobResults.get(key) || []), result]);
    if (composerGroup === key) {
      renderJobForm(g);
      renderConversation(g);
    }
  }
});

$("setToggle").addEventListener("click", () => {
  const open = settingsHidden();
  $("jobSettings").classList.toggle("hidden", !open);
  $("setToggle").setAttribute("aria-expanded", String(open));
  if (open && settingsGroup) {
    const g = model && model.groups.get(settingsGroup);
    if (g) void fillModels(g.agent);
  }
});

/** Only the fields the user set; a turn already running keeps its own settings. */
function chosenSettings(agent) {
  const out = {}, modelName = $("setModel").value.trim(), effort = $("setEffort").value, perm = $("setPerm").value, spec = PERMISSIONS[agent];
  if (modelName) out.model = modelName;
  if (effort) out.effort = effort;
  if (perm && spec) out[spec.key] = spec.key === "auto_approve" ? perm === "true" : perm;
  return out;
}

$("jobSettings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = settingsGroup, g = key && model.groups.get(key);
  if (!g || !g.job) return;
  const settings = chosenSettings(g.agent), info = $("setInfo");
  info.classList.remove("err");
  if (!Object.keys(settings).length) { info.textContent = "Nothing to change: pick a model, effort or permission."; return; }
  $("setApply").disabled = true;
  let result;
  try {
    const r = await fetch("/api/subagents/settings", { method: "POST", headers: { "content-type": "application/json", "x-agent-bridge": "1" }, body: JSON.stringify({ run: g.turns[g.turns.length - 1].name, settings }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || d.text || "HTTP " + r.status);
    result = d.text;
    if (settingsGroup === key) {
      settingsGroup = null;
      renderSettings(g);
      info.textContent = result;
    }
    void poll();
  } catch (err) {
    result = "Settings not saved: " + err.message;
    if (settingsGroup === key) { info.textContent = result; info.classList.add("err"); }
  } finally {
    $("setApply").disabled = false;
    jobResults.set(key, [...(jobResults.get(key) || []), result]);
    if (composerGroup === key) renderConversation(g);
  }
});

/* ---- Network: this PC's settings, pairing codes, paired PCs (see docs/network.md) ---- */
let net = null, netError = "", netLoadedAt = 0, netLoading = false, netFormFilled = false;
/** The pairing code shown here: { code, expiresAt, before: ids paired before it, done: name of the PC that used it }. */
let invite = null;
let fw = null, fwAsked = false, fwConfirm = false, fwBusy = false, unlinkAsk = null;
const peerNotes = new Map();
const lastNetHtml = {};

const netPost = async (action, body) => {
  const r = await fetch("/api/network/" + action, { method: "POST", headers: { "content-type": "application/json", "x-agent-bridge": "1" }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
  return d;
};
const inviteActive = () => Boolean(invite && !invite.done && invite.expiresAt > Date.now());
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
/** Replace a block only when it changed, so buttons keep focus between refreshes. */
function setHtml(id, html) {
  if (lastNetHtml[id] === html) return;
  lastNetHtml[id] = html;
  $(id).innerHTML = html;
}
function networkTabDot() {
  if (!net || !net.enabled) return '<span class="dot off"></span>';
  return '<span class="dot ' + (net.paired.some((p) => p.connected) ? "idle" : "busy") + '"></span>';
}

async function loadNetwork() {
  if (netLoading) return;
  netLoading = true;
  try {
    const r = await fetch("/api/network");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    net = d;
    netError = "";
    if (invite && !invite.done) {
      const fresh = net.paired.find((p) => !invite.before.has(p.id));
      if (fresh) invite.done = fresh.name;
    }
  } catch (err) {
    netError = err.message;
  } finally {
    netLoading = false;
    netLoadedAt = Date.now();
  }
  if (model) renderSide();
  if (route.network) renderNetwork();
}

function renderNetwork() {
  const n = net, cfg = n && n.config;
  if (!n) {
    $("netDot").className = "dot off";
    $("netState").textContent = netError ? "No bridge running" : "Reading the network status…";
    $("netWhere").textContent = netError ? "Start a Claude Code, Codex or opencode session with agent-bridge, then reload." : "";
  } else {
    $("netDot").className = "dot " + (n.enabled ? "idle" : "off");
    $("netState").textContent = n.enabled ? "Networking is on" + (n.identity ? " as " + n.identity.name : "") : "Networking is off";
    const local = cfg.bind === "127.0.0.1";
    const addrs = (n.addresses || []).map((a) => a + ":" + (n.port || cfg.port));
    $("netWhere").textContent = n.enabled
      ? [local ? "reachable from this PC only" : addrs.length ? "other PCs connect to " + addrs.join(" or ") : "port " + (n.port || cfg.port), cfg.discovery ? "finding PCs automatically" : ""].filter(Boolean).join(" · ")
      : "Turn it on to connect this PC with others on your network.";
    if (!netFormFilled) fillNetForm(n);
  }
  $("netSave").textContent = n && n.enabled ? "Save" : "Turn on";
  $("netSave").disabled = !n;
  $("netOff").classList.toggle("hidden", !(n && n.enabled));
  renderFirewall();
  renderShare();
  renderFound();
  renderPaired();
  $("netJoinBtn").disabled = !(n && n.enabled);
}

function fillNetForm(n) {
  const cfg = n.config;
  $("netName").value = cfg.name || "";
  // Not yet on: suggest what pairing needs (other PCs can reach it, discovery on).
  $("netBind").value = n.enabled && cfg.bind === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0";
  $("netPort").value = String(cfg.port || DEFAULT_NETWORK_PORT);
  $("netDiscovery").checked = n.enabled ? Boolean(cfg.discovery) : true;
  netFormFilled = true;
}

function renderFirewall() {
  const n = net, box = $("netFw");
  const show = Boolean(n && n.enabled && n.config.bind !== "127.0.0.1");
  box.classList.toggle("hidden", !show);
  if (!show) return;
  if (!fw && !fwAsked) void loadFirewall(false);
  let html;
  if (!fw) html = '<div class="row muted"><span class="dot off"></span>Checking the firewall…</div>';
  else if (fw.status.state === "allowed") html = '<div class="row"><span class="dot idle"></span><span>Firewall: other PCs can reach this one.</span> <span class="small muted">' + esc(fw.status.detail) + "</span></div>";
  else {
    const win = fw.plan.platform === "win32";
    html = '<div class="row"><span class="dot busy"></span><b>The firewall may block other PCs.</b> <span class="small muted">' + esc(fw.status.detail) + "</span></div>" +
      '<div class="small muted">' + esc(fw.plan.explanation) + "</div>" +
      (fwConfirm
        ? '<div class="confirm"><div><b>Add these firewall rules?</b> Windows asks for administrator permission next.</div><pre class="cmds">' + esc(fw.plan.commands.join("\\n")) + '</pre><div class="net-actions"><button type="button" data-act="fw-apply"' + (fwBusy ? " disabled" : "") + ">" + (fwBusy ? "Waiting for Windows…" : "Add rules") + '</button><button type="button" class="ghost" data-act="fw-cancel">Cancel</button></div></div>'
        : '<details><summary class="small muted">' + (win ? "Rules it adds" : "Run these in a terminal") + '</summary><pre class="cmds">' + esc(fw.plan.commands.join("\\n")) + "</pre></details>" +
          '<div class="net-actions">' + (win ? '<button type="button" data-act="fw-ask">Open the ports…</button>' : '<button type="button" class="ghost" data-act="fw-copy">Copy commands</button>') + '<button type="button" class="ghost" data-act="fw-check">Check again</button></div>');
  }
  setHtml("netFw", html + '<div class="note" id="netFwInfo"></div>');
}

async function loadFirewall(apply) {
  fwAsked = true;
  try {
    fw = await netPost("firewall", apply ? { apply: true, confirm: true } : {});
    fwConfirm = false;
  } catch (err) {
    fw = fw || { plan: { platform: "", commands: [], explanation: "" }, status: { state: "unknown", detail: err.message } };
    if (apply) fw.status = { state: "unknown", detail: "Rules not added: " + err.message };
  }
  fwBusy = false;
  if (route.network) renderNetwork();
}

function renderShare() {
  const n = net;
  const head = '<div><h4>Let another PC connect</h4><p>Create a one-time code here and enter it on the other PC. It works once and expires after 10 minutes.</p></div>';
  let body;
  if (!n || !n.enabled) body = '<div class="disabled-hint">Turn on networking above first.</div>';
  else if (invite && invite.done) body = '<div class="big-ok">✓ Connected to ' + esc(invite.done) + '</div><div class="net-actions"><button type="button" class="ghost" data-act="pair">Create another code</button></div>';
  else if (inviteActive()) {
    const addrs = (n.addresses || []).map((a) => a + ":" + (n.port || n.config.port));
    body = '<div class="code"><output id="netCodeText">' + esc(invite.code) + '</output><button type="button" data-act="copy-code">Copy</button></div>' +
      '<div class="small muted"><span class="pill running">waiting for the other PC</span> expires in <b id="netCountdown">' + mmss(invite.expiresAt - Date.now()) + "</b></div>" +
      '<ol class="steps-list"><li>On the other PC, open the agent-bridge dashboard and go to <b>Network</b>.</li>' +
      "<li>Under <b>Connect to another PC</b>, pick <b>" + esc(n.identity ? n.identity.name : "this PC") + "</b>" + (addrs.length ? " or enter <b>" + esc(addrs[0]) + "</b>" : "") + ".</li>" +
      "<li>Paste the code and press <b>Connect</b>.</li></ol>" +
      '<div class="small faint">Anyone with this code can pair once. Share it only with your own PCs.</div>';
  } else body = (invite ? '<div class="note err">That code expired without being used.</div>' : "") + '<div class="net-actions"><button type="button" data-act="pair">Create pairing code</button></div>';
  setHtml("netShare", head + body + '<div class="note" id="netShareInfo"></div>');
}

function renderFound() {
  const n = net;
  if (!n || !n.enabled) return setHtml("netFound", "");
  const paired = new Set(n.paired.map((p) => p.id));
  const found = n.discovered.filter((d) => !paired.has(d.id));
  setHtml("netFound", !n.config.discovery
    ? '<div class="small muted">Finding PCs automatically is off: enter the address shown on the other PC.</div>'
    : found.length
      ? '<div class="found">' + found.map((d) => '<div><span class="dot idle"></span><div class="grow"><b>' + esc(d.name) + '</b><div class="small muted">' + esc(d.host + ":" + d.port) + " · seen " + ago(d.seenAt) + '</div></div><button type="button" class="ghost" data-act="use" data-addr="' + esc(d.host + ":" + d.port) + '">Use</button></div>').join("") + "</div>"
      : '<div class="small muted">No other PCs found yet. The other PC needs networking on with “Find PCs automatically”, or enter its address.</div>');
}

function renderPaired() {
  const n = net;
  const list = n ? n.paired : [];
  $("netPairedN").textContent = list.length || "";
  setHtml("netPaired", list.length
    ? list.map((p) => {
        const h = p.health, note = peerNotes.get(p.id);
        const status = p.connected ? "online" : "offline";
        const health = p.connected && h ? " · checked " + ago(h.lastVerifiedAt) + " · " + h.roundTripMs + " ms" : "";
        const acts = unlinkAsk === p.id
          ? '<span class="small">Unlink ' + esc(p.name) + '? Pairing again needs a new code.</span><button type="button" class="danger" data-act="unlink" data-id="' + esc(p.id) + '">Unlink</button><button type="button" class="ghost" data-act="unlink-cancel">Keep</button>'
          : '<button type="button" class="ghost" data-act="verify" data-id="' + esc(p.id) + '"' + (p.connected ? "" : " disabled") + '>Check</button><button type="button" class="ghost danger" data-act="unlink-ask" data-id="' + esc(p.id) + '">Unlink</button>';
        return '<div class="peer-row"><span class="dot ' + (p.connected ? "idle" : "off") + '"></span><div class="grow"><b>' + esc(p.name) + '</b><div class="small muted">' + status + health + ' · key <code>' + esc(p.fingerprint.slice(0, 12)) + "</code></div>" +
          (note ? '<div class="small ' + (note.err ? "" : "muted") + '" style="' + (note.err ? "color:var(--bad)" : "") + '">' + esc(note.text) + "</div>" : "") + '</div><div class="acts">' + acts + "</div></div>";
      }).join("")
    : '<div class="empty">No paired PCs yet. Create a code on one PC and enter it on the other.</div>');
}

const noteEl = (id, text, kind) => { const el = $(id); if (el) { el.textContent = text; el.className = "note" + (kind ? " " + kind : ""); } };

$("netConfig").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("netName").value.trim(), port = Number($("netPort").value);
  if (!NETWORK_NAME.test(name)) return noteEl("netConfigInfo", "Use 1-64 letters, digits, dots, dashes or underscores for the name, starting with a letter or digit.", "err");
  if (!Number.isInteger(port) || port < 1 || port > 65535) return noteEl("netConfigInfo", "The port must be a number from 1 to 65535.", "err");
  $("netSave").disabled = true;
  noteEl("netConfigInfo", "Saving and restarting the network listener…");
  try {
    const d = await netPost("configure", { confirm: true, enabled: true, name, bind: $("netBind").value, port, discovery: $("netDiscovery").checked });
    net = { ...d, addresses: net && net.addresses };
    netFormFilled = false;
    fw = null; fwAsked = false;
    noteEl("netConfigInfo", "Saved. Networking is on.", "ok");
  } catch (err) {
    noteEl("netConfigInfo", "Not saved: " + err.message, "err");
  } finally {
    $("netSave").disabled = false;
  }
  void loadNetwork();
});

$("netOff").addEventListener("click", async () => {
  $("netOff").disabled = true;
  try {
    await netPost("configure", { confirm: true, enabled: false });
    invite = null;
    noteEl("netConfigInfo", "Networking is off. Paired PCs stay paired and reconnect when you turn it on again.", "ok");
  } catch (err) {
    noteEl("netConfigInfo", "Could not turn it off: " + err.message, "err");
  } finally {
    $("netOff").disabled = false;
  }
  void loadNetwork();
});

$("netJoin").addEventListener("submit", async (e) => {
  e.preventDefault();
  let address = $("netAddr").value.trim();
  const code = $("netCode").value.trim();
  if (!address || !code) return noteEl("netJoinInfo", "Enter the other PC's address and its pairing code.", "err");
  // A bare host or IPv4 address: the default port.
  if (!address.includes(":")) address += ":" + DEFAULT_NETWORK_PORT;
  $("netJoinBtn").disabled = true;
  noteEl("netJoinInfo", "Connecting…");
  try {
    const d = await netPost("link", { address, code });
    $("netCode").value = "";
    noteEl("netJoinInfo", "✓ Paired with " + d.name + ". It is listed under Paired PCs.", "ok");
  } catch (err) {
    noteEl("netJoinInfo", "Not connected: " + err.message, "err");
  } finally {
    $("netJoinBtn").disabled = false;
  }
  void loadNetwork();
});

$("network").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  if (act === "use") { $("netAddr").value = b.dataset.addr; $("netCode").focus(); return; }
  if (act === "fw-ask") { fwConfirm = true; return renderNetwork(); }
  if (act === "fw-cancel") { fwConfirm = false; return renderNetwork(); }
  if (act === "fw-check") { fw = null; return void loadFirewall(false); }
  if (act === "fw-apply") { fwBusy = true; renderNetwork(); return void loadFirewall(true); }
  if (act === "fw-copy") return copyText(fw.plan.commands.join("\\n"), "netFwInfo");
  if (act === "copy-code") return copyText(invite.code, "netShareInfo");
  if (act === "unlink-ask") { unlinkAsk = id; return renderPaired(); }
  if (act === "unlink-cancel") { unlinkAsk = null; return renderPaired(); }
  b.disabled = true;
  if (act === "pair") {
    try {
      const before = new Set((net ? net.paired : []).map((p) => p.id));
      const d = await netPost("pair", {});
      invite = { code: d.code, expiresAt: d.expiresAt, before, done: null };
      renderShare();
      void copyText(d.code, "netShareInfo", true);
    } catch (err) {
      renderShare();
      noteEl("netShareInfo", "No code created: " + err.message, "err");
    }
  } else if (act === "verify") {
    try {
      const d = await netPost("verify", { id });
      const names = d.peers.map((p) => p.name);
      peerNotes.set(id, { text: names.length + " agent" + (names.length === 1 ? "" : "s") + " online there" + (names.length ? ": " + names.join(", ") : "") + " · answered in " + d.roundTripMs + " ms" });
    } catch (err) {
      peerNotes.set(id, { text: "No answer: " + err.message, err: true });
    }
    void loadNetwork();
  } else if (act === "unlink") {
    try {
      await netPost("unlink", { id });
      unlinkAsk = null;
      peerNotes.delete(id);
    } catch (err) {
      peerNotes.set(id, { text: "Not unlinked: " + err.message, err: true });
    }
    void loadNetwork();
  }
});

async function copyText(text, noteId, auto) {
  try {
    await navigator.clipboard.writeText(text);
    noteEl(noteId, auto ? "Code copied to the clipboard." : "Copied.", "ok");
  } catch {
    if (!auto) noteEl(noteId, "Copy failed: select the text and copy it by hand.", "err");
  }
}

setInterval(() => {
  const el = $("netCountdown");
  if (invite && !invite.done && invite.expiresAt <= Date.now() && route.network) renderShare();
  else if (el && invite) el.textContent = mmss(invite.expiresAt - Date.now());
  const due = inviteActive() ? NET_PAIR_POLL_MS : NET_POLL_MS;
  if ((route.network || inviteActive()) && Date.now() - netLoadedAt >= due) void loadNetwork();
}, 1000);

$("sessFilter").addEventListener("input", () => { if (model) renderSide(); });
$("sessFilter").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("sessFilter").value = ""; if (model) renderSide(); }
  // Enter opens the first match: the first session, or its first matching subagent.
  if (e.key === "Enter") {
    const first = $("sideTree").querySelector(".tree-row, .tree-sess > a");
    if (first) location.hash = first.getAttribute("href");
  }
});
$("sideTree").addEventListener("click", (e) => {
  const fold = e.target.closest("[data-fold]"), more = e.target.closest("[data-more]");
  if (fold) {
    const name = fold.dataset.fold;
    sideToggled.has(name) ? sideToggled.delete(name) : sideToggled.add(name);
    saveSideToggled();
    renderSide();
  } else if (more) {
    const id = "side-all:" + more.dataset.more;
    opened.has(id) ? opened.delete(id) : opened.add(id);
    renderSide();
  } else if (e.target.closest("a") && narrow()) setSidebar(false);
});
$("sideHide").addEventListener("click", () => setSidebar(false));
$("sideShow").addEventListener("click", () => setSidebar(true));
$("scrim").addEventListener("click", () => setSidebar(false));
try { if (localStorage.getItem(SIDE_COLLAPSED_KEY) === "1" && !narrow()) $("app").classList.add("collapsed"); } catch {}

/* ---- Waiting for you: subagent approval requests (GET/POST /api/approvals, docs/approval-api.md) ---- */
let approvals = [], apLoadedAt = 0, apLoading = false, apFirstLoad = true, lastApKey = "";
/** Typed reasons survive refreshes; answers stay visible for a while after their request is gone. */
const apDrafts = new Map(), apResults = new Map(), apBusy = new Set(), apSeen = new Set();
const AP_RESULT_KEEP_MS = 5 * 60_000;

const approvalJob = (a) => { const g = model && [...model.groups.values()].find((x) => x.job === a.job); return (g && g.title) || a.job; };

async function loadApprovals() {
  if (apLoading) return;
  apLoading = true;
  try {
    const r = await fetch("/api/approvals");
    if (r.ok) {
      approvals = (await r.json()).approvals || [];
      notifyNewApprovals();
    }
  } catch {
    // Kept as it was; the next round tries again.
  } finally {
    apLoading = false;
    apLoadedAt = Date.now();
  }
  if (!model) return;
  renderSide();
  if (route.page === "approvals") renderApprovals();
  else if (!route.session && !route.page) renderApprovalBanner();
}

/** A browser notification for requests that arrive while this tab is in the background (once allowed). */
function notifyNewApprovals() {
  const fresh = approvals.filter((a) => !apSeen.has(a.id));
  for (const a of approvals) apSeen.add(a.id);
  if (apFirstLoad) { apFirstLoad = false; return; }
  if (!fresh.length || typeof Notification === "undefined" || Notification.permission !== "granted" || !document.hidden) return;
  for (const a of fresh.slice(0, 3)) {
    const n = new Notification("A subagent is waiting for you", { body: (approvalJob(a) + ": " + (a.command || a.tool || "")).slice(0, 180), tag: "ab-approval-" + a.id });
    n.onclick = () => { window.focus(); location.hash = APPROVALS_HASH; };
  }
}

function approvalCard(a) {
  const left = a.deadline - Date.now(), busy = apBusy.has(a.id);
  return '<div class="ap-card">' +
    '<div class="ap-head">' + av(a.agent) + '<div class="grow"><b class="ell">' + esc(approvalJob(a)) + '</b><div class="small muted ell">' + esc(a.agent + " subagent of " + a.owner) + "</div></div>" +
    '<span class="ap-time" data-deadline="' + Number(a.deadline) + '">' + (left > 0 ? "auto-deny in " + mmss(left) : "expiring") + "</span></div>" +
    (a.tool ? '<div class="ap-tool">' + esc(a.tool) + "</div>" : "") +
    (a.command ? '<pre class="cmds">' + esc(a.command) + "</pre>" : "") +
    (a.reason ? '<p class="ap-reason">' + esc(a.reason) + "</p>" : "") +
    '<div class="ap-actions"><input class="ap-why" data-ap-why="' + esc(a.id) + '" placeholder="Reason for the subagent (optional)" maxlength="4000" aria-label="Reason for the subagent">' +
    '<button type="button" data-ap-act="allow" data-id="' + esc(a.id) + '"' + (busy ? " disabled" : "") + ">Allow</button>" +
    '<button type="button" class="ghost danger" data-ap-act="deny" data-id="' + esc(a.id) + '"' + (busy ? " disabled" : "") + ">Deny</button></div></div>";
}

function renderApprovals() {
  for (const [id, r] of apResults) if (Date.now() - r.at > AP_RESULT_KEEP_MS) apResults.delete(id);
  const open = new Set(approvals.map((a) => a.id));
  const done = [...apResults].filter(([id]) => !open.has(id));
  const key = JSON.stringify([approvals.map((a) => a.id + ":" + approvalJob(a)), [...apResults].map(([id, r]) => id + r.text), [...apBusy]]);
  updateNotifyButton();
  if (key === lastApKey) return;
  lastApKey = key;
  $("apList").innerHTML = (approvals.length
    ? approvals.map((a) => approvalCard(a) + (apResults.has(a.id) ? '<div class="note err ap-note">' + esc(apResults.get(a.id).text) + "</div>" : "")).join("")
    : '<div class="panel empty">Nothing is waiting for you. Requests appear here the moment a subagent asks.</div>') +
    (done.length ? '<div class="ap-done">' + done.map(([, r]) => '<div class="note ' + r.kind + '">' + esc(r.text) + "</div>").join("") + "</div>" : "");
  // Re-rendering replaced the inputs: put back what was typed.
  for (const input of $("apList").querySelectorAll("[data-ap-why]")) input.value = apDrafts.get(input.dataset.apWhy) || "";
}

function renderApprovalBanner() {
  const n = approvals.length;
  setHtml("ovAttn", n ? '<a class="attn-banner" href="' + APPROVALS_HASH + '"><span class="attn-mark" aria-hidden="true">!</span><span><b>' + n + " subagent" + (n === 1 ? " is" : "s are") + " waiting for your approval.</b> Unanswered requests count as deny when their time runs out.</span><span class=\\"attn-go\\">Review</span></a>" : "");
}

function updateNotifyButton() {
  const b = $("notifyBtn");
  if (typeof Notification === "undefined") { b.disabled = true; b.textContent = "Browser notifications unavailable"; return; }
  b.disabled = Notification.permission !== "default";
  b.textContent = Notification.permission === "granted" ? "Browser notifications on" : Notification.permission === "denied" ? "Notifications blocked in this browser" : "Notify me in this browser";
}

async function answerApproval(id, decision) {
  const reason = (apDrafts.get(id) || "").trim();
  apBusy.add(id);
  renderApprovals();
  let result;
  try {
    const r = await fetch("/api/approvals/" + encodeURIComponent(id), { method: "POST", headers: { "content-type": "application/json", "x-agent-bridge": "1" }, body: JSON.stringify(reason ? { decision, reason } : { decision }) });
    const d = await r.json().catch(() => ({}));
    const a = approvals.find((x) => x.id === id), name = a ? approvalJob(a) : "the subagent";
    result = r.ok
      ? { kind: "ok", text: (decision === "allow" ? "Allowed: " : "Denied: ") + name + (a && a.command ? " · " + a.command.slice(0, 80) : "") }
      : { kind: "err", text: d.error || "Not answered (HTTP " + r.status + ")." };
    if (r.ok) apDrafts.delete(id);
  } catch (err) {
    result = { kind: "err", text: "Not answered: " + err.message };
  } finally {
    apBusy.delete(id);
  }
  apResults.set(id, { ...result, at: Date.now() });
  await loadApprovals();
  renderApprovals();
}

/* ---- Decisions (GET /api/decisions, docs/decisions.md) ---- */
let decisions = null, decLoading = false, decLoadedAt = 0, decTimer = 0;
const decHistory = new Map();
const DECISIONS_REFRESH_MS = 15_000, DECISION_SEARCH_DELAY_MS = 250;

const scopeLabel = (s) => !s || s === "all" ? "all sessions" : s.project ? folder(s.project) : s.sessions ? s.sessions.length + " session" + (s.sessions.length === 1 ? "" : "s") : "scoped";

async function loadDecisions() {
  if (decLoading) return;
  decLoading = true;
  const q = $("decFilter").value.trim();
  try {
    const r = await fetch("/api/decisions" + (q ? "?q=" + encodeURIComponent(q) : ""));
    const d = await r.json().catch(() => ({}));
    decisions = r.ok ? d.decisions || [] : [];
  } catch {
    decisions = decisions || [];
  } finally {
    decLoading = false;
    decLoadedAt = Date.now();
  }
  if (route.page === "decisions") renderDecisions();
}

function renderDecisions() {
  if (decisions === null || Date.now() - decLoadedAt > DECISIONS_REFRESH_MS) void loadDecisions();
  if (decisions === null) return setHtml("decList", '<div class="empty">Reading decisions…</div>');
  const q = $("decFilter").value.trim();
  setHtml("decList", decisions.length
    ? decisions.map((d) => {
        const hist = decHistory.get(d.topic);
        return '<article class="dec"><div class="dec-head"><h4>' + esc(d.topic) + '</h4><span class="chip">' + esc(scopeLabel(d.scope)) + '</span><span class="small faint">' + esc(((d.author && d.author.name) || "") + " · " + ago(d.createdAt)) + "</span></div>" +
          '<div class="dec-text">' + md(d.text) + "</div>" +
          (d.supersedes ? '<button type="button" class="linkbtn" data-dec-hist="' + esc(d.topic) + '">' + (hist ? "Hide earlier versions" : "Show earlier versions") + "</button>" : "") +
          (hist ? '<div class="dec-hist">' + hist.filter((x) => !x.current).map((x) => '<div><span class="small faint">' + esc(new Date(x.createdAt).toLocaleString() + " · " + ((x.author && x.author.name) || "")) + "</span>" + md(x.text) + "</div>").join("") + "</div>" : "") +
          "</article>";
      }).join("")
    : '<div class="empty">' + (q ? "No decision matches." : "No decisions yet. When you settle something, ask a session to record it with the decide tool, and every session will see it.") + "</div>");
}

$("apList").addEventListener("input", (e) => { const id = e.target.dataset && e.target.dataset.apWhy; if (id) apDrafts.set(id, e.target.value); });
$("apList").addEventListener("click", (e) => { const b = e.target.closest("[data-ap-act]"); if (b) void answerApproval(b.dataset.id, b.dataset.apAct); });
$("notifyBtn").addEventListener("click", async () => { try { await Notification.requestPermission(); } catch {} updateNotifyButton(); });
$("decFilter").addEventListener("input", () => { clearTimeout(decTimer); decTimer = setTimeout(() => { decHistory.clear(); void loadDecisions(); }, DECISION_SEARCH_DELAY_MS); });
$("decList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-dec-hist]");
  if (!b) return;
  const topic = b.dataset.decHist;
  if (decHistory.has(topic)) { decHistory.delete(topic); return renderDecisions(); }
  try {
    const r = await fetch("/api/decisions/" + encodeURIComponent(topic) + "/history");
    if (r.ok) decHistory.set(topic, (await r.json()).decisions || []);
  } catch {}
  renderDecisions();
});
setInterval(() => {
  for (const el of $("apList").querySelectorAll("[data-deadline]")) { const left = Number(el.dataset.deadline) - Date.now(); el.textContent = left > 0 ? "auto-deny in " + mmss(left) : "expiring"; }
  if (Date.now() - apLoadedAt >= APPROVALS_POLL_MS) void loadApprovals();
}, 1000);

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
void loadNetwork();
loadUsage(false);
setInterval(() => loadUsage(false), 5 * 60 * 1000);
$("usageRefresh").addEventListener("click", () => loadUsage(true));
$("ovModels").parentElement.addEventListener("toggle", (e) => { if (e.target.open) void loadModels(); });
setInterval(poll, POLL_MS);
</script>
</body>
</html>
`;
