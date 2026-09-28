import { describe, expect, it } from "vitest";
import { claudeSessionFromStream, DelegateError, parseCodexJsonl, parseOpencodeJsonl, withResumeHint } from "../src/core/delegate.js";

const timeout = (partial: string) => () => Promise.reject(new DelegateError("delegate timed out after 3600s", "timeout", "", partial));

describe("timeouts name the session to resume", () => {
  it("codex", async () => {
    const err = await withResumeHint("codex", (o) => parseCodexJsonl(o).threadId, timeout('{"type":"thread.started","thread_id":"th-42"}\n')).catch((e) => e);
    expect(err.kind).toBe("timeout");
    expect(err.message).toContain('session_id="th-42"');
    expect(err.message).toContain("instead of starting over");
  });

  it("claude", async () => {
    const err = await withResumeHint("claude", claudeSessionFromStream, timeout('{"type":"system","subtype":"init","session_id":"c-7"}\n')).catch((e) => e);
    expect(err.message).toContain('session_id="c-7"');
  });

  it("opencode", async () => {
    const err = await withResumeHint("opencode", (o) => parseOpencodeJsonl(o).sessionId, timeout('{"type":"step_start","sessionID":"ses_9"}\n')).catch((e) => e);
    expect(err.message).toContain('session_id="ses_9"');
  });

  it("leaves other errors and session-less timeouts alone", async () => {
    const plain = await withResumeHint("codex", () => null, timeout("")).catch((e) => e);
    expect(plain.message).toBe("delegate timed out after 3600s");
    const failed = await withResumeHint("codex", () => "x", () => Promise.reject(new DelegateError("boom", "failed"))).catch((e) => e);
    expect(failed.message).toBe("boom");
  });
});
