import { spawn } from "node:child_process";
import { resolveBinary, unwrapNpmShim } from "./delegate.js";
import type { Logger } from "./logger.js";
import { object } from "./transcripts/common.js";

/** Model ids from one MSP `model/list` result. */
export function museModelIds(result: unknown): string[] {
  const models = object(result).models;
  if (!Array.isArray(models)) return [];
  return models.map(object).map((m) => m.modelId).filter((id): id is string => typeof id === "string" && !!id);
}

/**
 * Ask a short-lived `muse serve` host for its model catalog over MSP
 * (initialize -> initialized -> model/list). Any failure returns no ids and
 * the caller falls back to pass-through model text.
 */
export async function listMuseModels(bin: string, cwd: string, log: Logger, timeoutMs = 20_000): Promise<string[]> {
  const resolved = resolveBinary(bin);
  if (!resolved) return [];
  const shim = /\.(cmd|bat)$/i.test(resolved) ? unwrapNpmShim(resolved) : null;
  const command = shim?.command ?? resolved;
  const args = [...(shim?.prefix ?? []), "serve"];
  return await new Promise<string[]>((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true });
    let buf = "", id = 0, done = false;
    const pending = new Map<number, (value: unknown) => void>();
    const finish = (ids: string[]) => { if (done) return; done = true; clearTimeout(timer); child.kill(); resolve(ids); };
    const timer = setTimeout(() => finish([]), timeoutMs);
    const send = (method: string, params: unknown) => new Promise<unknown>((res) => {
      const mid = ++id;
      pending.set(mid, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mid, method, params })}\n`);
    });
    child.on("error", () => finish([]));
    child.stdout.on("data", (data) => {
      buf += data;
      let at: number;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at); buf = buf.slice(at + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (typeof msg.id === "number" && pending.has(msg.id)) { const res = pending.get(msg.id)!; pending.delete(msg.id); res(msg.error ? null : msg.result); }
      }
    });
    void (async () => {
      try {
        const init = object(await send("initialize", { clientInfo: { name: "agent_bridge", version: "0" }, capabilities: {} }));
        if (!init.serverInfo) return finish([]);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
        finish(museModelIds(await send("model/list", {})));
      } catch (err) {
        log.debug("muse MSP model list failed", { err: String(err) });
        finish([]);
      }
    })();
  });
}
