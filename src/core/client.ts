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

export const CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT = 16;
export const CLIENT_TRANSPORT_DIAGNOSTIC_COUNT_LIMIT = 65_535;
export const CLIENT_TRANSPORT_DIAGNOSTIC_EVENT = "client connection closure observation";
type TransportOperation = "tracked_send" | "legacy_send" | "auth_hello" | "ack" | "status_read" | "other";
interface RequestWriteObservation {
  operation: TransportOperation;
  frame_encoded: boolean;
  write_call_boundary: "not_reached" | "reached";
  write_returned: boolean;
}
export interface ClientConnectionClosedDiagnostic extends Readonly<RequestWriteObservation> {
  readonly phase: "prewrite_closed" | "pending_close";
}
const connectionClosedDiagnostics = new WeakMap<Error, ClientConnectionClosedDiagnostic>();
const pendingWriteObservations = new WeakMap<Pending, RequestWriteObservation>();
/** Original source-associated errors only. Copied errors/fields cannot mint
 * provenance; these primitives never establish IO, delivery or storage. */
export function clientConnectionClosedDiagnostic(error: unknown): ClientConnectionClosedDiagnostic | undefined {
  return error !== null && typeof error === "object" ? connectionClosedDiagnostics.get(error as Error) : undefined;
}
function transportOperation(op: Op): TransportOperation {
  switch (op) {
    case "trackedSend": return "tracked_send";
    case "send": case "sendSibling": return "legacy_send";
    case "auth": case "hello": return "auth_hello";
    case "ack": return "ack";
    case "ping": case "coreStatus": case "sendState": case "messageReceipt": return "status_read";
    default: return "other";
  }
}
function observedEncodedFrame(transport: RequestWriteObservation, encoded: ReturnType<typeof encodeFrame>): ReturnType<typeof encodeFrame> {
  transport.frame_encoded = true;
  // Argument evaluation has reached the original call site. This is neither
  // native socket IO nor delivery, and can precede a thrown write invocation.
  transport.write_call_boundary = "reached";
  return encoded;
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
  #transportDiagnosticEmissions = 0;
  #transportDiagnosticOverflow = false;
  readonly #transportDiagnosticCounts = new Map<string, number>();

  #observedConnectionClosed(phase: ClientConnectionClosedDiagnostic["phase"], transport: RequestWriteObservation): Error & { code: string } {
    const error = brokerConnectionClosedError(), diagnostic = Object.freeze({ phase, ...transport });
    connectionClosedDiagnostics.set(error, diagnostic);
    const key = JSON.stringify(diagnostic), previous = this.#transportDiagnosticCounts.get(key);
    let count = 1;
    if (previous !== undefined) {
      count = Math.min(previous + 1, CLIENT_TRANSPORT_DIAGNOSTIC_COUNT_LIMIT); this.#transportDiagnosticCounts.set(key, count);
      if (count === CLIENT_TRANSPORT_DIAGNOSTIC_COUNT_LIMIT) this.#transportDiagnosticOverflow = true;
    } else if (this.#transportDiagnosticCounts.size < CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT) this.#transportDiagnosticCounts.set(key, count);
    else this.#transportDiagnosticOverflow = true;
    if (this.#transportDiagnosticEmissions < CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT) {
      this.#transportDiagnosticEmissions++;
      // Saturation conservatively marks coverage as capped, including the last
      // emitted record. Every request retains its original settlement below.
      const overflow = this.#transportDiagnosticOverflow || this.#transportDiagnosticEmissions === CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT;
      try { this.log.info(CLIENT_TRANSPORT_DIAGNOSTIC_EVENT, { ...diagnostic, count, overflow }); }
      catch { /* ONLY diagnostics logger failure is swallowed; no request recovery. */ }
    }
    return error;
  }

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
        const transport = pendingWriteObservations.get(p);
        p.reject(transport ? this.#observedConnectionClosed("pending_close", transport) : brokerConnectionClosedError());
      }
      this.pending.clear();
      this.emit("close");
    });
  }

  /** Connect to an existing broker. Rejects with the socket error (ENOENT/ECONNREFUSED if nobody listens). */
  static connect(pipePath: string, log: Logger, timeoutMs: number = CONNECT_TIMEOUT_MS, options: { readOnlyDirectory?: boolean } = {}): Promise<BridgeClient> {
    return new Promise((resolve, reject) => {
      // Never hand the token to an endpoint in a short-socket directory another user controls.
      ensurePrivateSocketDirectory(pipePath, process.platform, options.readOnlyDirectory ?? false);
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
    if (this.closed) return Promise.reject(this.#observedConnectionClosed("prewrite_closed", {
      operation: transportOperation(op), frame_encoded: false, write_call_boundary: "not_reached", write_returned: false,
    }));
    const id = this.nextId++;
    // AB-380: a frame the broker cannot decode would drop the connection; fail here instead, without retry.
    const data = encodeFrame({ t: "req", id, op, args });
    const bytes = Buffer.byteLength(data);
    if (bytes > MAX_FRAME_BYTES) return Promise.reject(new BridgeError("too_large",
      `${op} request is ${bytes} bytes, over the ${MAX_FRAME_BYTES}-byte frame limit; it was not sent and must not be retried.`,
      { operation: op, bytes, limit: MAX_FRAME_BYTES, retryable: false }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`broker request timed out: ${op}`));
      }, timeoutMs);
      const transport: RequestWriteObservation = { operation: transportOperation(op), frame_encoded: false, write_call_boundary: "not_reached", write_returned: false };
      const pending: Pending = { resolve: (value) => {
        const hello = value as Partial<RequestMap["hello"][1]>;
        const version = hello?.brokerVersion ?? (Array.isArray(hello?.peers) ? hello.peers.find((peer) => peer.pid === hello.brokerPid)?.version : undefined);
        if (typeof version === "string") this.brokerVersion = version;
        resolve(value as RequestMap[O][1]);
      }, reject: (err) => {
        if (/unknown op:/.test(err.message)) reject(new BridgeError("protocol_mismatch",
          `Broker ${this.brokerVersion ? "v" + this.brokerVersion : "version unknown (older protocol)"} does not support ${op} required by server v${APP_VERSION}. Update the broker host and reload its session after current jobs finish; no operation was applied.`, { operation: op }));
        else reject(err);
      }, timer };
      pendingWriteObservations.set(pending, transport);
      this.pending.set(id, pending);
      this.socket.write(observedEncodedFrame(transport, data));
      transport.write_returned = true;
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
