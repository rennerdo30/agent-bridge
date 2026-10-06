import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { delegateToCodexAppServer } from "../src/core/codex-appserver.js";
import { CAPACITY_RETRY_DELAYS_MS, DelegateError, failureCause, isTransientProviderError, retryTransient, runProcess, TRANSIENT_RETRY_MESSAGE, type DelegateRequest, type DelegateResult } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";

const req = (over: Partial<DelegateRequest> = {}): DelegateRequest => ({ prompt: "do the task", cwd: ".", sessionId: null, timeoutSec: 600, log: nullLogger, ...over });
const result = (over: Partial<DelegateResult> = {}): DelegateResult => ({ sessionId: "ses-1", text: "answer", isError: false, details: {}, ...over });
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async (_ms, _value, opts) => { opts?.signal?.throwIfAborted(); }) }));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe("transient provider errors", () => {
  it("tells provider hiccups from limits and real failures", () => {
    expect(isTransientProviderError("Error from provider (Console): Upstream response was not valid JSON")).toBe(true);
    expect(isTransientProviderError("stream disconnected before completion")).toBe(true);
    expect(isTransientProviderError("HTTP 503 Service Unavailable")).toBe(true);
    expect(isTransientProviderError("Selected model is at capacity. Please try a different model.")).toBe(true);
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

  it("backs off capacity errors without changing the selected model or losing progress", async () => {
    const calls: DelegateRequest[] = [];
    const progress: string[] = [];
    const res = await retryTransient(req({ model: "gpt-6-sol", onProgress: (s) => progress.push(s) }), async (r) => {
      calls.push(r);
      if (calls.length <= CAPACITY_RETRY_DELAYS_MS.length) throw new DelegateError("Selected model is at capacity. Please try a different model.", "failed", "", "", "saved-session");
      return result({ sessionId: "saved-session", text: "finished" });
    });
    expect(vi.mocked(delay).mock.calls.map((c) => c[0])).toEqual([...CAPACITY_RETRY_DELAYS_MS]);
    expect(calls.every((c) => c.model === "gpt-6-sol")).toBe(true);
    expect(calls.slice(1).every((c) => c.sessionId === "saved-session" && c.prompt === TRANSIENT_RETRY_MESSAGE)).toBe(true);
    expect(progress.every((s) => s.includes("same model") && s.includes("preserving session progress"))).toBe(true);
    expect(res.details.retries).toBe(CAPACITY_RETRY_DELAYS_MS.length);
    expect(res.isError).toBe(false);
  });

  it("keeps the resolved default model and session reported before a capacity error", async () => {
    const calls: DelegateRequest[] = [];
    await retryTransient(req(), async (r) => {
      calls.push(r);
      if (calls.length === 1) {
        r.onInfo?.({ model: "gpt-6-sol" });
        r.onSession?.("saved");
        throw new DelegateError("Selected model is at capacity", "failed");
      }
      return result();
    });
    expect(calls[1]).toMatchObject({ model: "gpt-6-sol", sessionId: "saved", prompt: TRANSIENT_RETRY_MESSAGE });
  });

  it("retries capacity before session start with the original task and has a bounded retry limit", async () => {
    const calls: DelegateRequest[] = [];
    const err = await retryTransient(req({ model: "gpt-6-sol" }), async (r) => {
      calls.push(r);
      throw new DelegateError("Selected model is at capacity", "failed");
    }).catch((e) => e);
    expect(calls).toHaveLength(CAPACITY_RETRY_DELAYS_MS.length + 1);
    expect(calls.every((c) => c.prompt === "do the task" && c.model === "gpt-6-sol")).toBe(true);
    expect(err.message).toContain("3 automatic retries");
  });

  it("respects cancellation and the original deadline during capacity backoff", async () => {
    const controller = new AbortController();
    const abort = await retryTransient(req({ signal: controller.signal, onProgress: () => controller.abort() }), async () => {
      throw new DelegateError("Selected model is at capacity", "failed", "", "", "saved");
    }).catch((e) => e);
    expect(abort).toMatchObject({ kind: "aborted", sessionId: "saved" });
    expect(vi.mocked(delay).mock.calls[0]?.[2]?.signal).toBe(controller.signal);
    const timeout = await retryTransient(req({ timeoutSec: 1 }), async () => {
      throw new DelegateError("Selected model is at capacity", "failed", "", "", "saved");
    }).catch((e) => e);
    expect(timeout).toMatchObject({ kind: "timeout", sessionId: "saved" });
    expect(vi.mocked(delay)).toHaveBeenCalledTimes(1);
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
      // Windows may release the child's cwd handle just after taskkill exits.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);
});
