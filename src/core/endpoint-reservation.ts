import { createServer, type Server, type Socket } from "node:net";
import { CONNECT_TIMEOUT_MS } from "./constants.js";
import { ensurePrivateSocketDirectory } from "./paths.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
import type { StartupBudget } from "./startup-budget.js";

export const TENTATIVE_CONNECTION_LIMIT = 32;
export const TENTATIVE_FRAME_BYTES = 64 * 1024;

type ActivationWitness = { server: Server; endpoint: string; bound: boolean; closed: boolean;
  adopter?: object; accept?: (socket: Socket) => void };
const activationWitnesses = new WeakMap<EndpointReservation, ActivationWitness>();

/** Observation only: caller metadata cannot create an actual activation witness. */
export function hasEndpointActivationWitness(reservation: EndpointReservation, adopter: object,
  server: Server, endpoint: string, accept: (socket: Socket) => void): boolean {
  const witness = activationWitnesses.get(reservation);
  return !!witness && witness.bound && !witness.closed && witness.adopter === adopter && witness.accept === accept
    && witness.server === server && witness.endpoint === endpoint && server.listening && server.address() === endpoint
    && server.listeners("connection").includes(accept);
}

/** Exclusive transport reservation, with no store, worker, authentication or mutation authority. */
export class EndpointReservation {
  private readonly sockets = new Set<Socket>();
  private active = false;
  private closed = false;
  private owned = false;
  private readonly server: Server;
  private constructor(readonly endpoint: string) {
    this.server = createServer(this.tentative);
    const witness: ActivationWitness = { server: this.server, endpoint, bound: false, closed: false };
    activationWitnesses.set(this, witness);
    this.server.once("close", () => { witness.closed = true; });
    // The adopting broker supplies its normal diagnostics after activation.
    this.server.on("error", () => {});
  }
  private tentative = (socket: Socket): void => {
    if (this.closed || this.sockets.size >= TENTATIVE_CONNECTION_LIMIT) { socket.destroy(); return; }
    this.sockets.add(socket); socket.setEncoding("utf8");
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
    const decoder = new FrameDecoder(TENTATIVE_FRAME_BYTES);
    let received = 0, answered = false;
    socket.on("error", () => {});
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("data", (chunk: string) => {
      try {
        if (answered) { socket.destroy(); return; }
        received += Buffer.byteLength(chunk);
        if (received > TENTATIVE_FRAME_BYTES) { socket.destroy(); return; }
        const request = decoder.push(chunk)[0];
        if (!request) return;
        if (request.t !== "req" || !Number.isSafeInteger(request.id)) { socket.destroy(); return; }
        answered = true;
        socket.end(encodeFrame({ t: "res", id: request.id, ok: false,
          error: { code: "internal", message: "Core is initializing; no request was admitted." } }));
      } catch { socket.destroy(); }
    });
  };
  static async bind(endpoint: string, startup?:StartupBudget): Promise<EndpointReservation> {
    startup?.remaining();ensurePrivateSocketDirectory(endpoint,undefined,false,startup?()=>startup.remaining():undefined);startup?.remaining();
    const reservation = new EndpointReservation(endpoint);
    await new Promise<void>((resolve, reject) => {
      const pending=startup?new AbortController():undefined;
      const detach=()=>{startup?.signal.removeEventListener('abort',abort);reservation.server.removeListener('error',failed);};
      const failed=(error:unknown)=>{detach();reject(error);};
      const abort=()=>{pending?.abort(startup!.signal.reason);reservation.server.close(()=>failed(startup!.signal.reason));};
      startup?.signal.addEventListener('abort',abort,{once:true});
      reservation.server.once("error", failed);
      reservation.server.listen(startup?{path:endpoint,signal:pending!.signal}:endpoint, () => {
        reservation.owned = true;activationWitnesses.get(reservation)!.bound = true;
        try{startup?.remaining();detach();resolve();}
        catch(error){reservation.server.close(()=>failed(error));}
      });
      if(startup?.signal.aborted)abort();
    });
    return reservation;
  }
  /** Still tentative while the owner initializes and validates all its resources. */
  ownedServer(endpoint: string): Server {
    if (!this.owned || this.closed || this.active || this.endpoint !== endpoint || !this.server.listening) throw new Error("Core endpoint reservation unavailable.");
    return this.server;
  }
  activate(accept: (socket: Socket) => void, adopter?: object): void {
    if (!this.owned || this.closed || this.active || !this.server.listening) throw new Error("Core endpoint reservation unavailable.");
    this.active = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server.removeListener("connection", this.tentative);
    this.server.on("connection", accept);
    const witness = activationWitnesses.get(this)!;
    witness.adopter = adopter; witness.accept = accept;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    activationWitnesses.get(this)!.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    // Only a verified successful binder can close its transport. No unlink or
    // cleanup path exists for a failed bind/unknown holder.
    if (this.owned && this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
