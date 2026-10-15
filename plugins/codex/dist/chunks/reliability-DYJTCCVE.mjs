import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  pluginSourceDir
} from "./chunk-HPMRX3EO.mjs";
import {
  codexPermissionHookTrusted
} from "./chunk-IOGZQ3DT.mjs";
import {
  createWorktree,
  finishWorktree
} from "./chunk-XYFT24YR.mjs";
import {
  Client,
  PermissionRelay,
  StdioClientTransport,
  delegateToAntigravity,
  delegateToClaude,
  delegateToCodex,
  delegateToCodexAppServer,
  delegateToMuse,
  delegateToOpencode,
  delegateToOpencodeServed,
  readStore,
  resolveBinary
} from "./chunk-ZRZKPN5K.mjs";
import "./chunk-GU6LHE2M.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveHome
} from "./chunk-2M4FBSCA.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-CHGUU5ZH.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-ZOA3PODP.mjs";
import "./chunk-QPCOBHQB.mjs";
import "./chunk-JF4RUO76.mjs";
import "./chunk-RWIV74TX.mjs";
import "./chunk-NVTFJMO3.mjs";
import "./chunk-T4EU6Q4H.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-RQIXW2IC.mjs";
import "./chunk-LG5QXURA.mjs";
import {
  DEFAULT_CLAUDE_BIN,
  DEFAULT_CODEX_BIN,
  DEFAULT_MUSE_BIN,
  DEFAULT_OPENCODE_BIN,
  LOG_DIR_NAME,
  MAX_WAIT_SEC
} from "./chunk-NT6Y2SKY.mjs";
import "./chunk-VNQ4UNAO.mjs";
import "./chunk-NVDPULGI.mjs";
import "./chunk-DEWCC5JJ.mjs";
import "./chunk-6RNADTH4.mjs";

// src/cli/reliability.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, mkdtempSync as mkdtempSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join2 } from "node:path";

