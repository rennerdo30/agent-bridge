import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { APP_VERSION, CONNECT_TIMEOUT_MS, MAX_FRAME_BYTES, REQUEST_TIMEOUT_MS } from "./constants.js";
import type { Logger } from "./logger.js";
import { brokerTcpPortAsync, ensurePrivateSocketDirectory, resolveHome, resolvePipePath } from "./paths.js";
import {
  BridgeError,
  encodeFrame,
  FrameDecoder,
  type EventMap,
  type EventName,
  type Op,
  type RequestMap,
  type ResponseFrame,
} from "./protocol.js";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function brokerConnectionClosedError(): Error & { code: string } {
  return Object.assign(new Error("connection to broker closed"), { code: "BROKER_CONNECTION_CLOSED" });
}

export interface BridgeClientEvents {
  event: [name: EventName, data: EventMap[EventName]];
  close: [];
}

/** A single connection to the broker. Reconnection and election live in {@link BridgeNode}. */
export class BridgeClient extends EventEmitter<BridgeClientEvents> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private brokerVersion: string | undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly log: Logger,
  ) {
    super();
    socket.setEncoding("utf8");
    const decoder = new FrameDecoder(MAX_FRAME_BYTES);
    socket.on("data", (chunk: string) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.log.warn("undecodable frame from broker; disconnecting", { err });
        socket.destroy();
        return;
      }
      for (const f of frames) {
        if (f.t === "res") this.settle(f);
        else if (f.t === "evt") this.emit("event", f.ev, f.data);
      }
    });
    socket.on("error", (err) => this.log.debug("client socket error", { err: err.message }));
    socket.on("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(brokerConnectionClosedError());
      }
      this.pending.clear();
      this.emit("close");
    });
  }

  /** Connect to an existing broker. Rejects with the socket error (ENOENT/ECONNREFUSED if nobody listens). */
  static connect(pipePath: string, log: Logger, timeoutMs: number = CONNECT_TIMEOUT_MS): Promise<BridgeClient> {
    return new Promise((resolve, reject) => {
      // Keep main's direct promise/socket completion on a working named pipe.
      ensurePrivateSocketDirectory(pipePath);
      let socket = connect(pipePath);
      let discovery: AbortController | undefined;
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        discovery?.abort();
        socket.destroy();
        reject(Object.assign(new Error("timed out connecting to broker"), { code: "ETIMEDOUT" }));
      }, timeoutMs);
      const connected = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(new BridgeClient(socket, log));
      };
      const failed = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      socket.once("connect", connected);
      socket.once("error", (err) => {
        if (settled) return;
        // A restricted Windows host may need loopback. Discovery and the second
        // socket share the ORIGINAL timer; failure cannot buy another timeout.
        if (process.platform !== "win32") { failed(err); return; }
        const home = resolveHome();
        if (pipePath !== resolvePipePath(home)) { failed(err); return; }
        socket.removeListener("connect", connected);
        socket.destroy();
        const controller = discovery = new AbortController();
        void brokerTcpPortAsync(home, pipePath, controller.signal).then(port => {
          if (settled || controller.signal.aborted) return;
          if (!port) { failed(err); return; }
          log.debug("broker pipe unreachable; trying the loopback fallback", { err: err.message, port });
          socket = connect(port, "127.0.0.1");
          socket.once("connect", connected);
          socket.once("error", failed);
        }).catch(() => failed(err));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<O extends Op>(op: O, args: RequestMap[O][0], timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<RequestMap[O][1]> {
    if (this.closed) return Promise.reject(brokerConnectionClosedError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`broker request timed out: ${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => {
        const hello = value as Partial<RequestMap["hello"][1]>;
        const version = hello?.brokerVersion ?? (Array.isArray(hello?.peers) ? hello.peers.find((peer) => peer.pid === hello.brokerPid)?.version : undefined);
        if (typeof version === "string") this.brokerVersion = version;
        resolve(value as RequestMap[O][1]);
      }, reject: (err) => {
        if (/unknown op:/.test(err.message)) reject(new BridgeError("protocol_mismatch",
          `Broker ${this.brokerVersion ? "v" + this.brokerVersion : "version unknown (older protocol)"} does not support ${op} required by server v${APP_VERSION}. Update the broker host and reload its session after current jobs finish; no operation was applied.`, { operation: op }));
        else reject(err);
      }, timer });
      this.socket.write(encodeFrame({ t: "req", id, op, args }));
    });
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }

  private settle(f: ResponseFrame): void {
    const p = this.pending.get(f.id);
    if (!p) return;
    this.pending.delete(f.id);
    clearTimeout(p.timer);
    if (f.ok) p.resolve(f.result);
    else p.reject(new BridgeError(f.error.code, f.error.message, f.error.details));
  }
}
