import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CLAUDE_BIN, DEFAULT_CODEX_BIN, DEFAULT_OPENCODE_BIN } from "../core/constants.js";
import { delegateToClaude, delegateToCodex, delegateToOpencode, resolveBinary, type DelegateResult } from "../core/delegate.js";
import type { Logger } from "../core/logger.js";
import type { CodingAgent } from "../core/protocol.js";
import { delegateToAntigravity } from "../core/antigravity.js";
import { createWorktree, finishWorktree } from "../core/worktree.js";
import { codexPermissionHookTrusted } from "../core/codex-trust.js";
import { resolveHome } from "../core/paths.js";
import { delegateToOpencodeServed } from "../core/opencode-served.js";
import { PermissionRelay, type PermissionDecision, type PermissionRequest } from "../core/relay.js";
import { runLiveChecks } from "./reliability-live.js";

/**
 * A measured run of real delegations (costs tokens): repeated short answers, read-only enforcement,
 * worktree edits, parallel runs and cancellation, per installed CLI ("core"), plus the subagent features
 * of the MCP server: live messages, follow-ups, restart recovery, clean exit, Codex approvals ("live",
 * see reliability-live.ts).
 */
const RUN_TIMEOUT_SEC = 300;
const REPEATS = 3;
const CANCEL_AFTER_MS = 8_000;
const CANCEL_GRACE_MS = 10_000;
const BINS: Record<CodingAgent, string> = { claude: DEFAULT_CLAUDE_BIN, codex: DEFAULT_CODEX_BIN, opencode: DEFAULT_OPENCODE_BIN, antigravity: "agy" };

type Access = "read" | "edit";
export type ReliabilitySection = "core" | "live";
export const RELIABILITY_SECTIONS: readonly ReliabilitySection[] = ["core", "live"];
/** Model per agent (e.g. a cheap one for the long live tasks); none = the CLI's default. */
let models: Partial<Record<CodingAgent, string>> = {};

function run(agent: CodingAgent, prompt: string, cwd: string, access: Access, log: Logger, signal?: AbortSignal): Promise<DelegateResult> {
  const base = { prompt, cwd, sessionId: null, timeoutSec: RUN_TIMEOUT_SEC, log, signal, model: models[agent] ?? null };
  if (agent === "antigravity") return delegateToAntigravity({ ...base, bin: BINS.antigravity, access });
  if (agent === "codex") return delegateToCodex({ ...base, bin: BINS.codex, sandbox: access === "edit" ? "workspace-write" : "read-only" });
  if (agent === "claude") return delegateToClaude({ ...base, bin: BINS.claude, permissionMode: access === "edit" ? "acceptEdits" : "default" });
  return delegateToOpencode({ ...base, bin: BINS.opencode, autoApprove: access === "edit" });
}

/** Run with access "ask": permission requests go to `decide` instead of a user. Null = not supported here. */
async function runAsk(
  agent: CodingAgent,
  prompt: string,
  cwd: string,
  decide: (r: PermissionRequest) => Promise<PermissionDecision>,
  log: Logger,
): Promise<DelegateResult | null> {
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

interface Outcome {
  name: string;
  pass: boolean;
  detail: string;
  ms: number;
}

async function timed(name: string, fn: () => Promise<{ pass: boolean; detail: string }>): Promise<Outcome> {
  const start = Date.now();
  try {
    const r = await fn();
    return { name, ...r, ms: Date.now() - start };
  } catch (err) {
    return { name, pass: false, detail: String((err as Error)?.message ?? err).slice(0, 160), ms: Date.now() - start };
  }
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-rel-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(dir, "README.md"), "reliability sandbox\n");
  git("add", "README.md");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  return dir;
}

