import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import { checkDepthPublic, childEnvPublic, DelegateError, killTree, trackChild, resolveBinary, unwrapNpmShim, type DelegateRequest, type DelegateResult } from "./delegate.js";
import { progressEventHandler } from "./progress.js";
import type { PermissionDecision, PermissionRequest } from "./relay.js";

/**
 * opencode with permission forwarding. `opencode run` answers every permission request itself, so for
 * access "ask" agent-bridge starts a private `opencode serve` (127.0.0.1, random port, random password),
 * sends the prompt over its HTTP API and answers `permission.asked` events with the user's decision.
 */
const SERVE_START_TIMEOUT_MS = 30_000;
const LISTEN_RE = /listening on (https?:\/\/[^\s]+)/i;
const SERVER_USER = "opencode";
const PASSWORD_BYTES = 24;
const MAX_DETAIL_CHARS = 4_000;
/** Edits and commands ask (the defaults allow everything); asks come to us as events. */
const ASK_PERMISSIONS = { edit: "ask", bash: "ask" };
/** If the session shows no sign of life this long after the prompt, something is wrong (bad model, auth). */
const START_WATCHDOG_MS = 60_000;
/** Server output kept for error reports; the listen line and a failure's last words fit easily. */
const SERVE_OUTPUT_TAIL_CHARS = 4_000;

type Json = Record<string, any>;

/**
 * Watches `opencode serve` output for its listen line. Only a bounded tail is kept, and nothing once the
 * server is up: it runs (and logs) for the whole delegated run, which can take hours. The pipes are still
 * drained so the server never blocks on a full pipe.
 */
export function watchServeOutput(onListening: (url: string) => void): { onData: (d: Buffer | string) => void; tail: () => string } {
  let out = "";
  let listening = false;
  return {
    onData: (d) => {
      if (listening) return;
      out = (out + d.toString()).slice(-SERVE_OUTPUT_TAIL_CHARS);
      const m = LISTEN_RE.exec(out);
      if (m) {
        listening = true;
        out = "";
        onListening(m[1]!.replace(/\/+$/, ""));
      }
    },
    tail: () => out,
  };
}

function startServe(bin: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; url: string }> {
  let resolved = resolveBinary(bin, env);
  if (!resolved) return Promise.reject(new DelegateError(`executable not found: ${bin}`, "not_found"));
  let prefix: string[] = [];
  if (process.platform === "win32" && [".cmd", ".bat"].includes(extname(resolved).toLowerCase())) {
    const target = unwrapNpmShim(resolved);
    if (!target) return Promise.reject(new DelegateError(`cannot start ${bin} without a shell`, "failed"));
    resolved = target.command;
    prefix = target.prefix;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(resolved!, [...prefix, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd,
      env: { ...env, PWD: cwd },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    trackChild(child);
    const output = watchServeOutput((url) => {
      clearTimeout(timer);
      resolve({ child, url });
    });
    const timer = setTimeout(() => {
      void killTree(child);
      reject(new DelegateError("opencode serve did not start in time", "timeout", output.tail()));
    }, SERVE_START_TIMEOUT_MS);
    child.stdout!.on("data", output.onData);
    child.stderr!.on("data", output.onData);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new DelegateError(`failed to start opencode serve: ${err.message}`, "failed"));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new DelegateError(`opencode serve exited early (code ${code})`, "failed", output.tail()));
    });
  });
}

