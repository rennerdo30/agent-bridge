import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LOG_DIR_NAME, MAX_WAIT_SEC } from "../core/constants.js";
import { delegateToCodexAppServer } from "../core/codex-appserver.js";
import type { Logger } from "../core/logger.js";
import type { CodingAgent } from "../core/protocol.js";
import { pluginSourceDir } from "./opencode-install.js";

/**
 * Real-CLI checks of the subagent features that live in the MCP server: live messages to a running
 * subagent, follow-ups with context, recovery after the server restarts, a clean exit, and Codex
 * approvals through app-server. The bundled server (plugins/<host>/dist/server.mjs) runs as a real MCP
 * server over stdio, driven by an MCP client, each time with its own AGENT_BRIDGE_HOME.
 */
const SERVER_BUNDLE = join("dist", "server.mjs");
const JOBS_FILE = "jobs.json";
/** Small files the long task reads one by one, so there is time to talk to it while it works. */
const NOTE_COUNT = 12;
const NOTES_DIR = "notes";
const LONG_TASK =
  `Read the files ${NOTES_DIR}/note-01.txt to ${NOTES_DIR}/note-${String(NOTE_COUNT).padStart(2, "0")}.txt one at a time, in order. ` +
  "Use a separate tool call for each file; never read several files in one call. After each file, write one sentence that summarizes it " +
  "before you read the next one. At the end, list all your summaries.";
const LIVE_QUESTION = "Quick question while you work: how many of the note files have you read so far? Answer in one short sentence, then continue the task.";
const FACT = "pineapple-42";
const FACT_PROMPT = `Remember this for later: the fixture for this task is called ${FACT}. Reply with only the word OK.`;
const FACT_QUESTION = "What is the fixture for this task called? Reply with only its name.";

const JOB_TIMEOUT_SEC = 900;
const SERVER_START_TIMEOUT_MS = 30_000;
const WORKING_TIMEOUT_MS = 180_000;
const ANSWER_TIMEOUT_MS = 300_000;
const RESULT_TIMEOUT_MS = 900_000;
const SESSION_TIMEOUT_MS = 180_000;
const SERVER_EXIT_TIMEOUT_MS = 20_000;
const POLL_MS = 1_000;
/** Extra time for an MCP call on top of the time the tool itself may block. */
const CALL_SLACK_MS = 30_000;
const PROCESS_LIST_TIMEOUT_MS = 30_000;
const APPROVAL_TIMEOUT_SEC = 300;
const DETAIL_CHARS = 80;
/** The first progress line of every run (runfeed.ts): the subagent has not done anything yet. */
const FEED_START = "started ·";

export type Check = (name: string, fn: () => Promise<{ pass: boolean; detail: string }>) => Promise<void>;

export interface LiveOptions {
  agents: CodingAgent[];
  bins: Record<CodingAgent, string>;
  models: Partial<Record<CodingAgent, string>>;
  check: Check;
  /** A fresh git repo (removed by the caller). */
  repo: () => string;
  out: (s: string) => void;
  log: Logger;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: string) => JSON.stringify(s.trim().replace(/\s+/g, " ").slice(0, DETAIL_CHARS));

/** The MCP server that runs `target` subagents: a host cannot delegate to its own kind. */
export function hostFor(target: CodingAgent): CodingAgent {
  return target === "codex" ? "claude" : "codex";
}

/** The bundled MCP server of a plugin (plugins/<host>/dist/server.mjs), next to the CLI or in a checkout. */
export function serverBundle(host: CodingAgent, fromFile?: string): string | null {
  const dir = pluginSourceDir(host, SERVER_BUNDLE, fromFile);
  return dir ? join(dir, SERVER_BUNDLE) : null;
}

/** Job name from a spawn_* result ("Subagent codex-job-1a2b3c4d started. ...") or an ask_* result's follow-up hint. */
export function jobNameIn(text: string): string | null {
  return /Subagent (\S+-job-[0-9a-f]+) started/.exec(text)?.[1] ?? /message_subagent\(job="([^"]+)"/.exec(text)?.[1] ?? null;
}

/** The final result a job posts ("Subagent <name> done after 12s. ..."): its status, else null (a live answer). */
export function finalStatusOf(job: string, body: string): "done" | "failed" | null {
  const m = new RegExp(`^Subagent ${job.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\([^)]*\\) (done|failed) after \\d+s\\.`).exec(body.trim());
  return (m?.[1] as "done" | "failed" | undefined) ?? null;
}

/** The body of the one message a wait_for_message result wraps in <agent-bridge-message ...>. */
export function messageBody(text: string): string {
  return /<agent-bridge-message [^>]*>\n([\s\S]*)\n<\/agent-bridge-message>/.exec(text)?.[1] ?? text;
}

