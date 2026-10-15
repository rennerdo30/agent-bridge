import { spawn, type ChildProcess } from "node:child_process";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { killTree, resolveCommand, trackChild } from "./delegate.js";
import { readProcessIdentity } from "./process-identity.js";
import { startWindowsJobScope, type WindowsJobScope } from "./windows-job-scope.js";
import type { Logger } from "./logger.js";

// A stable owned root waits for containment before it launches anything. It remains alive after
// launcher exit, so cleanup never relies on a dead/reused launcher PID or executable-name scans.
const ROOT = String.raw`
const { spawn } = require('node:child_process');
const deadline = setTimeout(() => process.exit(1), 15000);
process.once('message', ({ command, args, shell }) => {
  clearTimeout(deadline);
  const child = spawn(command, args, { shell, windowsHide: true, stdio: ['pipe', 'inherit', 'ignore'] });
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {});
  child.on('error', () => process.send({ failed: true }));
  child.on('exit', () => process.send({ ended: true }));
});
`;

/** MCP framing from the SDK; process lifetime belongs to the bridge, including launcher descendants. */
export class OwnedMcpStdio implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  private child?: ChildProcess;
  private scope?: WindowsJobScope;
  private identity?: string;
  private setup?: Promise<void>;
  private closing?: Promise<void>;
  private buffer = new ReadBuffer();
  constructor(private options: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; log: Logger; signal: AbortSignal }) {}

  start(): Promise<void> {
    if (this.setup) throw new Error("MCP transport already started");
    return this.setup = this.launch();
  }
  private async launch(): Promise<void> {
    const o = this.options;
    o.signal.throwIfAborted();
    const command = resolveCommand(o.command, o.args, o.env, o.log);
    const child = this.child = spawn(process.execPath, ["-e", ROOT], {
      cwd: o.cwd, env: o.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    trackChild(child, o.log);
    child.on("error", (error) => this.onerror?.(error));
    child.stdout!.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        let message: JSONRPCMessage | null;
        while ((message = this.buffer.readMessage())) this.onmessage?.(message);
      } catch (error) { this.onerror?.(error as Error); }
    });
    child.stdin!.on("error", (error) => this.onerror?.(error));
    child.stderr!.resume();
    child.on("message", (message: any) => {
      if (message.failed || message.ended) this.onerror?.(new Error("Plugin MCP launcher ended"));
    });
    child.on("close", () => this.onclose?.());
    await new Promise<void>((done, reject) => { child.once("spawn", done); child.once("error", reject); });
    this.identity = await readProcessIdentity(child.pid!, o.signal) ?? undefined;
    if (!this.identity) throw new Error("Cannot establish plugin MCP process identity");
    o.log.info("owned plugin MCP root", { pid: child.pid, identity: this.identity });
    if (process.platform === "win32") this.scope = await startWindowsJobScope(o.log, child.pid!);
    o.signal.throwIfAborted();
    child.send({ command: command.resolved, args: command.args, shell: command.needsShell });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child?.stdin?.writable || this.closing) throw new Error("Plugin MCP transport closed");
    await new Promise<void>((done, reject) => this.child!.stdin!.write(serializeMessage(message), (error) => error ? reject(error) : done()));
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      // Containment setup may still be running after connect's cancellation race settles.
      await this.setup?.catch(() => {});
      const child = this.child;
      if (!child) return;
      try {
        if (this.scope) {
          const result = await this.scope.cleanup(); // private job membership verifies descendants
          if (result.remaining.length) throw new Error("Plugin MCP descendants survived containment cleanup");
        }
      } finally {
        this.scope?.detach();
        let unverified = false;
        try {
          // Check the recorded creation identity before any PID-based tree command.
          const current = child.pid && await readProcessIdentity(child.pid);
          if (this.identity && current === this.identity) await killTree(child, "plugin MCP tree cleanup");
          else if (!this.identity) child.kill(); // gated root: no descendants were allowed to launch
          else unverified = child.exitCode === null && child.signalCode === null; // never kill an unverified PID
        } finally {
          // Release our stdio and IPC handles even when the root cannot be verified.
          child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
          if (child.connected) child.disconnect();
        }
        if (unverified) throw new Error("Cannot verify plugin MCP root identity for cleanup");
      }
    })();
  }
}
