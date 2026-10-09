import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  t
} from "./chunk-BG6KJS4H.mjs";
import {
  delegateToAntigravity,
  delegateToClaude,
  delegateToCodex,
  delegateToOpencode,
  resolveBinary,
  runProcess
} from "./chunk-REDKCUGI.mjs";
import "./chunk-EC6ERXN3.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-7OVAI3PR.mjs";
import "./chunk-PCXGTT2Z.mjs";
import "./chunk-WRYAOPNG.mjs";
import "./chunk-L3WJOWYS.mjs";
import "./chunk-XPITHFGJ.mjs";
import "./chunk-BW76OTAT.mjs";
import "./chunk-TO3M23RT.mjs";
import "./chunk-CUZHUOFY.mjs";
import "./chunk-JNVJDIQM.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-CM6KYE44.mjs";
import "./chunk-SH6MQ2WI.mjs";
import "./chunk-SFW3GO73.mjs";
import {
  DEFAULT_CLAUDE_BIN,
  DEFAULT_CODEX_BIN,
  DEFAULT_OPENCODE_BIN
} from "./chunk-7EOIPV3B.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/cli/smoke.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
var TESTED_VERSIONS = {
  antigravity: "1.3.1",
  claude: "2.1.283",
  codex: "0.157.1",
  opencode: "1.18.32"
};
var SMOKE_TIMEOUT_SEC = 180;
var VERSION_TIMEOUT_MS = 3e4;
var EXPECTED = "AGENT_BRIDGE_OK";
var PROMPT = `Reply with exactly ${EXPECTED} and nothing else.`;
var RESUME_PROMPT = "What did you reply last time? Reply with exactly that word and nothing else.";
async function version(bin, log) {
  try {
    const res = await runProcess({ bin, args: ["--version"], stdin: "", cwd: process.cwd(), timeoutMs: VERSION_TIMEOUT_MS, env: process.env, log });
    return /\d+\.\d+\.\d+/.exec(res.stdout)?.[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}
async function runSmoke(opts) {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-smoke-"));
  const bins = { claude: DEFAULT_CLAUDE_BIN, codex: DEFAULT_CODEX_BIN, opencode: DEFAULT_OPENCODE_BIN, antigravity: "agy" };
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
      const run = (prompt, sessionId) => {
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
            resume: okResume ? "ok" : second ? `unexpected "${second.text.slice(0, 60)}"` : "skipped"
          })
        );
      } catch (err) {
        failures++;
        opts.out(t("smoke.error", { agent, detail: String(err?.message ?? err) }));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failures ? 1 : 0;
}
export {
  TESTED_VERSIONS,
  runSmoke
};
