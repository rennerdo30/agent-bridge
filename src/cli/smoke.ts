import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CLAUDE_BIN, DEFAULT_CODEX_BIN, DEFAULT_OPENCODE_BIN } from "../core/constants.js";
import { delegateToClaude, delegateToCodex, delegateToOpencode, resolveBinary, runProcess, type DelegateResult } from "../core/delegate.js";
import { t } from "../core/i18n.js";
import type { Logger } from "../core/logger.js";
import type { CodingAgent } from "../core/protocol.js";
import { delegateToAntigravity } from "../core/antigravity.js";

/** CLI versions this agent-bridge release was verified against. */
export const TESTED_VERSIONS: Record<CodingAgent, string> = {
  antigravity: "1.2.0",
  claude: "2.1.283",
  codex: "0.157.1",
  opencode: "1.18.32",
};

const SMOKE_TIMEOUT_SEC = 180;
const VERSION_TIMEOUT_MS = 30_000;
const EXPECTED = "AGENT_BRIDGE_OK";
const PROMPT = `Reply with exactly ${EXPECTED} and nothing else.`;
const RESUME_PROMPT = "What did you reply last time? Reply with exactly that word and nothing else.";

async function version(bin: string, log: Logger): Promise<string> {
  try {
    const res = await runProcess({ bin, args: ["--version"], stdin: "", cwd: process.cwd(), timeoutMs: VERSION_TIMEOUT_MS, env: process.env, log });
    return /\d+\.\d+\.\d+/.exec(res.stdout)?.[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Run each installed CLI once through the real delegation code: checks that output parsing, session
 * ids and resuming still work after CLI updates. Costs a few tokens per CLI.
 */
export async function runSmoke(opts: { agents: CodingAgent[]; out: (s: string) => void; log: Logger }): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-smoke-"));
  const bins: Record<CodingAgent, string> = { claude: DEFAULT_CLAUDE_BIN, codex: DEFAULT_CODEX_BIN, opencode: DEFAULT_OPENCODE_BIN, antigravity: "agy" };
  let failures = 0;
  try {
    for (const agent of opts.agents) {
      const bin = bins[agent];
      if (!resolveBinary(bin)) {
        opts.out(t("smoke.missing", { agent }));
        continue;
      }
      const v = await version(bin, opts.log);
      const note = v === TESTED_VERSIONS[agent] ? "" : t("smoke.untested", { tested: TESTED_VERSIONS[agent] });
      opts.out(t("smoke.start", { agent, version: v, note }));
      const run = (prompt: string, sessionId: string | null): Promise<DelegateResult> => {
        const base = { prompt, cwd: dir, sessionId, timeoutSec: SMOKE_TIMEOUT_SEC, log: opts.log };
        if (agent === "antigravity") return delegateToAntigravity({ ...base, bin, access: "read" });
        if (agent === "codex") return delegateToCodex({ ...base, bin, sandbox: "read-only" });
        if (agent === "claude") return delegateToClaude({ ...base, bin, permissionMode: "plan" });
        return delegateToOpencode({ ...base, bin, autoApprove: false });
      };
      try {
        const first = await run(PROMPT, null);
        const okAnswer = first.text.includes(EXPECTED);
        const okSession = Boolean(first.sessionId);
        const second = okSession ? await run(RESUME_PROMPT, first.sessionId) : null;
        const okResume = Boolean(second?.text.includes(EXPECTED));
        const passed = okAnswer && okSession && okResume;
        if (!passed) failures++;
        opts.out(
          t(passed ? "smoke.pass" : "smoke.fail", {
            agent,
            answer: okAnswer ? "ok" : `unexpected "${first.text.slice(0, 60)}"`,
            session: okSession ? "ok" : "missing",
            resume: okResume ? "ok" : second ? `unexpected "${second.text.slice(0, 60)}"` : "skipped",
          }),
        );
      } catch (err) {
        failures++;
        opts.out(t("smoke.error", { agent, detail: String((err as Error)?.message ?? err) }));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failures ? 1 : 0;
}
