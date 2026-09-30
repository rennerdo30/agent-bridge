import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { delegateToCodexAppServer } from "../src/core/codex-appserver.js";
import { DelegateError, failureCause, isTransientProviderError, retryTransient, runProcess, TRANSIENT_RETRY_MESSAGE, type DelegateRequest, type DelegateResult } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";

const req = (over: Partial<DelegateRequest> = {}): DelegateRequest => ({ prompt: "do the task", cwd: ".", sessionId: null, timeoutSec: 600, log: nullLogger, ...over });
const result = (over: Partial<DelegateResult> = {}): DelegateResult => ({ sessionId: "ses-1", text: "answer", isError: false, details: {}, ...over });

describe("transient provider errors", () => {
  it("tells provider hiccups from limits and real failures", () => {
    expect(isTransientProviderError("Error from provider (Console): Upstream response was not valid JSON")).toBe(true);
    expect(isTransientProviderError("stream disconnected before completion")).toBe(true);
    expect(isTransientProviderError("HTTP 503 Service Unavailable")).toBe(true);
    expect(isTransientProviderError("You've hit your usage limit")).toBe(false);
    expect(isTransientProviderError("429 Too Many Requests from upstream")).toBe(false);
    expect(isTransientProviderError("model not found: gpt-x")).toBe(false);
  });

  it("resumes the same session once with a short continue message, and says so", async () => {
    const calls: DelegateRequest[] = [];
    const res = await retryTransient(req(), async (r) => {
      calls.push(r);
      if (calls.length === 1) throw new DelegateError("Error from provider (Console): Upstream response was not valid JSON", "failed", "", "", "ses-7");
      return result({ sessionId: "ses-7", text: "finished" });
    });
    expect(calls.map((c) => [c.sessionId, c.prompt])).toEqual([
      [null, "do the task"],
      ["ses-7", TRANSIENT_RETRY_MESSAGE],
    ]);
    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/temporary provider error interrupted the run \("Error from provider.*resumed the same session once[\s\S]*finished$/);
    expect(res.details.retriedAfter).toContain("not valid JSON");
  });

  it("also retries a run that ended with a transient error in its result", async () => {
    let n = 0;
    const res = await retryTransient(req(), async () => (++n === 1 ? result({ isError: true, text: "half done", details: { error: "Upstream response was not valid JSON" } }) : result({ text: "done" })));
    expect(n).toBe(2);
    expect(res.isError).toBe(false);
  });

  it("retries only once, and the final error names the first failure", async () => {
    let n = 0;
    const err = await retryTransient(req(), async () => {
      n++;
      throw new DelegateError("socket hang up", "failed", "", "", "ses-2");
    }).catch((e) => e);
    expect(n).toBe(2);
    expect(err.message).toContain("after one automatic retry");
    expect(err.sessionId).toBe("ses-2");
  });

  it("does not retry limits, timeouts, cancellations or runs without a session", async () => {
    for (const e of [
      new DelegateError("usage limit reached", "failed", "", "", "s"),
      new DelegateError("delegate timed out after 60s", "timeout", "", "", "s"),
      new DelegateError("delegate aborted", "aborted", "", "", "s"),
      new DelegateError("Upstream response was not valid JSON", "failed"),
    ]) {
      let n = 0;
      await retryTransient(req(), async () => {
        n++;
        throw e;
      }).catch(() => {});
      expect(n).toBe(1);
    }
  });
});

describe("failure causes", () => {
  it("names the cause of a thrown failure", () => {
    expect(failureCause({ error: new DelegateError("delegate aborted", "aborted") })).toMatch(/^cancelled/);
    expect(failureCause({ error: new DelegateError("git worktree add timed out after 600s", "timeout") })).toBe("timeout: git worktree add timed out after 600s");
    expect(failureCause({ error: new DelegateError("codex app-server exited with code 3", "failed", "warn: x\nfatal: disk full\n") })).toBe(
      "error: codex app-server exited with code 3\nLast error output:\nwarn: x\nfatal: disk full",
    );
    expect(failureCause({ error: new DelegateError("You've hit your usage limit.", "failed") })).toMatch(/^usage or rate limit reached/);
  });

  it("names the cause of a run that ended with an error result", () => {
    expect(failureCause({ result: result({ isError: true, details: { error: "Upstream response was not valid JSON", exitCode: 1 } }) })).toBe(
      "error: Upstream response was not valid JSON; the agent exited with code 1",
    );
    expect(failureCause({ result: result({ isError: true, details: { exitCode: null, signal: "SIGKILL" } }) })).toBe("the agent was killed by signal SIGKILL");
    expect(failureCause({ result: result({ isError: true }) })).toMatch(/no details/);
  });

  it("says which command timed out", async () => {
    const err = await runProcess({ bin: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"], stdin: "", cwd: ".", timeoutMs: 500, env: process.env, log: nullLogger, what: "git worktree add" }).catch((e) => e);
    expect(err).toBeInstanceOf(DelegateError);
    expect(err.message).toBe("git worktree add timed out after 1s");
  });
});

describe("codex app-server startup", () => {
  it("gives up on a silent app-server with a startup error that may be retried", async () => {
    // `node app-server` runs this file: an app-server that never answers the handshake.
    const dir = mkdtempSync(join(tmpdir(), "ab-appserver-"));
    writeFileSync(join(dir, "app-server"), "process.stdin.resume(); setInterval(() => {}, 1000);\n");
    try {
      const started = Date.now();
      const err = await delegateToCodexAppServer({ ...req({ cwd: dir }), bin: process.execPath, sandbox: "read-only", startupTimeoutMs: 1_000 }).catch((e) => e);
      expect(err).toBeInstanceOf(DelegateError);
      expect(err.startupFailed).toBe(true);
      expect(err.message).toBe("codex app-server did not answer initialize within 1s (startup timeout)");
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
