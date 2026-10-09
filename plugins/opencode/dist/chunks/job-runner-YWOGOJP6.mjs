import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ProjectGroups
} from "./chunk-I67Y7CTU.mjs";
import {
  guardRunnerErrors
} from "./chunk-Q4TGWKCP.mjs";
import {
  CONTROL_CONVERSATION_PREFIX,
  JOB_PEER_PREFIX,
  RUNNER_HEARTBEAT_MS,
  acquireStartup,
  resumeArgs,
  runDelegate,
  writeRunnerState
} from "./chunk-5RINX7BT.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import {
  closeJobWorktree
} from "./chunk-GYLVKDDN.mjs";
import {
  recordWorktreeProcessProof
} from "./chunk-4WNR2ZEI.mjs";
import "./chunk-5ZEJOPHU.mjs";
import "./chunk-BG6KJS4H.mjs";
import {
  BridgeNode
} from "./chunk-APJYU52D.mjs";
import "./chunk-3EY3DDNH.mjs";
import "./chunk-FXE3YU37.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-Q3G4DMR2.mjs";
import "./chunk-6RB6C67Z.mjs";
import "./chunk-HFRXC4WN.mjs";
import {
  NOTE_CONVERSATION_SUFFIX,
  QUEUED_FOLLOW_UP_NOTE,
  canControlJob,
  changedJobArgs,
  failureCause,
  jobReport,
  readStore,
  sessionOfError,
  waitForApproval,
  worktreeProcessReport,
  worktreeProcesses
} from "./chunk-FPEL5ATD.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-5XNDUN5I.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath,
  resolvePipePath
} from "./chunk-IPUCLIQI.mjs";
import {
  COMPLETION_DEDUPE_PREFIX
} from "./chunk-JTZGNEMM.mjs";
import {
  isPureAcknowledgement
} from "./chunk-M26SH6VN.mjs";
import {
  loadOrCreateToken
} from "./chunk-V4WDBMEN.mjs";
import "./chunk-REI4SNBR.mjs";
import "./chunk-3G4ZOXSN.mjs";
import "./chunk-MTPVESBQ.mjs";
import {
  ACK_CONVERSATION_SUFFIX,
  QUESTION_CONVERSATION_SUFFIX,
  SIBLING_CONVERSATION_PREFIX
} from "./chunk-4QXHCXBU.mjs";
import "./chunk-Z5HOHKIC.mjs";
import "./chunk-JNVJDIQM.mjs";
import "./chunk-FDMEMG4Z.mjs";
import {
  takeRunnerSpec
} from "./chunk-T66G2PBQ.mjs";
import "./chunk-OHEXUZVX.mjs";
import "./chunk-TFQZM67X.mjs";
import {
  createLogger,
  refreshStorePeerIdentities
} from "./chunk-JQ2ZLG74.mjs";
import "./chunk-4EDVJNL7.mjs";
import {
  JOBS_FILE
} from "./chunk-7EOIPV3B.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/mcp/job-runner.ts
import { join as join2 } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// src/core/windows-job-scope.ts
import { spawn } from "node:child_process";
import { join } from "node:path";
var GUARD = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
public static class BridgeJobScope {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet, maxWorkingSet;
    public uint activeProcessLimit; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong read, write, other, readBytes, writeBytes, otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits basic; public IoCounters io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static int[] Members(IntPtr job, int runner) {
    for (int size=4096; size<=8388608; size*=2) {
      IntPtr data=Marshal.AllocHGlobal(size);
      try {
        if (!QueryInformationJobObject(job, 3, data, (uint)size, IntPtr.Zero)) {
          if (Marshal.GetLastWin32Error()==234) continue;
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        int count=Marshal.ReadInt32(data, 4);
        if (count> (size-8)/IntPtr.Size || Marshal.ReadInt32(data, 0)>count) continue;
        var ids=new List<int>();
        for (int n=0; n<count; n++) {
          int pid=(int)Marshal.ReadIntPtr(data, 8+n*IntPtr.Size).ToInt64();
          if (pid!=runner) ids.Add(pid);
        }
        return ids.ToArray();
      } finally { Marshal.FreeHGlobal(data); }
    }
    throw new Exception("Job membership list exceeded its bound");
  }
  static void Cleanup(IntPtr job, int runner) {
    var stopped=new HashSet<int>();
    DateTime deadline=DateTime.UtcNow.AddSeconds(5);
    int[] remaining;
    do {
      remaining=Members(job, runner);
      if (remaining.Length==0) break;
      foreach (int pid in remaining) {
        // Keep the handle through the membership check and termination. A reused PID outside
        // this job can never pass IsProcessInJob, even if it appeared in the prior snapshot.
        IntPtr process=OpenProcess(0x00101001, false, pid);
        if (process==IntPtr.Zero) continue;
        try {
          bool member;
          if (IsProcessInJob(process, job, out member) && member && TerminateProcess(process, 1)) stopped.Add(pid);
        } finally { CloseHandle(process); }
      }
      Thread.Sleep(10);
    } while (DateTime.UtcNow<deadline);
    remaining=Members(job, runner);
    Console.WriteLine("{\"type\":\"cleaned\",\"stopped\":["+String.Join(",",stopped)+"],\"remaining\":["+String.Join(",",remaining)+"]}");
    Console.Out.Flush();
  }
  public static void Run(int runner) {
    IntPtr job=CreateJobObject(IntPtr.Zero, null);
    Check(job!=IntPtr.Zero);
    IntPtr owner=IntPtr.Zero;
    try {
      // Setup is provisional until Node accepts readiness. Killing a timed-out guardian
      // must never kill the runner it may have just assigned.
      var limits=new Limits();
      int size=Marshal.SizeOf(limits); IntPtr data=Marshal.AllocHGlobal(size);
      try { Marshal.StructureToPtr(limits, data, false); Check(SetInformationJobObject(job, 9, data, (uint)size)); }
      finally { Marshal.FreeHGlobal(data); }
      owner=OpenProcess(0x00101101, false, runner); Check(owner!=IntPtr.Zero);
      Check(AssignProcessToJobObject(job, owner));
      Console.WriteLine("{\"type\":\"ready\"}"); Console.Out.Flush();
      // Only an accepted scope enables KILL_ON_JOB_CLOSE; no breakaway permission.
      if (Console.ReadLine()!="retain") return;
      limits.basic.flags=0x2000;
      data=Marshal.AllocHGlobal(size);
      try { Marshal.StructureToPtr(limits, data, false); Check(SetInformationJobObject(job, 9, data, (uint)size)); }
      finally { Marshal.FreeHGlobal(data); }
      Console.WriteLine("{\"type\":\"retained\"}"); Console.Out.Flush();
      string command;
      while ((command=Console.ReadLine())!=null) {
        if (command=="cleanup") Cleanup(job, runner);
      }
      // EOF releases the runner's pipes, not the containment. Closing this last job handle
      // after owner exit also catches tools started while the final report was being delivered.
      WaitForSingleObject(owner, 0xffffffff);
    } finally {
      if (owner!=IntPtr.Zero) CloseHandle(owner);
      CloseHandle(job);
    }
  }
}
`;
function startWindowsJobScope(log, runnerPid = process.pid) {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows job scopes require Windows"));
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); Add-Type -TypeDefinition @'\n" + GUARD + "\n'@; [BridgeJobScope]::Run(" + runnerPid + ")";
  const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const guardian = spawn(bin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stderr = "", buffer = "", ready = false, failed = false, retaining = false;
    let pending = null;
    const fail = (err) => {
      clearTimeout(startup);
      if (!ready && !failed) {
        failed = true;
        reject(err);
      }
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(err);
        pending = null;
      }
    };
    const startup = setTimeout(() => {
      fail(new Error("Windows job ownership setup timed out"));
      if (!retaining) guardian.kill();
      else {
        guardian.stdin.end();
        guardian.stdout?.unref?.();
        guardian.stderr?.unref?.();
        guardian.unref();
      }
    }, 8e3);
    guardian.on("error", fail);
    guardian.on("exit", (code) => fail(new Error("Windows job guardian exited (" + code + "): " + stderr.slice(-2e3))));
    guardian.stdin.on("error", fail);
    guardian.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4e3);
    });
    guardian.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "ready" && !ready && !failed && !retaining) {
          retaining = true;
          guardian.stdin.write("retain\n");
        } else if (message.type === "retained" && !ready && !failed) {
          ready = true;
          clearTimeout(startup);
          log.info("job process ownership established", { runnerPid, guardianPid: guardian.pid, method: "private Windows job object" });
          resolve({
            guardian,
            cleanup: () => new Promise((yes, no) => {
              if (pending) return no(new Error("Job cleanup already in progress"));
              if (guardian.exitCode !== null || guardian.signalCode !== null) return no(new Error("Windows job guardian is gone"));
              pending = { resolve: yes, reject: no, timer: setTimeout(() => {
                if (pending) {
                  pending.reject(new Error("Windows job cleanup timed out"));
                  pending = null;
                }
              }, 1e4) };
              guardian.stdin.write("cleanup\n");
            }),
            detach: () => {
              guardian.stdin.end();
              guardian.stdout.destroy();
              guardian.stderr.destroy();
              guardian.unref();
            }
          });
        } else if (message.type === "cleaned" && pending) {
          clearTimeout(pending.timer);
          const result = { stopped: message.stopped, remaining: message.remaining };
          log.info("job background process cleanup", { ...result });
          pending.resolve(result);
          pending = null;
        }
      }
    });
  });
}
function processCleanupReport(result) {
  const ids = (pids) => pids.length ? " (PIDs " + pids.join(", ") + ")" : "";
  return "Background process cleanup: stopped " + result.stopped.length + " surviving job-owned processes" + ids(result.stopped) + "; " + result.remaining.length + " still running" + ids(result.remaining) + ".";
}
async function establishWindowsJobScope(log, start = () => startWindowsJobScope(log)) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await start();
    } catch (err) {
      log.warn("Windows job ownership setup failed", { attempt, attempts: 2, error: err.message });
    }
  }
  log.warn("job running in degraded process ownership mode", { cleanup: "private Windows job object unavailable; delegate process cleanup remains active" });
  return null;
}

// src/mcp/job-runner.ts
var SEND_ATTEMPTS = 30;
var SEND_RETRY_MAX_MS = 1e4;
var PROGRESS_SAVE_MS = 1e3;
var SEEN_LIMIT = 100;
var STOP_DEADLINE_MS = 15e3;
var INITIAL_STATE_DEADLINE_MS = 15e3;
async function publishInitialRunnerState(spec, log) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Job runner stopped before initial state publication"));
  const deadline = setTimeout(() => controller.abort(new Error("Job runner initial state publication timed out")), INITIAL_STATE_DEADLINE_MS);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    for (let attempt = 0; ; attempt++) {
      await refreshStorePeerIdentities(spec.home, controller.signal);
      controller.signal.throwIfAborted();
      try {
        writeRunnerState(spec.home, spec.job.id, { pid: process.pid, peer: spec.job.name, status: "running", updatedAt: Date.now(), progress: "queued: runner startup admission" });
        return;
      } catch (error) {
        if (error.code !== "STORE_UPGRADE_DEFERRED") throw error;
        if (attempt === 0) log.info("initial runner state waits for retained store readers", { job: spec.job.name, reason: String(error) });
        await delay(Math.min(1e3, (attempt + 1) * 100), void 0, { signal: controller.signal });
      }
    }
  } finally {
    clearTimeout(deadline);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
async function runJobRunner(specFile) {
  if (!specFile) return 2;
  const data = takeRunnerSpec(specFile);
  if (!data) return 2;
  const spec = data;
  const { home } = spec;
  const log = createLogger({ home, component: "job-runner" }).child(spec.job.name);
  let scope = null;
  const releaseErrorGuards = guardRunnerErrors(log);
  try {
    await publishInitialRunnerState(spec, log);
    if (process.platform === "win32") {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      try {
        const release = await acquireStartup(home, controller.signal);
        try {
          controller.signal.throwIfAborted();
          scope = await establishWindowsJobScope(log);
        } finally {
          release();
        }
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
    }
    return await runOwnedJobRunner(spec, log, scope);
  } catch (error) {
    log.error("job runner failed", { err: String(error?.stack ?? error) });
    throw error;
  } finally {
    try {
      scope?.detach();
    } finally {
      releaseErrorGuards();
    }
  }
}
async function runOwnedJobRunner(spec, log, scope) {
  const { home, target } = spec;
  const job = {
    ...spec.job,
    controller: new AbortController(),
    progress: null,
    status: "running",
    queue: [],
    allowedServers: new Set(spec.job.allowedServers)
  };
  let owner = spec.owner;
  const refreshOwner = () => {
    const saved = readStore(join2(home, JOBS_FILE)).find((j) => j.id === job.id);
    if (!saved) return;
    owner = saved.owner ?? owner;
    Object.assign(job, {
      owner,
      supervisor: saved.supervisor,
      parentJob: saved.parentJob,
      rootSession: saved.rootSession,
      rootName: saved.rootName,
      ownershipHistory: saved.ownershipHistory,
      masters: saved.masters,
      args: { ...job.args, send_to: saved.args?.send_to }
    });
  };
  const seen = [];
  let closing = false;
  let extra = { status: "running" };
  const save = (patch = {}) => {
    extra = { ...extra, ...patch };
    try {
      refreshOwner();
      writeRunnerState(home, job.id, {
        pid: process.pid,
        peer: node.name,
        status: "running",
        ...extra,
        updatedAt: Date.now(),
        model: job.model,
        sessionId: job.sessionId,
        workdir: job.workdir,
        worktree: job.worktree,
        progress: job.progress,
        percent: job.percent,
        progressNote: job.progressNote,
        etaAt: job.etaAt,
        etaReportedAt: job.etaReportedAt,
        asking: Boolean(job.pendingApproval),
        live: Boolean(job.live),
        seen: seen.slice(-SEEN_LIMIT)
      });
    } catch (err) {
      log.warn("could not write the job runner state", { err: err.message });
    }
  };
  const node = new BridgeNode({
    pipePath: resolvePipePath(home),
    token: loadOrCreateToken(home),
    dbPath: resolveDbPath(home),
    // "other" keeps an older broker from routing "any codex" mail here; a current one hides the runner anyway.
    agent: "other",
    jobAgent: job.agent,
    jobOwner: job.supervisor ?? job.owner ?? owner,
    jobParent: owner,
    parentJob: job.parentJob,
    rootSession: job.rootSession,
    rootName: job.rootName,
    jobTitle: typeof job.args?.title === "string" ? job.args.title : spec.args.title,
    jobSendTo: spec.args.send_to,
    id: `${JOB_PEER_PREFIX}${job.id}`,
    name: job.name,
    cwd: spec.cwd,
    autoWake: false,
    // A session hosts the bridge; without one, messages wait here (and the report in the state file).
    canHostBroker: false,
    log
  });
  save();
  const heartbeat = setInterval(() => save(), RUNNER_HEARTBEAT_MS);
  log.info("job runner started", { pid: process.pid, target, owner });
  let chain = Promise.resolve();
  const deliver = async (body, replyTo, note = false, key, question = false) => {
    const dedupeKey = key ?? randomUUID();
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      try {
        refreshOwner();
        const suffix = isPureAcknowledgement(body) ? ACK_CONVERSATION_SUFFIX : question ? QUESTION_CONVERSATION_SUFFIX : note ? NOTE_CONVERSATION_SUFFIX : "";
        return await node.send({ to: owner, body, conversationId: `job-${job.id}${suffix}`, ...replyTo ? { replyTo } : {}, dedupeKey }, { quiet: true });
      } catch (err) {
        log.warn("could not deliver to the session; retrying", { owner, attempt, err: err.message });
        await new Promise((r) => setTimeout(r, Math.min(attempt * 1e3, SEND_RETRY_MAX_MS)));
      }
    }
    return null;
  };
  const inOrder = (body, replyTo, note, key, question = false) => {
    const sent = chain.then(() => deliver(body, replyTo, note, key, question));
    chain = sent;
    return sent;
  };
  const post = (body, replyTo = null, note = false, key) => inOrder(body, replyTo, note, key).then((result) => result !== null);
  const ask = async (body, replyTo) => {
    const result = await inOrder(body, replyTo, false, void 0, true);
    return questionRoute(result, owner, async (name) => (await node.peers()).some((p) => p.name === name && p.projectMain === true));
  };
  const sink = {
    persist: () => save(),
    escalateApproval: async (_job, body) => {
      await post(body);
    },
    askParent: (j, question, timeoutMs, request) => {
      const answer = waitForApproval(j, question, timeoutMs, (body) => void post(body), log, home, request);
      save();
      return answer.finally(() => save());
    },
    // Its own status notes do not wake the session (see JobManager.fromSubagent); answers and replies do.
    fromSubagent: (j, body, replyTo, isAnswer, forceNote, question) => {
      const answer = !forceNote && (Boolean(isAnswer) || replyTo !== null || j.awaitingAnswer === true);
      if (!forceNote && !isPureAcknowledgement(body)) j.awaitingAnswer = false;
      if (question && !forceNote && !isPureAcknowledgement(body)) return ask(body, replyTo);
      void post(body, replyTo, !answer);
    },
    note: (j, facts) => {
      if (facts.sessionId) j.sessionId = facts.sessionId;
      if (facts.workdir) j.workdir = facts.workdir;
      if (facts.worktree) j.worktree = facts.worktree;
      save();
    }
  };
  const handleControl = async (m) => {
    if (m.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX)) return;
    if (!m.conversationId.startsWith(CONTROL_CONVERSATION_PREFIX)) {
      log.warn("unsupported ordinary job mail retained unread", { from: m.from.name, id: m.id });
      return;
    }
    if (owner.includes("/") && m.from.name !== owner) {
      log.warn("ignoring remote job control from another supervisor", { from: m.from.name });
      return;
    }
    let c;
    try {
      c = JSON.parse(m.body);
    } catch {
      return;
    }
    if (c.type === "cancel" && !isCurrentRunnerCancel(m.createdAt, spec.job.startedAt)) {
      log.info("ignoring cancellation from an earlier job turn", { createdAt: m.createdAt, startedAt: spec.job.startedAt });
      return;
    }
    refreshOwner();
    if (!owner.includes("/") && !canControlJob(job, m.from.name)) {
      const peers = await node.peers();
      const master = peers.find((p) => p.name === m.from.name);
      if (!master || !new ProjectGroups(home).canControl(master, job, peers)) return;
    }
    if (m.from.name !== owner) log.info("job control received from another session", { name: m.from.name, owner });
    void node.updateJob({ jobParent: owner }).catch(() => {
    });
    if (c.type === "message") {
      if (closing) return;
      if (!seen.includes(c.cid)) {
        if (job.live) {
          job.awaitingAnswer = true;
          job.live.post(c.body);
        } else job.queue.push(c.body);
        seen.push(c.cid);
      }
      save();
    } else if (c.type === "title") {
      job.args = { ...job.args, title: c.title };
      job.retitle?.(c.title);
    } else if (c.type === "effort") {
      job.args = { ...job.args, effort: c.effort };
      save();
    } else if (c.type === "settings") {
      job.args = changedJobArgs(job.args, c.settings);
      save();
    } else if (c.type === "cancel") {
      log.info("cancelled by the session");
      job.queue = [];
      job.controller.abort();
    }
    node.markRead([m.id]);
  };
  let controls = Promise.resolve();
  const controlRetries = /* @__PURE__ */ new Map();
  const onControl = (m) => {
    controls = controls.then(() => handleControl(m)).catch((err) => {
      log.warn("job control deferred; active turn kept running", { id: m.id, err: String(err) });
      if (!closing && !controlRetries.has(m.id)) {
        const timer = setTimeout(() => {
          controlRetries.delete(m.id);
          onControl(m);
        }, 1e3);
        timer.unref();
        controlRetries.set(m.id, timer);
      }
    });
  };
  node.on("message", onControl);
  const stop = () => {
    job.queue = [];
    job.controller.abort();
    setTimeout(() => process.exit(1), STOP_DEADLINE_MS).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  void node.start().catch((err) => log.warn("could not join the bridge yet; retrying in the background", { err: err.message }));
  let saveTimer = null;
  const onProgress = (message) => {
    job.progress = message;
    saveTimer ??= setTimeout(() => {
      saveTimer = null;
      save();
    }, PROGRESS_SAVE_MS);
  };
  const rc = { agent: spec.byAgent, cfg: spec.cfg, home, log, me: () => owner, cwd: () => spec.cwd, jobs: sink, jobNode: node };
  let args = spec.args;
  for (; ; ) {
    let status;
    let text = "";
    let cause = null;
    let processesStopped = false;
    try {
      const res = await runDelegate(rc, target, args, job.controller.signal, onProgress, true, job);
      job.workdir = res.workdir ?? job.workdir;
      job.worktree = res.worktree ?? job.worktree;
      job.sessionId = res.sessionId ?? job.sessionId;
      status = res.status ?? (res.isError ? "failed" : "done");
      text = res.text || "(no answer text returned)";
      cause = res.isError ? failureCause({ result: res }) : null;
    } catch (err) {
      job.sessionId = sessionOfError(err) ?? job.sessionId;
      status = "failed";
      cause = failureCause({ error: err });
    }
    if (scope) {
      try {
        const cleanup = await scope.cleanup();
        processesStopped = cleanup.remaining.length === 0;
        text += "\n\n" + processCleanupReport(cleanup);
        if (cleanup.remaining.length) {
          status = "failed";
          cause = "job-owned background processes did not stop: " + cleanup.remaining.join(", ");
        }
      } catch (err) {
        status = "failed";
        cause = "job process cleanup failed: " + err.message;
        log.error("job process cleanup failed", { cause });
        text += "\n\n" + cause + ". Ownership containment remains active until the runner exits.";
      }
    }
    if (!scope && job.worktree?.path) {
      text += "\n\n" + worktreeProcessReport(await worktreeProcesses(job.worktree.path));
    }
    job.etaAt = void 0;
    if (job.worktree) recordWorktreeProcessProof(home, job.worktree, processesStopped);
    if (job.controller.signal.aborted && processesStopped) {
      const cleanup = await closeJobWorktree({ home, job: { ...job, status }, enabled: spec.cfg.jobCloseCleanup, log });
      text += `

Worktree close: ${cleanup.action}: ${cleanup.reason}`;
    }
    job.etaReportedAt = void 0;
    if (job.controller.signal.aborted) status = "cancelled";
    const report = jobReport(job, status, Math.round((Date.now() - job.startedAt) / 1e3), text, cause);
    log.info("job turn finished", { status, sessionId: job.sessionId, cause });
    if (job.queue.length && job.sessionId && !job.controller.signal.aborted) {
      const queued = job.queue.splice(0).join("\n\n");
      void post(`${report}

${QUEUED_FOLLOW_UP_NOTE}`);
      args = resumeArgs(spec.base, job.name, queued, job.sessionId, job.workdir, job.worktree, job.args);
      if (args.model !== void 0) job.model = args.model;
      job.startedAt = Date.now();
      job.progress = null;
      save();
      continue;
    }
    closing = true;
    if (saveTimer) clearTimeout(saveTimer);
    const reportId = randomUUID();
    save({ status, report, reportId, delivered: false, finishedAt: Date.now() });
    const delivered = await post(report, null, false, `${COMPLETION_DEDUPE_PREFIX}${reportId}`);
    save({ delivered });
    log.info("job runner done", { status, delivered });
    break;
  }
  clearInterval(heartbeat);
  for (const timer of controlRetries.values()) clearTimeout(timer);
  node.off("message", onControl);
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  await node.stop();
  return 0;
}
function isCurrentRunnerCancel(createdAt, startedAt) {
  return createdAt >= startedAt;
}
async function questionRoute(result, parent, isMain) {
  if (!result) return { state: "unconfirmed", parent };
  const delivered = result.deliveredTo[0];
  if (delivered === parent) return { state: "delivered", parent };
  if (delivered) return { state: "rerouted", parent, recipient: delivered, main: await isMain(delivered).catch(() => false) };
  return { state: "queued", parent, recipient: result.queuedFor[0] ?? parent };
}
export {
  isCurrentRunnerCancel,
  questionRoute,
  runJobRunner
};