// src/cli/reliability-live.ts
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
var SERVER_BUNDLE = join("dist", "server.mjs");
var JOBS_FILE = "jobs.json";
var NOTE_COUNT = 12;
var NOTES_DIR = "notes";
var LONG_TASK = `Read the files ${NOTES_DIR}/note-01.txt to ${NOTES_DIR}/note-${String(NOTE_COUNT).padStart(2, "0")}.txt one at a time, in order. Use a separate tool call for each file; never read several files in one call. After each file, write one sentence that summarizes it before you read the next one. At the end, list all your summaries.`;
var LIVE_QUESTION = "Quick question while you work: how many of the note files have you read so far? Answer in one short sentence, then continue the task.";
var FACT = "pineapple-42";
var FACT_PROMPT = `Remember this for later: the fixture for this task is called ${FACT}. Reply with only the word OK.`;
var FACT_QUESTION = "What is the fixture for this task called? Reply with only its name.";
var JOB_TIMEOUT_SEC = 900;
var SERVER_START_TIMEOUT_MS = 3e4;
var WORKING_TIMEOUT_MS = 18e4;
var ANSWER_TIMEOUT_MS = 3e5;
var RESULT_TIMEOUT_MS = 9e5;
var SESSION_TIMEOUT_MS = 18e4;
var SERVER_EXIT_TIMEOUT_MS = 2e4;
var POLL_MS = 1e3;
var CALL_SLACK_MS = 3e4;
var PROCESS_LIST_TIMEOUT_MS = 3e4;
var APPROVAL_TIMEOUT_SEC = 300;
var DETAIL_CHARS = 80;
var FEED_START = "started \xB7";
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var short = (s) => JSON.stringify(s.trim().replace(/\s+/g, " ").slice(0, DETAIL_CHARS));
function hostFor(target) {
  return target === "codex" ? "claude" : "codex";
}
function serverBundle(host, fromFile) {
  const dir = pluginSourceDir(host, SERVER_BUNDLE, fromFile);
  return dir ? join(dir, SERVER_BUNDLE) : null;
}
function jobNameIn(text) {
  return /Subagent (\S+-job-[0-9a-f]+) started/.exec(text)?.[1] ?? /message_subagent\(job="([^"]+)"/.exec(text)?.[1] ?? null;
}
function finalStatusOf(job, body) {
  const m = new RegExp(`^Subagent ${job.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\([^)]*\\) (done|failed|cancelled) after \\d+s\\.`).exec(body.trim());
  return m?.[1] ?? null;
}
function messageBody(text) {
  return /<agent-bridge-message [^>]*>\n([\s\S]*)\n<\/agent-bridge-message>/.exec(text)?.[1] ?? text;
}
var isApprovalQuestion = (job, body) => body.trim().startsWith(`Subagent ${job} asks for approval`);
function listProcesses() {
  const win = process.platform === "win32";
  const [file, args] = win ? [
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })" }'
    ]
  ] : ["ps", ["-A", "-o", "pid=,ppid=,pgid="]];
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROCESS_LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const procs = [];
      for (const line of stdout.split(/\r?\n/)) {
        const [a, b, c] = line.trim().split(/\s+/);
        if (!a || !b || !/^\d+$/.test(a)) continue;
        procs.push(win ? { pid: Number(a), ppid: Number(b), started: c } : { pid: Number(a), ppid: Number(b), pgid: Number(c) });
      }
      resolve(procs);
    });
  });
}
function processTree(procs, root) {
  const tree = procs.filter((p) => p.pid === root);
  for (let i = 0; i < tree.length; i++) {
    const parent = tree[i];
    for (const p of procs) if (p.ppid === parent.pid && p.pid !== parent.pid && !tree.includes(p)) tree.push(p);
  }
  return tree;
}
function leftovers(tree, now, ownGroup) {
  const same = (a, b) => a.pid === b.pid && (a.started === void 0 || a.started === b.started);
  const groups = new Set(tree.map((p) => p.pgid).filter((g) => g !== void 0 && g !== ownGroup));
  return now.filter((p) => tree.some((t) => same(t, p)) || p.pgid !== void 0 && groups.has(p.pgid));
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function storedJob(home, job) {
  try {
    const all = readStore(join(home, JOBS_FILE));
    return all.find((j) => j.name === job) ?? null;
  } catch {
    return null;
  }
}
var PICKED_UP_LOG = "subagent picked up messages";
function logsMention(home, text) {
  try {
    const dir = join(home, LOG_DIR_NAME);
    return readdirSync(dir).some((f) => readFileSync(join(dir, f), "utf8").includes(text));
  } catch {
    return false;
  }
}
async function until(timeoutMs, fn) {
  const end = Date.now() + timeoutMs;
  for (; ; ) {
    const v = await fn();
    if (v !== null && v !== void 0) return v;
    if (Date.now() > end) return null;
    await sleep(POLL_MS);
  }
}
var LiveHost = class _LiveHost {
  constructor(client, transport, pid) {
    this.client = client;
    this.transport = transport;
    this.pid = pid;
  }
  client;
  transport;
  pid;
  static async start(bundle, host, home, cwd) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle, `--agent=${host}`],
      cwd,
      env: {
        ...process.env,
        AGENT_BRIDGE_HOME: home,
        CLAUDE_PROJECT_DIR: cwd,
        AGENT_BRIDGE_DASHBOARD: "off",
        AGENT_BRIDGE_DELIVERY: "hooks",
        AGENT_BRIDGE_AUTO_WAKE: "off"
      },
      stderr: "ignore"
    });
    const client = new Client({ name: "agent-bridge-reliability", version: "0.0.0" });
    await client.connect(transport, { timeout: SERVER_START_TIMEOUT_MS });
    return new _LiveHost(client, transport, transport.pid ?? 0);
  }
  async call(name, args, timeoutMs = CALL_SLACK_MS) {
    const r = await this.client.callTool({ name, arguments: args }, void 0, { timeout: timeoutMs });
    return { text: (r.content ?? []).map((c) => c.text ?? "").join("\n"), isError: Boolean(r.isError) };
  }
  /** The next message from the job (approval questions it asks are denied), or null after the timeout. */
  async next(job, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const sec = Math.max(1, Math.min(MAX_WAIT_SEC, Math.ceil((end - Date.now()) / 1e3)));
      const r = await this.call("wait_for_message", { from: job, timeout_sec: sec }, sec * 1e3 + CALL_SLACK_MS);
      if (r.isError) await sleep(POLL_MS);
      if (r.isError || /^No message arrived/.test(r.text)) continue;
      const body = messageBody(r.text);
      if (isApprovalQuestion(job, body)) {
        await this.call("decide", { approval_id: /approval_id="([0-9a-f-]{36})"/.exec(body)?.[1], decision: "deny", reason: "the reliability suite allows nothing here" });
        continue;
      }
      return body;
    }
    return null;
  }
  /** Wait for the job's final result, skipping other messages. */
  async result(job, timeoutMs) {
    const end = Date.now() + timeoutMs;
    for (; ; ) {
      const body = await this.next(job, end - Date.now());
      if (body === null) return null;
      const status = finalStatusOf(job, body);
      if (status) return { status, body };
    }
  }
  /** Progress line of a running job in `peers`, once it reports a real step (not just its start). */
  async working(job) {
    const peers = await this.call("peers", {});
    const line = peers.text.split("\n").find((l) => l.startsWith(`- ${job} (`));
    const progress = line?.slice(line.indexOf("): ") + 3).trim();
    return progress && progress !== "starting" && !progress.startsWith(FEED_START) ? progress : null;
  }
  /** Status of a finished (or interrupted) job as `peers` lists it. */
  async listedStatus(job) {
    const peers = await this.call("peers", {});
    return new RegExp(`^- ${job}: (\\w+)`, "m").exec(peers.text)?.[1] ?? null;
  }
  async close() {
    await this.client.close().catch(() => {
    });
    await until(SERVER_EXIT_TIMEOUT_MS, () => alive(this.pid) ? null : true);
  }
};
function writeNotes(dir) {
  mkdirSync(join(dir, NOTES_DIR), { recursive: true });
  for (let i = 1; i <= NOTE_COUNT; i++) {
    writeFileSync(join(dir, NOTES_DIR, `note-${String(i).padStart(2, "0")}.txt`), `Note ${i}: the garden bed number ${i} gets ${i * 2} liters of water on day ${i}.
`);
  }
}
async function killLeft(procs) {
  for (const p of procs) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
    }
  }
}
async function runLiveChecks(o) {
  const homes = [];
  const newHome = () => {
    const h = mkdtempSync(join(tmpdir(), "agent-bridge-rel-live-"));
    homes.push(h);
    return h;
  };
  const model = (agent) => o.models[agent] ? { model: o.models[agent] } : {};
  const spawnLong = async (host, agent) => {
    const r = await host.call(`spawn_${agent}`, { title: "Reliability: read notes", prompt: LONG_TASK, timeout_sec: JOB_TIMEOUT_SEC, ...model(agent) });
    const job = jobNameIn(r.text);
    if (r.isError || !job) throw new Error(`spawn_${agent} failed: ${short(r.text)}`);
    return job;
  };
  try {
    for (const agent of o.agents) {
      const host = hostFor(agent);
      const bundle = serverBundle(host);
      o.out(`${agent} (live, via a ${host} MCP server):`);
      if (!bundle) {
        o.out(`  SKIP  ${agent} live checks: no bundled server (plugins/${host}/${SERVER_BUNDLE.replace(/\\/g, "/")}) found`);
        continue;
      }
      {
        const home = newHome();
        const cwd = o.repo();
        writeNotes(cwd);
        const server = await LiveHost.start(bundle, host, home, cwd);
        try {
          await o.check(`${agent} live message to a running subagent`, async () => {
            const job = await spawnLong(server, agent);
            try {
              const progress = await until(WORKING_TIMEOUT_MS, () => server.working(job));
              if (!progress) return { pass: false, detail: `${job} never reported working within ${WORKING_TIMEOUT_MS / 1e3}s` };
              const sent = await server.call("message_subagent", { job, message: LIVE_QUESTION });
              if (!/still working/.test(sent.text)) return { pass: false, detail: `message_subagent: ${short(sent.text)}` };
              const first = await server.next(job, ANSWER_TIMEOUT_MS);
              if (first === null) return { pass: false, detail: `no message from ${job} within ${ANSWER_TIMEOUT_MS / 1e3}s` };
              const status = finalStatusOf(job, first);
              if (status) {
                const seen = logsMention(home, PICKED_UP_LOG) ? "it picked up the message but did not answer before finishing" : "it never picked up the message";
                return { pass: false, detail: `the final result (${status}) arrived before any answer: ${seen}; working was: ${short(progress)}` };
              }
              const final = await server.result(job, RESULT_TIMEOUT_MS);
              return {
                pass: final !== null,
                detail: `answer before the result: ${short(first)}; result: ${final ? final.status : "none in time"}`
              };
            } finally {
              await server.call("cancel_subagent", { job }).catch(() => {
              });
            }
          });
          await o.check(`${agent} follow-up keeps context`, async () => {
            const asked = await server.call(`ask_${agent}`, { title: "Reliability: remember a fact", prompt: FACT_PROMPT, ...model(agent) }, RESULT_TIMEOUT_MS);
            const job = jobNameIn(asked.text);
            if (asked.isError || !job) return { pass: false, detail: `ask_${agent}: ${short(asked.text)}` };
            const sent = await server.call("message_subagent", { job, message: FACT_QUESTION });
            if (!/^Sent to/.test(sent.text)) return { pass: false, detail: `message_subagent: ${short(sent.text)}` };
            const final = await server.result(job, RESULT_TIMEOUT_MS);
            if (!final) return { pass: false, detail: `no answer from ${job} within ${RESULT_TIMEOUT_MS / 1e3}s` };
            const answer = final.body.split("\n").slice(2).join(" ");
            return { pass: final.status === "done" && final.body.includes(FACT), detail: `${final.status}: ${short(answer)}` };
          });
        } finally {
          await server.close();
        }
      }
      {
        const home = newHome();
        const cwd = o.repo();
        writeNotes(cwd);
        let server = await LiveHost.start(bundle, host, home, cwd);
        let job = null;
        let before = null;
        try {
          await o.check(`${agent} clean exit`, async () => {
            job = await spawnLong(server, agent);
            const name = job;
            before = await until(SESSION_TIMEOUT_MS, () => {
              const s = storedJob(home, name);
              return s?.sessionId ? s : null;
            });
            if (!before) return { pass: false, detail: `${name} has no session in ${JOBS_FILE} after ${SESSION_TIMEOUT_MS / 1e3}s` };
            const all = await listProcesses();
            const tree = processTree(all, server.pid);
            const ownGroup = all.find((p) => p.pid === process.pid)?.pgid;
            await server.close();
            server = null;
            const left = leftovers(tree, await listProcesses(), ownGroup);
            await killLeft(left);
            return {
              pass: tree.length > 1 && left.length === 0,
              detail: tree.length <= 1 ? "the server had no child processes to check (the job was not running)" : left.length ? `${left.length} of ${tree.length} processes left running: pids ${left.map((p) => p.pid).join(", ")}` : `all ${tree.length} processes of the server's tree ended`
            };
          });
          await o.check(`${agent} recovery after a restart`, async () => {
            const name = job;
            const kept = before;
            if (!name || !kept?.sessionId) return { pass: false, detail: "no running job with a session to recover (see clean exit)" };
            await server?.close();
            const onDisk = storedJob(home, name)?.status ?? "missing";
            server = await LiveHost.start(bundle, host, home, cwd);
            const listed = await server.listedStatus(name);
            const sent = await server.call("message_subagent", { job: name });
            if (!/^Sent to/.test(sent.text)) return { pass: false, detail: `${JOBS_FILE}: ${onDisk}, listed as ${listed}; message_subagent: ${short(sent.text)}` };
            const final = await server.result(name, RESULT_TIMEOUT_MS);
            const after = storedJob(home, name);
            const sameSession = after?.sessionId === kept.sessionId;
            const recovered = listed === "interrupted" || listed === "failed";
            return {
              pass: recovered && final?.status === "done" && sameSession,
              detail: `${JOBS_FILE}: ${onDisk}, restored as ${listed ?? "unlisted"} -> started; result ${final?.status ?? "none in time"}; session ${sameSession ? "same" : `changed ${kept.sessionId} -> ${after?.sessionId ?? "none"}`}`
            };
          });
        } finally {
          await server?.close();
        }
      }
    }
    if (o.agents.includes("codex")) {
      o.out("codex app-server approvals:");
      for (const allow of [true, false]) {
        await o.check(`codex app-server ask -> ${allow ? "allow" : "deny"}`, async () => {
          const dir = o.repo();
          const asked = [];
          const r = await delegateToCodexAppServer({
            prompt: "Run this shell command in the current folder: echo hi > asked.txt\nIt creates a file named asked.txt. Then reply done.",
            cwd: dir,
            sessionId: null,
            timeoutSec: APPROVAL_TIMEOUT_SEC,
            model: o.models.codex ?? null,
            log: o.log,
            bin: o.bins.codex,
            sandbox: "read-only",
            approvalsReviewer: "user",
            askMode: true,
            approve: async (req) => {
              asked.push(`${req.tool}: ${req.detail.slice(0, 60)}`);
              return allow ? { allow: true } : { allow: false, message: "Denied by the reliability check." };
            }
          });
          const exists = existsSync(join(dir, "asked.txt"));
          const relevant = asked.filter((a) => !a.startsWith("mcp:"));
          return {
            pass: relevant.length > 0 && exists === allow,
            detail: `asked ${relevant.length}x [${relevant.join(" | ")}], file ${exists ? "created" : "not created"}; answer ${short(r.text)}`
          };
        });
      }
      await o.check("codex app-server read-only refuses escalation without asking", async () => {
        const dir = o.repo();
        const asked = [];
        const r = await delegateToCodexAppServer({
          prompt: "Create a file named should-not-exist.txt containing the word hi, for example with the shell command: echo hi > should-not-exist.txt\nIf the sandbox blocks it, request escalated permissions and try again. Then reply done.",
          cwd: dir,
          sessionId: null,
          timeoutSec: APPROVAL_TIMEOUT_SEC,
          model: o.models.codex ?? null,
          log: o.log,
          bin: o.bins.codex,
          sandbox: "read-only",
          approvalsReviewer: "user",
          approve: async (req) => {
            asked.push(`${req.tool}: ${req.detail.slice(0, 60)}`);
            return { allow: true };
          }
        });
        const exists = existsSync(join(dir, "should-not-exist.txt"));
        const relevant = asked.filter((a) => !a.startsWith("mcp:"));
        return {
          pass: !exists && relevant.length === 0,
          detail: exists ? "the file WAS created" : relevant.length ? `the parent was asked ${relevant.length}x [${relevant.join(" | ")}]` : `refused without asking, no file; answer ${short(r.text)}`
        };
      });
    }
  } finally {
    for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 3 });
  }
}

