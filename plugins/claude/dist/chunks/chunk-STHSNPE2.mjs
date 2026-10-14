import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ensurePrivateSocketDirectory
} from "./chunk-XXRMZ4WL.mjs";
import {
  FrameDecoder,
  encodeFrame
} from "./chunk-4QXHCXBU.mjs";
import {
  CONNECT_TIMEOUT_MS
} from "./chunk-EZXQJRQM.mjs";

// src/core/endpoint-reservation.ts
import { createServer } from "node:net";
var TENTATIVE_CONNECTION_LIMIT = 32;
var TENTATIVE_FRAME_BYTES = 64 * 1024;
var activationWitnesses = /* @__PURE__ */ new WeakMap();
function hasEndpointActivationWitness(reservation, adopter, server, endpoint, accept) {
  const witness = activationWitnesses.get(reservation);
  return !!witness && witness.bound && !witness.closed && witness.adopter === adopter && witness.accept === accept && witness.server === server && witness.endpoint === endpoint && server.listening && server.address() === endpoint && server.listeners("connection").includes(accept);
}
var EndpointReservation = class _EndpointReservation {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.server = createServer(this.tentative);
    const witness = { server: this.server, endpoint, bound: false, closed: false };
    activationWitnesses.set(this, witness);
    this.server.once("close", () => {
      witness.closed = true;
    });
    this.server.on("error", () => {
    });
  }
  endpoint;
  sockets = /* @__PURE__ */ new Set();
  active = false;
  closed = false;
  owned = false;
  server;
  tentative = (socket) => {
    if (this.closed || this.sockets.size >= TENTATIVE_CONNECTION_LIMIT) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
    const decoder = new FrameDecoder(TENTATIVE_FRAME_BYTES);
    let received = 0, answered = false;
    socket.on("error", () => {
    });
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("data", (chunk) => {
      try {
        if (answered) {
          socket.destroy();
          return;
        }
        received += Buffer.byteLength(chunk);
        if (received > TENTATIVE_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        const request = decoder.push(chunk)[0];
        if (!request) return;
        if (request.t !== "req" || !Number.isSafeInteger(request.id)) {
          socket.destroy();
          return;
        }
        answered = true;
        socket.end(encodeFrame({
          t: "res",
          id: request.id,
          ok: false,
          error: { code: "internal", message: "Core is initializing; no request was admitted." }
        }));
      } catch {
        socket.destroy();
      }
    });
  };
  static async bind(endpoint) {
    ensurePrivateSocketDirectory(endpoint);
    const reservation = new _EndpointReservation(endpoint);
    await new Promise((resolve, reject) => {
      reservation.server.once("error", reject);
      reservation.server.listen(endpoint, () => {
        reservation.server.removeListener("error", reject);
        reservation.owned = true;
        activationWitnesses.get(reservation).bound = true;
        resolve();
      });
    });
    return reservation;
  }
  /** Still tentative while the owner initializes and validates all its resources. */
  ownedServer(endpoint) {
    if (!this.owned || this.closed || this.active || this.endpoint !== endpoint || !this.server.listening) throw new Error("Core endpoint reservation unavailable.");
    return this.server;
  }
  activate(accept, adopter) {
    if (!this.owned || this.closed || this.active || !this.server.listening) throw new Error("Core endpoint reservation unavailable.");
    this.active = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server.removeListener("connection", this.tentative);
    this.server.on("connection", accept);
    const witness = activationWitnesses.get(this);
    witness.adopter = adopter;
    witness.accept = accept;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    activationWitnesses.get(this).closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.owned && this.server.listening) await new Promise((resolve) => this.server.close(() => resolve()));
  }
};

export {
  TENTATIVE_CONNECTION_LIMIT,
  TENTATIVE_FRAME_BYTES,
  hasEndpointActivationWitness,
  EndpointReservation
};
