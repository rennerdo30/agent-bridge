import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  brokerTcpPortAsync,
  ensurePrivateSocketDirectory,
  resolveHome,
  resolvePipePath
} from "./chunk-HJGP2JM4.mjs";
import {
  BridgeError,
  FrameDecoder,
  encodeFrame
} from "./chunk-IYJ5P7ML.mjs";
import {
  APP_VERSION,
  CONNECT_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  REQUEST_TIMEOUT_MS
} from "./chunk-HIVVJXLN.mjs";

// src/core/client.ts
import { EventEmitter } from "node:events";
import { connect } from "node:net";
var CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT = 16;
var CLIENT_TRANSPORT_DIAGNOSTIC_COUNT_LIMIT = 65535;
var CLIENT_TRANSPORT_DIAGNOSTIC_EVENT = "client connection closure observation";
var connectionClosedDiagnostics = /* @__PURE__ */ new WeakMap();
var pendingWriteObservations = /* @__PURE__ */ new WeakMap();
function transportOperation(op) {
  switch (op) {
    case "trackedSend":
      return "tracked_send";
    case "send":
    case "sendSibling":
      return "legacy_send";
    case "auth":
    case "hello":
      return "auth_hello";
    case "ack":
      return "ack";
    case "ping":
    case "coreStatus":
    case "sendState":
    case "messageReceipt":
      return "status_read";
    default:
      return "other";
  }
}
function observedEncodedFrame(transport, encoded) {
  transport.frame_encoded = true;
  transport.write_call_boundary = "reached";
  return encoded;
}
function brokerConnectionClosedError() {
  return Object.assign(new Error("connection to broker closed"), { code: "BROKER_CONNECTION_CLOSED" });
}
var BridgeClient = class _BridgeClient extends EventEmitter {
  constructor(socket, log) {
    super();
    this.socket = socket;
    this.log = log;
    socket.setEncoding("utf8");
    const decoder = new FrameDecoder(MAX_FRAME_BYTES);
    socket.on("data", (chunk) => {
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
  socket;
  log;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  closed = false;
  brokerVersion;
  #transportDiagnosticEmissions = 0;
  #transportDiagnosticOverflow = false;
  #transportDiagnosticCounts = /* @__PURE__ */ new Map();
  #observedConnectionClosed(phase, transport) {
    const error = brokerConnectionClosedError(), diagnostic = Object.freeze({ phase, ...transport });
    connectionClosedDiagnostics.set(error, diagnostic);
    const key = JSON.stringify(diagnostic), previous = this.#transportDiagnosticCounts.get(key);
    let count = 1;
    if (previous !== void 0) {
      count = Math.min(previous + 1, CLIENT_TRANSPORT_DIAGNOSTIC_COUNT_LIMIT);
      this.#transportDiagnosticCounts.set(key, count);
      if (count === CLIENT_TRANSPORT_DIAGNOSTIC_COUNT_LIMIT) this.#transportDiagnosticOverflow = true;
    } else if (this.#transportDiagnosticCounts.size < CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT) this.#transportDiagnosticCounts.set(key, count);
    else this.#transportDiagnosticOverflow = true;
    if (this.#transportDiagnosticEmissions < CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT) {
      this.#transportDiagnosticEmissions++;
      const overflow = this.#transportDiagnosticOverflow || this.#transportDiagnosticEmissions === CLIENT_TRANSPORT_DIAGNOSTIC_RECORD_LIMIT;
      try {
        this.log.info(CLIENT_TRANSPORT_DIAGNOSTIC_EVENT, { ...diagnostic, count, overflow });
      } catch {
      }
    }
    return error;
  }
  /** Connect to an existing broker. Rejects with the socket error (ENOENT/ECONNREFUSED if nobody listens). */
  static connect(pipePath, log, timeoutMs = CONNECT_TIMEOUT_MS, options = {}) {
    return new Promise((resolve, reject) => {
      ensurePrivateSocketDirectory(pipePath, process.platform, options.readOnlyDirectory ?? false);
      let socket = connect(pipePath);
      let discovery;
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
        resolve(new _BridgeClient(socket, log));
      };
      const failed = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      socket.once("connect", connected);
      socket.once("error", (err) => {
        if (settled) return;
        if (process.platform !== "win32") {
          failed(err);
          return;
        }
        const home = resolveHome();
        if (pipePath !== resolvePipePath(home)) {
          failed(err);
          return;
        }
        socket.removeListener("connect", connected);
        socket.destroy();
        const controller = discovery = new AbortController();
        void brokerTcpPortAsync(home, pipePath, controller.signal).then((port) => {
          if (settled || controller.signal.aborted) return;
          if (!port) {
            failed(err);
            return;
          }
          log.debug("broker pipe unreachable; trying the loopback fallback", { err: err.message, port });
          socket = connect(port, "127.0.0.1");
          socket.once("connect", connected);
          socket.once("error", failed);
        }).catch(() => failed(err));
      });
    });
  }
  get isClosed() {
    return this.closed;
  }
  request(op, args, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(this.#observedConnectionClosed("prewrite_closed", {
      operation: transportOperation(op),
      frame_encoded: false,
      write_call_boundary: "not_reached",
      write_returned: false
    }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`broker request timed out: ${op}`));
      }, timeoutMs);
      const transport = { operation: transportOperation(op), frame_encoded: false, write_call_boundary: "not_reached", write_returned: false };
      const pending = { resolve: (value) => {
        const hello = value;
        const version = hello?.brokerVersion ?? (Array.isArray(hello?.peers) ? hello.peers.find((peer) => peer.pid === hello.brokerPid)?.version : void 0);
        if (typeof version === "string") this.brokerVersion = version;
        resolve(value);
      }, reject: (err) => {
        if (/unknown op:/.test(err.message)) reject(new BridgeError(
          "protocol_mismatch",
          `Broker ${this.brokerVersion ? "v" + this.brokerVersion : "version unknown (older protocol)"} does not support ${op} required by server v${APP_VERSION}. Update the broker host and reload its session after current jobs finish; no operation was applied.`,
          { operation: op }
        ));
        else reject(err);
      }, timer };
      pendingWriteObservations.set(pending, transport);
      this.pending.set(id, pending);
      this.socket.write(observedEncodedFrame(transport, this.#withinFrameLimit(id, op, pending, encodeFrame({ t: "req", id, op, args }))));
      transport.write_returned = true;
    });
  }
  /** AB-380: a frame the broker cannot decode would drop the connection; fail locally instead, without retry. */
  #withinFrameLimit(id, op, pending, data) {
    const bytes = Buffer.byteLength(data);
    if (bytes <= MAX_FRAME_BYTES) return data;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    throw new BridgeError(
      "too_large",
      `${op} request is ${bytes} bytes, over the ${MAX_FRAME_BYTES}-byte frame limit; it was not sent and must not be retried.`,
      { operation: op, bytes, limit: MAX_FRAME_BYTES, retryable: false }
    );
  }
  close() {
    this.socket.end();
    this.socket.destroy();
  }
  settle(f) {
    const p = this.pending.get(f.id);
    if (!p) return;
    this.pending.delete(f.id);
    clearTimeout(p.timer);
    if (f.ok) p.resolve(f.result);
    else p.reject(new BridgeError(f.error.code, f.error.message, f.error.details));
  }
};

export {
  brokerConnectionClosedError,
  BridgeClient
};