export async function runReliability(opts: {
  agents: CodingAgent[];
  out: (s: string) => void;
  log: Logger;
  sections?: readonly ReliabilitySection[];
  models?: Partial<Record<CodingAgent, string>>;
}): Promise<number> {
  const sections = opts.sections ?? RELIABILITY_SECTIONS;
  models = opts.models ?? {};
  const agents = opts.agents.filter((a) => resolveBinary(BINS[a]));
  for (const a of opts.agents) if (!agents.includes(a)) opts.out(`${a}: SKIP (CLI "${BINS[a]}" not installed)`);
  const home = mkdtempSync(join(tmpdir(), "agent-bridge-rel-home-"));
  const results: Outcome[] = [];
  const record = (o: Outcome) => {
    results.push(o);
    opts.out(`  ${o.pass ? "PASS" : "FAIL"}  ${o.name}  (${(o.ms / 1000).toFixed(1)}s)  ${o.detail}`);
  };
  const repos: string[] = [];
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
          }),
        );
      }
      record(
        await timed(`${agent} read-only is enforced`, async () => {
          const dir = repo();
          await run(agent, "Create a file named should-not-exist.txt containing the word hi. Then reply done.", dir, "read", opts.log);
          const exists = existsSync(join(dir, "should-not-exist.txt"));
          return { pass: !exists, detail: exists ? "the file WAS created despite read-only access" : "no file created" };
        }),
      );
      record(
        await timed(`${agent} edit in worktree`, async () => {
          const dir = repo();
          const wt = await createWorktree({ cwd: dir, home, jobId: `${agent}-${Date.now().toString(36)}`, log: opts.log });
          const steps: string[] = [];
          const base = { prompt: "Create a file named created.txt containing the word hello. Then reply done.", cwd: wt.cwd, sessionId: null, timeoutSec: RUN_TIMEOUT_SEC, log: opts.log, model: models[agent] ?? null, onProgress: (m: string) => steps.push(m) };
          const r =
            agent === "antigravity"
              ? await delegateToAntigravity({ ...base, bin: BINS.antigravity, access: "edit" })
              : agent === "codex"
              ? await delegateToCodex({ ...base, bin: BINS.codex, sandbox: "workspace-write" })
              : agent === "claude"
                ? await delegateToClaude({ ...base, bin: BINS.claude, permissionMode: "acceptEdits" })
                : await delegateToOpencode({ ...base, bin: BINS.opencode, autoApprove: true });
          const outcome = await finishWorktree(wt, "reliability edit", opts.log);
          const leaked = existsSync(join(dir, "created.txt"));
          const pass = outcome.diffStat.includes("created.txt") && !leaked;
          return {
            pass,
            detail: leaked
              ? "file leaked into the working copy"
              : pass
                ? "created.txt committed on the worktree branch"
                : `no created.txt; steps: [${steps.join(" | ")}]; answer: "${r.text.trim().slice(0, 80)}"; diff: ${outcome.diffStat.split("\n").pop() ?? ""}`,
          };
        }),
      );
    }

    for (const agent of sections.includes("core") ? agents : []) {
      for (const allow of [false, true]) {
        const label = `${agent} ask -> ${allow ? "allow" : "deny"}`;
        const dir = repo();
        const asked: string[] = [];
        const outcome = await timed(label, async () => {
          const r = await runAsk(
            agent,
            "Create a file named asked.txt containing the word hi. Then reply done.",
            dir,
            async (req) => {
              asked.push(`${req.tool}: ${req.detail.slice(0, 60)}`);
              return allow ? { allow: true } : { allow: false, message: "Denied by the reliability test." };
            },
            opts.log,
          );
          if (r === null) return { pass: true, detail: "SKIP (not available: see README, permission requests)" };
          const exists = existsSync(join(dir, "asked.txt"));
          return {
            pass: asked.length > 0 && exists === allow,
            detail: `asked ${asked.length}x [${asked.join(" | ")}], file ${exists ? "created" : "not created"}`,
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
        }),
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
            (e) => String((e as Error).message),
          );
          const took = Date.now() - started;
          return { pass: r.includes("aborted") && took < CANCEL_AFTER_MS + CANCEL_GRACE_MS, detail: `${r}, stopped after ${(took / 1000).toFixed(1)}s` };
        }),
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
        log: opts.log,
      });
    }
  } finally {
    for (const r of repos) rmSync(r, { recursive: true, force: true, maxRetries: 3 });
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }

  const passed = results.filter((r) => r.pass).length;
  opts.out(`\n${passed}/${results.length} passed`);
  return passed === results.length ? 0 : 1;
}