/** Parse Server-Sent Events from a fetch body into JSON payloads. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data);
      } catch {
        // ignore keep-alives and partial frames
      }
    }
  }
}

function permissionDetail(p: Json): string {
  const patterns = Array.isArray(p.patterns) ? p.patterns.join(", ") : "";
  const meta = p.metadata && typeof p.metadata === "object" ? p.metadata : {};
  const cmd = typeof meta.command === "string" ? meta.command : typeof meta.filepath === "string" ? meta.filepath : "";
  return (cmd || patterns || JSON.stringify(meta)).slice(0, MAX_DETAIL_CHARS);
}

export async function delegateToOpencodeServed(
  req: DelegateRequest & { bin: string; onPermission: (r: PermissionRequest) => Promise<PermissionDecision> },
): Promise<DelegateResult> {
  checkDepthPublic();
  const password = randomBytes(PASSWORD_BYTES).toString("hex");
  const env = childEnvPublic({
    ...req.extraEnv,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: SERVER_USER,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: ASK_PERMISSIONS }),
  });
  const { child, url } = await startServe(req.bin, req.cwd, env);
  const auth = `Basic ${Buffer.from(`${SERVER_USER}:${password}`).toString("base64")}`;
  const q = `directory=${encodeURIComponent(req.cwd)}`;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), req.timeoutSec * 1000);
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await fetch(`${url}${path}${path.includes("?") ? "&" : "?"}${q}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw new DelegateError(`opencode API ${method} ${path} failed: HTTP ${res.status}`, "failed", await res.text().catch(() => ""));
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  let knownSession: string | null = req.sessionId ?? null;
  try {
    const sessionId: string = req.sessionId ?? (await api("POST", "/session", {})).id;
    req.onSession?.(sessionId);
    knownSession = sessionId;
    const events = await fetch(`${url}/event?${q}`, { headers: { authorization: auth, accept: "text/event-stream" }, signal: ac.signal });
    if (!events.ok || !events.body) throw new DelegateError(`opencode event stream failed: HTTP ${events.status}`, "failed");

    const [providerID, ...rest] = (req.model ?? "").split("/");
    const body: Json = { parts: [{ type: "text", text: req.prompt }] };
    if (req.model && rest.length) body.model = { providerID, modelID: rest.join("/") };
    await api("POST", `/session/${sessionId}/prompt_async`, body);

    let failure: string | null = null;
    const onEvent = progressEventHandler("opencode", req.onProgress);
    let alive = false;
    const watchdog = setTimeout(() => {
      if (alive) return;
      failure = "opencode did not start working on the prompt within 60 seconds (check the model id and the provider's login).";
      ac.abort();
    }, START_WATCHDOG_MS);
    try {
    for await (const ev of sse(events.body)) {
      const type = String(ev.type ?? "");
      const p: Json = ev.properties ?? {};
      const mine = p.sessionID === sessionId || p.part?.sessionID === sessionId || p.info?.sessionID === sessionId;
      if (mine) alive = true;
      if (type === "session.error" && !p.sessionID) {
        failure = String(p.error?.data?.message ?? p.error?.message ?? "opencode reported an error");
        break;
      }
      if (type === "permission.asked" && p.sessionID === sessionId) {
        const decision = await req.onPermission({ agent: "opencode", tool: String(p.permission ?? "unknown"), detail: permissionDetail(p), cwd: req.cwd });
        await api("POST", `/permission/${p.id}/reply`, decision.allow ? { reply: "once" } : { reply: "reject", message: decision.message });
      } else if (type === "message.part.updated" && p.part?.sessionID === sessionId) {
        // Parts are updated many times while streaming: report tools once their input is known,
        // text once it is complete (the handler reports each part id only once).
        const part = p.part;
        const ready =
          (part.type === "tool" && (part.state?.status === "running" || part.state?.status === "completed")) ||
          (part.type === "text" && part.time?.end) ||
          (part.type === "reasoning" && part.time?.end);
        if (ready) onEvent?.({ part });
      } else if (type === "session.error" && p.sessionID === sessionId) {
        failure = String(p.error?.data?.message ?? p.error?.message ?? "opencode session error");
        break;
      } else if ((type === "session.idle" && p.sessionID === sessionId) || (type === "session.status" && p.sessionID === sessionId && p.status?.type === "idle")) {
        break;
      }
    }
    } catch (err) {
      // The watchdog aborts the event stream; report its reason instead of a generic abort.
      if (!failure) throw err;
    } finally {
      clearTimeout(watchdog);
    }
    if (failure && !alive) throw new DelegateError(failure, "failed", "", "", sessionId);

    const messages: Json[] = (await api("GET", `/session/${sessionId}/message`)) ?? [];
    const last = [...messages].reverse().find((m) => m.info?.role === "assistant");
    const text = (last?.parts ?? [])
      .filter((part: Json) => part.type === "text" && typeof part.text === "string")
      .map((part: Json) => part.text)
      .join("");
    if (failure && !text) throw new DelegateError(failure, "failed", "", "", sessionId);
    const tokens = last?.info?.tokens;
    return {
      sessionId,
      text,
      isError: failure !== null,
      details: {
        error: failure,
        usage: tokens ? { input: Number(tokens.input) || 0, output: Number(tokens.output) || 0 } : null,
        costUsd: typeof last?.info?.cost === "number" ? last.info.cost : null,
      },
    };
  } catch (err) {
    if (ac.signal.aborted && !(err instanceof DelegateError)) {
      if (req.signal?.aborted) throw new DelegateError("delegate aborted", "aborted", "", "", knownSession);
      const hint = knownSession
        ? `. The opencode session ${knownSession} keeps its progress: call again with session_id="${knownSession}" (and a longer timeout_sec, or use spawn_opencode) to continue instead of starting over.`
        : "";
      throw new DelegateError(`delegate timed out after ${req.timeoutSec}s${hint}`, "timeout", "", "", knownSession);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
    ac.abort();
    await killTree(child);
  }
}