// src/cli/reliability.ts
var RUN_TIMEOUT_SEC = 300;
var REPEATS = 3;
var CANCEL_AFTER_MS = 8e3;
var CANCEL_GRACE_MS = 1e4;
var BINS = { claude: DEFAULT_CLAUDE_BIN, codex: DEFAULT_CODEX_BIN, opencode: DEFAULT_OPENCODE_BIN, antigravity: "agy", muse: DEFAULT_MUSE_BIN };
var RELIABILITY_SECTIONS = ["core", "live"];
var models = {};
function run(agent, prompt, cwd, access, log, signal) {
  const base = { prompt, cwd, sessionId: null, timeoutSec: RUN_TIMEOUT_SEC, log, signal, model: models[agent] ?? null };
  if (agent === "antigravity") return delegateToAntigravity({ ...base, bin: BINS.antigravity, access });
  if (agent === "codex") return delegateToCodex({ ...base, bin: BINS.codex, sandbox: access === "edit" ? "workspace-write" : "read-only" });
  if (agent === "claude") return delegateToClaude({ ...base, bin: BINS.claude, permissionMode: access === "edit" ? "acceptEdits" : "default" });
  if (agent === "muse") return delegateToMuse({ ...base, bin: BINS.muse, access });
  return delegateToOpencode({ ...base, bin: BINS.opencode, autoApprove: access === "edit" });
}
async function runAsk(agent, prompt, cwd, decide, log) {
  const base = { prompt, cwd, sessionId: null, timeoutSec: RUN_TIMEOUT_SEC, log, model: models[agent] ?? null };
  if (agent === "antigravity") return delegateToAntigravity({ ...base, bin: BINS.antigravity, access: "ask", approve: decide });
  if (agent === "opencode") return delegateToOpencodeServed({ ...base, bin: BINS.opencode, onPermission: decide });
  if (agent === "codex") {
    if (!codexPermissionHookTrusted(resolveHome())) return null;
    const relay = new PermissionRelay(decide, log);
    await relay.start();
    try {
      return await delegateToCodex({ ...base, bin: BINS.codex, sandbox: "read-only", relayApprovals: true, extraEnv: relay.childEnv() });
    } finally {
      await relay.stop();
    }
  }
  return null;
}
async function timed(name, fn) {
  const start = Date.now();
  try {
    const r = await fn();
    return { name, ...r, ms: Date.now() - start };
  } catch (err) {
    return { name, pass: false, detail: String(err?.message ?? err).slice(0, 160), ms: Date.now() - start };
  }
}
function makeRepo() {
  const dir = mkdtempSync2(join2(tmpdir2(), "agent-bridge-rel-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  writeFileSync2(join2(dir, "README.md"), "reliability sandbox\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "base");
  return dir;
}
async function runReliability(opts) {
  const sections = opts.sections ?? RELIABILITY_SECTIONS;
  models = opts.models ?? {};
  const agents = opts.agents.filter((a) => resolveBinary(BINS[a]));
  for (const a of opts.agents) if (!agents.includes(a)) opts.out(`${a}: SKIP (CLI "${BINS[a]}" not installed)`);
  const home = mkdtempSync2(join2(tmpdir2(), "agent-bridge-rel-home-"));
  const results = [];
  const record = (o) => {
    results.push(o);
    opts.out(`  ${o.pass ? "PASS" : "FAIL"}  ${o.name}  (${(o.ms / 1e3).toFixed(1)}s)  ${o.detail}`);
  };
  const repos = [];
  const repo = () => {
    const r = makeRepo();
    repos.push(r);
    return r;
  };
  try {
    for (const agent of sections.includes("core") ? agents : []) {
      opts.out(`${agent}:`);
      for (let i = 1; i <= REPEATS; i++) {
        const n = 10 + i;
        record(
          await timed(`${agent} answer #${i}`, async () => {
            const r = await run(agent, `Reply with only the number ${n * n}. That is ${n} squared.`, repo(), "read", opts.log);
            return { pass: r.text.includes(String(n * n)) && Boolean(r.sessionId), detail: `"${r.text.trim().slice(0, 40)}"` };
          })
        );
      }
      record(
        await timed(`${agent} read-only is enforced`, async () => {
          const dir = repo();
          await run(agent, "Create a file named should-not-exist.txt containing the word hi. Then reply done.", dir, "read", opts.log);
          const exists = existsSync2(join2(dir, "should-not-exist.txt"));
          return { pass: !exists, detail: exists ? "the file WAS created despite read-only access" : "no file created" };
        })
      );
      record(
        await timed(`${agent} edit in worktree`, async () => {
          const dir = repo();
          const wt = await createWorktree({ cwd: dir, home, jobId: `${agent}-${Date.now().toString(36)}`, log: opts.log });
          const steps = [];
          const base = { prompt: "Create a file named created.txt containing the word hello. Then reply done.", cwd: wt.cwd, sessionId: null, timeoutSec: RUN_TIMEOUT_SEC, log: opts.log, model: models[agent] ?? null, onProgress: (m) => steps.push(m) };
          const r = agent === "antigravity" ? await delegateToAntigravity({ ...base, bin: BINS.antigravity, access: "edit" }) : agent === "codex" ? await delegateToCodex({ ...base, bin: BINS.codex, sandbox: "workspace-write" }) : agent === "claude" ? await delegateToClaude({ ...base, bin: BINS.claude, permissionMode: "acceptEdits" }) : await delegateToOpencode({ ...base, bin: BINS.opencode, autoApprove: true });
          const outcome = await finishWorktree(wt, "reliability edit", opts.log);
          const leaked = existsSync2(join2(dir, "created.txt"));
          const pass = outcome.diffStat.includes("created.txt") && !leaked;
          return {
            pass,
            detail: leaked ? "file leaked into the working copy" : pass ? "created.txt committed on the worktree branch" : `no created.txt; steps: [${steps.join(" | ")}]; answer: "${r.text.trim().slice(0, 80)}"; diff: ${outcome.diffStat.split("\n").pop() ?? ""}`
          };
        })
      );
    }
    for (const agent of sections.includes("core") ? agents : []) {
      for (const allow of [false, true]) {
        const label = `${agent} ask -> ${allow ? "allow" : "deny"}`;
        const dir = repo();
        const asked = [];
        const outcome = await timed(label, async () => {
          const r = await runAsk(
            agent,
            "Create a file named asked.txt containing the word hi. Then reply done.",
            dir,
            async (req) => {
              asked.push(`${req.tool}: ${req.detail.slice(0, 60)}`);
              return allow ? { allow: true } : { allow: false, message: "Denied by the reliability test." };
            },
            opts.log
          );
          if (r === null) return { pass: true, detail: "SKIP (not available: see README, permission requests)" };
          const exists = existsSync2(join2(dir, "asked.txt"));
          return {
            pass: asked.length > 0 && exists === allow,
            detail: `asked ${asked.length}x [${asked.join(" | ")}], file ${exists ? "created" : "not created"}`
          };
        });
        record(outcome);
      }
    }
    if (sections.includes("core") && agents.length > 1) {
      opts.out("parallel:");
      record(
        await timed(`parallel (${agents.join(", ")})`, async () => {
          const rs = await Promise.all(agents.map((a, i) => run(a, `Reply with only the word parallel${i}.`, repo(), "read", opts.log)));
          const ok = rs.map((r, i) => r.text.includes(`parallel${i}`));
          return { pass: ok.every(Boolean), detail: agents.map((a, i) => `${a}:${ok[i] ? "ok" : "bad"}`).join(" ") };
        })
      );
    }
    if (sections.includes("core") && agents.includes("codex")) {
      opts.out("cancel:");
      record(
        await timed("codex cancel", async () => {
          const ac = new AbortController();
          const started = Date.now();
          setTimeout(() => ac.abort(), CANCEL_AFTER_MS);
          const p = run("codex", "Count slowly from 1 to 400, one number per line, thinking about each number.", repo(), "read", opts.log, ac.signal);
          const r = await p.then(
            () => "finished",
            (e) => String(e.message)
          );
          const took = Date.now() - started;
          return { pass: r.includes("aborted") && took < CANCEL_AFTER_MS + CANCEL_GRACE_MS, detail: `${r}, stopped after ${(took / 1e3).toFixed(1)}s` };
        })
      );
    }
    if (sections.includes("live")) {
      await runLiveChecks({
        agents,
        bins: BINS,
        models,
        check: async (name, fn) => record(await timed(name, fn)),
        repo,
        out: opts.out,
        log: opts.log
      });
    }
  } finally {
    for (const r of repos) rmSync2(r, { recursive: true, force: true, maxRetries: 3 });
    rmSync2(home, { recursive: true, force: true, maxRetries: 3 });
  }
  const passed = results.filter((r) => r.pass).length;
  opts.out(`
${passed}/${results.length} passed`);
  return passed === results.length ? 0 : 1;
}
export {
  RELIABILITY_SECTIONS,
  runReliability
};