const isApprovalQuestion = (job: string, body: string) => body.trim().startsWith(`Subagent ${job} asks for approval`);

/** A process as the OS lists it; `started` tells a process from a later one with a reused pid. */
export interface Proc {
  pid: number;
  ppid: number;
  pgid?: number;
  started?: string;
}

/** Every running process (Windows: Win32_Process via PowerShell; POSIX: ps with process groups). */
export function listProcesses(): Promise<Proc[]> {
  const win = process.platform === "win32";
  const [file, args] = win
    ? [
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })" }',
        ],
      ]
    : ["ps", ["-A", "-o", "pid=,ppid=,pgid="]];
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROCESS_LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const procs: Proc[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const [a, b, c] = line.trim().split(/\s+/);
        if (!a || !b || !/^\d+$/.test(a)) continue;
        procs.push(win ? { pid: Number(a), ppid: Number(b), started: c } : { pid: Number(a), ppid: Number(b), pgid: Number(c) });
      }
      resolve(procs);
    });
  });
}

/** `root` and every process below it. */
export function processTree(procs: Proc[], root: number): Proc[] {
  const tree = procs.filter((p) => p.pid === root);
  for (let i = 0; i < tree.length; i++) {
    const parent = tree[i]!;
    // pid 0 parents itself on Windows (System Idle Process).
    for (const p of procs) if (p.ppid === parent.pid && p.pid !== parent.pid && !tree.includes(p)) tree.push(p);
  }
  return tree;
}

/**
 * Processes of an earlier tree still alive: the same process (pid and start time) on Windows; on POSIX any
 * member, or any process in a process group the tree's delegates led (they run detached, one group each).
 * `ownGroup` (the suite's, which the server shares) never counts.
 */
export function leftovers(tree: Proc[], now: Proc[], ownGroup?: number): Proc[] {
  const same = (a: Proc, b: Proc) => a.pid === b.pid && (a.started === undefined || a.started === b.started);
  const groups = new Set(tree.map((p) => p.pgid).filter((g): g is number => g !== undefined && g !== ownGroup));
  return now.filter((p) => tree.some((t) => same(t, p)) || (p.pgid !== undefined && groups.has(p.pgid)));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface StoredJob {
  name: string;
  status: string;
  sessionId: string | null;
}

function storedJob(home: string, job: string): StoredJob | null {
  try {
    const all = JSON.parse(readFileSync(join(home, JOBS_FILE), "utf8")) as StoredJob[];
    return all.find((j) => j.name === job) ?? null;
  } catch {
    return null;
  }
}

/** Logged by the host when the subagent fetched messages over its live link (parent-link.ts). */
const PICKED_UP_LOG = "subagent picked up messages";

/** Whether any agent-bridge log in this home contains `text`. */
function logsMention(home: string, text: string): boolean {
  try {
    const dir = join(home, LOG_DIR_NAME);
    return readdirSync(dir).some((f) => readFileSync(join(dir, f), "utf8").includes(text));
  } catch {
    return false;
  }
}

async function until<T>(timeoutMs: number, fn: () => Promise<T | null | undefined> | T | null | undefined): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > end) return null;
    await sleep(POLL_MS);
  }
}

/** A bundled agent-bridge MCP server driven over stdio, as the host agent would. */
class LiveHost {
  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
    readonly pid: number,
  ) {}

  static async start(bundle: string, host: CodingAgent, home: string, cwd: string): Promise<LiveHost> {
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
        AGENT_BRIDGE_AUTO_WAKE: "off",
      } as Record<string, string>,
      stderr: "ignore",
    });
    const client = new Client({ name: "agent-bridge-reliability", version: "0.0.0" });
    await client.connect(transport, { timeout: SERVER_START_TIMEOUT_MS });
    return new LiveHost(client, transport, transport.pid ?? 0);
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = CALL_SLACK_MS): Promise<{ text: string; isError: boolean }> {
    const r = (await this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as { content?: { text?: string }[]; isError?: boolean };
    return { text: (r.content ?? []).map((c) => c.text ?? "").join("\n"), isError: Boolean(r.isError) };
  }

  /** The next message from the job (approval questions it asks are denied), or null after the timeout. */
  async next(job: string, timeoutMs: number): Promise<string | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const sec = Math.max(1, Math.min(MAX_WAIT_SEC, Math.ceil((end - Date.now()) / 1000)));
      const r = await this.call("wait_for_message", { from: job, timeout_sec: sec }, sec * 1000 + CALL_SLACK_MS);
      if (r.isError) await sleep(POLL_MS);
      if (r.isError || /^No message arrived/.test(r.text)) continue;
      const body = messageBody(r.text);
      if (isApprovalQuestion(job, body)) {
        await this.call("message_subagent", { job, message: "deny: the reliability suite allows nothing here" });
        continue;
      }
      return body;
    }
    return null;
  }

  /** Wait for the job's final result, skipping other messages. */
  async result(job: string, timeoutMs: number): Promise<{ status: "done" | "failed"; body: string } | null> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const body = await this.next(job, end - Date.now());
      if (body === null) return null;
      const status = finalStatusOf(job, body);
      if (status) return { status, body };
    }
  }

  /** Progress line of a running job in `peers`, once it reports a real step (not just its start). */
  async working(job: string): Promise<string | null> {
    const peers = await this.call("peers", {});
    const line = peers.text.split("\n").find((l) => l.startsWith(`- ${job} (`));
    const progress = line?.slice(line.indexOf("): ") + 3).trim();
    return progress && progress !== "starting" && !progress.startsWith(FEED_START) ? progress : null;
  }

  /** Status of a finished (or interrupted) job as `peers` lists it. */
  async listedStatus(job: string): Promise<string | null> {
    const peers = await this.call("peers", {});
    return new RegExp(`^- ${job}: (\\w+)`, "m").exec(peers.text)?.[1] ?? null;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
    await until(SERVER_EXIT_TIMEOUT_MS, () => (alive(this.pid) ? null : true));
  }
}

