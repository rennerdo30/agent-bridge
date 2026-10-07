import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  BridgeError,
  FrameDecoder,
  encodeFrame
} from "./chunk-SOPZATYP.mjs";
import {
  CONNECT_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  REQUEST_TIMEOUT_MS
} from "./chunk-DQEWVRBU.mjs";

// src/core/client.ts
import { EventEmitter } from "node:events";
import { connect } from "node:net";
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
        p.reject(new Error("connection to broker closed"));
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
  /** Connect to an existing broker. Rejects with the socket error (ENOENT/ECONNREFUSED if nobody listens). */
  static connect(pipePath, log, timeoutMs = CONNECT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const socket = connect(pipePath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error("timed out connecting to broker"), { code: "ETIMEDOUT" }));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(new _BridgeClient(socket, log));
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
  get isClosed() {
    return this.closed;
  }
  request(op, args, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error("connection to broker closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`broker request timed out: ${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeFrame({ t: "req", id, op, args }));
    });
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
  BridgeClient
};
