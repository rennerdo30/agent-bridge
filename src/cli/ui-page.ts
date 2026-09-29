/** The dashboard served by `agent-bridge ui`: one self-contained page, no external resources. */
export const UI_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-bridge</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #1d2330; --muted: #667085; --line: #e3e6eb;
  --accent: #3b5bdb; --ok: #2b8a3e; --warn: #b7791f; --bad: #c92a2a; --busy: #1971c2;
  --code-bg: #f1f3f5; --sel: #e7edff;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111418; --panel: #191d23; --text: #e6e8eb; --muted: #98a2b3; --line: #2a303a;
    --accent: #7b93ff; --ok: #51cf66; --warn: #fcc419; --bad: #ff6b6b; --busy: #4dabf7;
    --code-bg: #0d1014; --sel: #232b45;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
header h1 { font-size: 16px; margin: 0; }
header .status { color: var(--muted); font-size: 13px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
main { display: grid; grid-template-columns: minmax(280px, 360px) 1fr; gap: 16px; padding: 16px 20px; min-height: calc(100vh - 53px); }
@media (max-width: 860px) { main { grid-template-columns: 1fr; } }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0; padding: 10px 14px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; }
.col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
ul { list-style: none; margin: 0; padding: 0; }
li { padding: 9px 14px; border-bottom: 1px solid var(--line); }
li:last-child { border-bottom: 0; }
.name { font-weight: 600; }
.sub { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.tag { font-size: 11px; padding: 1px 6px; border-radius: 10px; border: 1px solid var(--line); color: var(--muted); margin-left: 6px; }
.tag.old { color: var(--bad); border-color: var(--bad); }
.run { cursor: pointer; }
.run:hover { background: var(--sel); }
.run.sel { background: var(--sel); box-shadow: inset 3px 0 0 var(--accent); }
.s-running { color: var(--busy); } .s-done { color: var(--ok); } .s-failed { color: var(--bad); } .s-interrupted { color: var(--warn); }
.empty { padding: 14px; color: var(--muted); }
#task { border-bottom: 1px solid var(--line); padding: 6px 14px; }
#task summary { cursor: pointer; }
#taskText { margin: 6px 0 0; max-height: 24vh; overflow: auto; white-space: pre-wrap; font: 12px/1.45 ui-monospace, Consolas, monospace; color: var(--muted); }
.chat { padding: 12px 14px; height: 56vh; overflow: auto; background: var(--code-bg); display: flex; flex-direction: column; gap: 6px; }
.chat .note { color: var(--muted); font-size: 12px; text-align: center; }
.chat .row { display: grid; grid-template-columns: 70px 1fr; gap: 8px; align-items: baseline; }
.chat .meta { color: var(--muted); font-size: 11px; white-space: nowrap; }
.chat .cmd { font: 12px/1.45 ui-monospace, "Cascadia Code", Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); opacity: .85; }
.chat .cmd b { color: var(--accent); font-weight: 600; }
.chat .bubble { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 92%; }
.chat .answer { border-color: var(--ok); box-shadow: inset 3px 0 0 var(--ok); }
.chat .answer::before { content: "Final answer"; display: block; font-size: 11px; color: var(--ok); margin-bottom: 4px; }
#logHead { padding: 10px 14px; border-bottom: 1px solid var(--line); }
.msg { display: grid; gap: 2px; }
.msg .body { white-space: pre-wrap; overflow-wrap: anywhere; }
#msgs { max-height: 38vh; overflow: auto; }
form { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); flex-wrap: wrap; }
select, textarea, button { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
textarea { flex: 1 1 260px; min-height: 38px; resize: vertical; }
button { background: var(--accent); color: #fff; border-color: var(--accent); cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
#sendInfo { width: 100%; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>agent-bridge</h1>
  <span class="status" id="status">connecting…</span>
</header>
<main>
  <div class="col">
    <section><h2>Sessions <span id="peerCount"></span></h2><ul id="peers"></ul></section>
    <section><h2>Delegated runs <span id="runCount"></span></h2><ul id="runs"></ul></section>
  </div>
  <div class="col">
    <section>
      <h2>Run <label class="sub"><input type="checkbox" id="follow" checked> follow</label></h2>
      <div id="logHead" class="sub">Select a run on the left.</div>
      <details id="task"><summary class="sub">Task</summary><pre id="taskText"></pre></details>
      <div id="log" class="chat"></div>
    </section>
    <section>
      <h2>Messages</h2>
      <ul id="msgs"></ul>
      <form id="send">
        <select id="to" aria-label="Recipient"></select>
        <textarea id="body" placeholder="Message to the session (sent as &quot;you&quot;)" aria-label="Message"></textarea>
        <button type="submit" id="sendBtn">Send</button>
        <div id="sendInfo"></div>
      </form>
    </section>
  </div>
</main>
<script>
const POLL_MS = 1500;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const time = (t) => new Date(t).toLocaleTimeString();
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m" : Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m"; };
let selected = null, logOffset = 0, version = "", raw = "";

function renderPeers(peers) {
  $("peerCount").textContent = peers.length;
  $("peers").innerHTML = peers.length ? peers.map((p) => {
    const color = p.activity === "busy" ? "var(--busy)" : p.activity === "idle" ? "var(--ok)" : "var(--muted)";
    const old = p.version && p.version !== version ? '<span class="tag old">v' + esc(p.version) + " outdated</span>" : '<span class="tag">v' + esc(p.version ?? "?") + "</span>";
    return '<li><span class="dot" style="background:' + color + '"></span><span class="name">' + esc(p.name) + '</span><span class="tag">' + esc(p.agent) + "</span>" + old +
      '<div class="sub">' + esc(p.activity ?? "unknown") + " · up " + ago(p.startedAt) + " · " + esc(p.cwd) + "</div></li>";
  }).join("") : '<li class="empty">No sessions connected.</li>';
  const to = $("to"), current = to.value;
  const names = peers.filter((p) => p.name !== "you").map((p) => p.name);
  to.innerHTML = names.map((n) => "<option>" + esc(n) + "</option>").join("") + '<option value="*">* everyone</option>';
  if ([...names, "*"].includes(current)) to.value = current;
}

function renderRuns(runs) {
  $("runCount").textContent = runs.length;
  if (!selected && runs[0]) select(runs[0].name);
  $("runs").innerHTML = runs.length ? runs.map((r) =>
    '<li class="run' + (r.name === selected ? " sel" : "") + '" data-name="' + esc(r.name) + '">' +
    '<span class="name">' + esc(r.agent) + '</span> <span class="s-' + r.status + '">' + r.status + "</span>" +
    '<span class="sub"> · ' + time(r.startedAt) + " · updated " + ago(r.updatedAt) + " ago</span>" +
    '<div class="sub">' + esc(r.last) + "</div></li>").join("") : '<li class="empty">No delegated runs yet.</li>';
  const cur = runs.find((r) => r.name === selected);
  if (cur) $("logHead").innerHTML = '<span class="s-' + cur.status + '">' + cur.status + "</span> · " + esc(cur.header);
}

function renderMessages(msgs) {
  $("msgs").innerHTML = msgs.length ? msgs.map((m) =>
    '<li class="msg"><div class="sub"><b>' + esc(m.from_name) + "</b> → " + esc(m.recipients || m.to_target) + " · " + time(m.created_at) + (m.hop ? " · hop " + m.hop : "") + "</div>" +
    '<div class="body">' + esc(m.body) + "</div></li>").join("") : '<li class="empty">No messages yet.</li>';
}

async function poll() {
  try {
    const r = await fetch("/api/state");
    if (!r.ok) throw new Error(r.status === 403 ? "not authorized: open the link printed by agent-bridge ui" : "HTTP " + r.status);
    const s = await r.json();
    version = s.version;
    $("status").innerHTML = s.brokerPid
      ? '<span class="dot" style="background:var(--ok)"></span>bridge running · v' + esc(s.version)
      : '<span class="dot" style="background:var(--warn)"></span>no bridge running (start a session with agent-bridge)';
    renderPeers(s.peers); renderRuns(s.runs); renderMessages(s.messages);
    await pullLog();
  } catch (e) {
    $("status").innerHTML = '<span class="dot" style="background:var(--bad)"></span>' + esc(e.message);
  }
}

let pulling = false;
async function pullLog() {
  // One fetch at a time: overlapping pulls would append the same chunk twice.
  if (!selected || pulling) return;
  pulling = true;
  const run = selected;
  try {
    const r = await fetch("/api/runs/" + encodeURIComponent(run) + "?from=" + logOffset);
    if (!r.ok || run !== selected) return;
    const d = await r.json();
    if (run !== selected) return;
    applyLog(d);
  } finally {
    pulling = false;
  }
}

function applyLog(d) {
  if (d.text) {
    raw += d.text;
    // The log starts with the task (header, prompt, "---"); keep it folded away from the live steps.
    const m = /\\n *---\\n(?=\\d\\d:\\d\\d:\\d\\d started )/.exec(raw);
    const cut = m ? m.index : -1;
    $("taskText").textContent = (cut >= 0 ? raw.slice(0, cut) : raw).replace(/^ {9}/gm, "");
    renderChat(cut >= 0 ? raw.slice(cut + m[0].length) : "");
    if ($("follow").checked) $("log").scrollTop = $("log").scrollHeight;
  }
  logOffset = d.next;
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

function renderChat(text) {
  const html = parseEntries(text).map((e) => {
    if (e.text.startsWith("answer: ")) return '<div class="bubble answer">' + esc(e.text.slice(8)) + "</div>";
    if (/^(started|still working|finished after)/.test(e.text)) return '<div class="note">' + esc(e.time + " · " + e.text) + "</div>";
    const parts = e.text.split(" · ");
    const body = parts.slice(parts[1] && parts[1].startsWith("step ") ? 2 : 1).join(" · ");
    const meta = esc(e.time) + "<br>" + esc(parts[0]);
    if (body.startsWith("says: ")) return '<div class="row"><span class="meta">' + meta + '</span><div class="bubble">' + esc(body.slice(6)) + "</div></div>";
    const i = body.indexOf(": ");
    const cmd = i > 0 && i < 24 ? "<b>" + esc(body.slice(0, i)) + "</b> " + esc(body.slice(i + 2)) : esc(body);
    return '<div class="row"><span class="meta">' + meta + '</span><div class="cmd">' + cmd + "</div></div>";
  }).join("");
  $("log").innerHTML = html || '<div class="note">Waiting for the first step…</div>';
}

function select(name) {
  selected = name; logOffset = 0; raw = ""; $("log").innerHTML = ""; $("taskText").textContent = "";
  document.querySelectorAll(".run").forEach((el) => el.classList.toggle("sel", el.dataset.name === name));
  pullLog();
}

$("runs").addEventListener("click", (e) => { const li = e.target.closest(".run"); if (li) select(li.dataset.name); });

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

poll();
setInterval(poll, POLL_MS);
</script>
</body>
</html>
`;