function writeNotes(dir: string): void {
  mkdirSync(join(dir, NOTES_DIR), { recursive: true });
  for (let i = 1; i <= NOTE_COUNT; i++) {
    writeFileSync(join(dir, NOTES_DIR, `note-${String(i).padStart(2, "0")}.txt`), `Note ${i}: the garden bed number ${i} gets ${i * 2} liters of water on day ${i}.\n`);
  }
}

async function killLeft(procs: Proc[]): Promise<void> {
  for (const p of procs) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // gone meanwhile
    }
  }
}

/** Live message, follow-up with context, restart recovery and clean exit, per agent; Codex app-server approvals. */
export async function runLiveChecks(o: LiveOptions): Promise<void> {
  const homes: string[] = [];
  const newHome = () => {
    const h = mkdtempSync(join(tmpdir(), "agent-bridge-rel-live-"));
    homes.push(h);
    return h;
  };
  const model = (agent: CodingAgent) => (o.models[agent] ? { model: o.models[agent] } : {});
  const spawnLong = async (host: LiveHost, agent: CodingAgent): Promise<string> => {
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

      // 1 + 2: one server; a long background job gets a live question, then a quick ask_* gets a follow-up.
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
              if (!progress) return { pass: false, detail: `${job} never reported working within ${WORKING_TIMEOUT_MS / 1000}s` };
              const sent = await server.call("message_subagent", { job, message: LIVE_QUESTION });
              if (!/still working/.test(sent.text)) return { pass: false, detail: `message_subagent: ${short(sent.text)}` };
              const first = await server.next(job, ANSWER_TIMEOUT_MS);
              if (first === null) return { pass: false, detail: `no message from ${job} within ${ANSWER_TIMEOUT_MS / 1000}s` };
              const status = finalStatusOf(job, first);
              if (status) {
                const seen = logsMention(home, PICKED_UP_LOG) ? "it picked up the message but did not answer before finishing" : "it never picked up the message";
                return { pass: false, detail: `the final result (${status}) arrived before any answer: ${seen}; working was: ${short(progress)}` };
              }
              const final = await server.result(job, RESULT_TIMEOUT_MS);
              return {
                pass: final !== null,
                detail: `answer before the result: ${short(first)}; result: ${final ? final.status : "none in time"}`,
              };
            } finally {
              await server.call("cancel_subagent", { job }).catch(() => {});
            }
          });

          await o.check(`${agent} follow-up keeps context`, async () => {
            const asked = await server.call(`ask_${agent}`, { title: "Reliability: remember a fact", prompt: FACT_PROMPT, ...model(agent) }, RESULT_TIMEOUT_MS);
            const job = jobNameIn(asked.text);
            if (asked.isError || !job) return { pass: false, detail: `ask_${agent}: ${short(asked.text)}` };
            const sent = await server.call("message_subagent", { job, message: FACT_QUESTION });
            if (!/^Sent to/.test(sent.text)) return { pass: false, detail: `message_subagent: ${short(sent.text)}` };
            const final = await server.result(job, RESULT_TIMEOUT_MS);
            if (!final) return { pass: false, detail: `no answer from ${job} within ${RESULT_TIMEOUT_MS / 1000}s` };
            const answer = final.body.split("\n").slice(2).join(" ");
            return { pass: final.status === "done" && final.body.includes(FACT), detail: `${final.status}: ${short(answer)}` };
          });
        } finally {
          await server.close();
        }
      }

      // 3 + 4: close the server while a job runs; nothing may be left running; a new server recovers the job.
      {
        const home = newHome();
        const cwd = o.repo();
        writeNotes(cwd);
        let server: LiveHost | null = await LiveHost.start(bundle, host, home, cwd);
        let job: string | null = null;
        let before: StoredJob | null = null;
        try {
          await o.check(`${agent} clean exit`, async () => {
            job = await spawnLong(server!, agent);
            const name = job;
            before = await until(SESSION_TIMEOUT_MS, () => {
              const s = storedJob(home, name);
              return s?.sessionId ? s : null;
            });
            if (!before) return { pass: false, detail: `${name} has no session in ${JOBS_FILE} after ${SESSION_TIMEOUT_MS / 1000}s` };
            const all = await listProcesses();
            const tree = processTree(all, server!.pid);
            const ownGroup = all.find((p) => p.pid === process.pid)?.pgid;
            await server!.close();
            server = null;
            const left = leftovers(tree, await listProcesses(), ownGroup);
            await killLeft(left);
            return {
              pass: tree.length > 1 && left.length === 0,
              detail:
                tree.length <= 1
                  ? "the server had no child processes to check (the job was not running)"
                  : left.length
                    ? `${left.length} of ${tree.length} processes left running: pids ${left.map((p) => p.pid).join(", ")}`
                    : `all ${tree.length} processes of the server's tree ended`,
            };
          });

          await o.check(`${agent} recovery after a restart`, async () => {
            const name = job as string | null;
            const kept = before as StoredJob | null;
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
              detail:
                `${JOBS_FILE}: ${onDisk}, restored as ${listed ?? "unlisted"} -> started; result ${final?.status ?? "none in time"}; ` +
                `session ${sameSession ? "same" : `changed ${kept.sessionId} -> ${after?.sessionId ?? "none"}`}`,
            };
          });
        } finally {
          await server?.close();
        }
      }
    }

    // 5: Codex approvals through app-server, called directly (the parent's decision is the `approve` callback).
    if (o.agents.includes("codex")) {
      o.out("codex app-server approvals:");
      for (const allow of [true, false]) {
        await o.check(`codex app-server ask -> ${allow ? "allow" : "deny"}`, async () => {
          const dir = o.repo();
          const asked: string[] = [];
          const r = await delegateToCodexAppServer({
            prompt: "Run this shell command in the current folder: echo hi > asked.txt\nIt creates a file named asked.txt. Then reply done.",
            cwd: dir,
            sessionId: null,
            timeoutSec: APPROVAL_TIMEOUT_SEC,
            model: o.models.codex ?? null,
            log: o.log,
            bin: o.bins.codex,
            sandbox: "read-only",
            askMode: true,
            approve: async (req) => {
              asked.push(`${req.tool}: ${req.detail.slice(0, 60)}`);
              return allow ? { allow: true } : { allow: false, message: "Denied by the reliability check." };
            },
          });
          const exists = existsSync(join(dir, "asked.txt"));
          const relevant = asked.filter((a) => !a.startsWith("mcp:"));
          return {
            pass: relevant.length > 0 && exists === allow,
            detail: `asked ${relevant.length}x [${relevant.join(" | ")}], file ${exists ? "created" : "not created"}; answer ${short(r.text)}`,
          };
        });
      }
      await o.check("codex app-server read-only refuses escalation without asking", async () => {
        const dir = o.repo();
        const asked: string[] = [];
        const r = await delegateToCodexAppServer({
          prompt:
            "Create a file named should-not-exist.txt containing the word hi, for example with the shell command: echo hi > should-not-exist.txt\n" +
            "If the sandbox blocks it, request escalated permissions and try again. Then reply done.",
          cwd: dir,
          sessionId: null,
          timeoutSec: APPROVAL_TIMEOUT_SEC,
          model: o.models.codex ?? null,
          log: o.log,
          bin: o.bins.codex,
          sandbox: "read-only",
          approve: async (req) => {
            asked.push(`${req.tool}: ${req.detail.slice(0, 60)}`);
            return { allow: true };
          },
        });
        const exists = existsSync(join(dir, "should-not-exist.txt"));
        const relevant = asked.filter((a) => !a.startsWith("mcp:"));
        return {
          pass: !exists && relevant.length === 0,
          detail: exists
            ? "the file WAS created"
            : relevant.length
              ? `the parent was asked ${relevant.length}x [${relevant.join(" | ")}]`
              : `refused without asking, no file; answer ${short(r.text)}`,
        };
      });
    }
  } finally {
    for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 3 });
  }
}
