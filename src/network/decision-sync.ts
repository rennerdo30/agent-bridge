import type { OwnerDecision } from "../core/decisions.js";
import type { Logger } from "../core/logger.js";
import type { NetworkService } from "./link.js";
import type { NetworkPair } from "./pairing.js";
import { DECISION_SYNC_CAPABILITY, DECISION_SYNC_FRAME, MAX_SYNC_KNOWN_IDS, MAX_SYNC_STATE_BYTES, MAX_SYNC_STATE_COUNT, decisionSyncWireSchema } from "./decision-protocol.js";

export interface DecisionSyncHost {
  /** All scope-all decisions, oldest first, including superseded history. */
  globalDecisions(): OwnerDecision[];
  /** Id-preserving insert (with tip repair); true when the row is new. */
  importDecision(decision: Omit<OwnerDecision, "current">): boolean;
  /** Notify local sessions once about a newly synced decision. */
  notifyDecision(decision: Omit<OwnerDecision, "current">): void;
}

/**
 * Owner-decision sync between paired PCs. Extension frames arrive only on TLS-PSK links that
 * already authenticated possession of a pairing key, so the paired peer is the only accepted
 * source; unpaired traffic can never reach `receive`. Each decision keeps its id, so imports
 * are idempotent and a decision is never duplicated or rebroadcast.
 */
export class DecisionSync {
  private closed = false;
  private readonly offLink: () => void;

  constructor(private readonly network: NetworkService, private readonly host: DecisionSyncHost, private readonly log: Logger) {
    network.registerExtension(DECISION_SYNC_FRAME, DECISION_SYNC_CAPABILITY, (payload, pair) => this.receive(payload, pair));
    this.offLink = network.onLink((pair) => this.catchUp(pair));
  }

  /** Announce a locally recorded decision to every connected paired PC that supports sync. */
  announce(decision: OwnerDecision): void {
    // Project- and session-scoped decisions stay local: their folders and session names
    // differ per PC, so a peer could neither match nor notify them correctly.
    if (this.closed || decision.scope !== "all") return;
    const wire = toWire(decision);
    for (const pair of this.network.status().paired) {
      if (!pair.connected || !this.network.peerSupports(pair.id, DECISION_SYNC_CAPABILITY)) continue;
      this.network.sendExtension(pair.id, DECISION_SYNC_FRAME, { kind: "upsert", decision: wire })
        .catch((error: Error) => this.log.debug("decision sync announcement failed; catch-up covers it", { host: pair.name, message: error.message }));
    }
  }

  /** Pull decisions recorded while this link was down (both sides ask; both directions sync). */
  private catchUp(pair: NetworkPair): void {
    if (this.closed || !this.network.peerSupports(pair.id, DECISION_SYNC_CAPABILITY)) return;
    const known = this.host.globalDecisions();
    const since = known.reduce((newest, decision) => Math.max(newest, decision.createdAt), 0);
    this.network.sendExtension(pair.id, DECISION_SYNC_FRAME, {
      kind: "sync-request", since, ids: known.map((decision) => decision.id).slice(0, MAX_SYNC_KNOWN_IDS),
    }).catch((error: Error) => this.log.debug("decision sync catch-up request failed", { host: pair.name, message: error.message }));
  }

  private async receive(payload: Record<string, unknown>, pair: NetworkPair): Promise<void> {
    const parsed = decisionSyncWireSchema.safeParse(payload);
    if (!parsed.success) {
      this.log.warn("invalid decision sync frame", { host: pair.name });
      return;
    }
    const frame = parsed.data;
    if (frame.kind === "upsert") {
      if (this.host.importDecision(frame.decision)) this.host.notifyDecision(frame.decision);
      return;
    }
    if (frame.kind === "sync-request") {
      const known = new Set(frame.ids);
      const missing = this.host.globalDecisions()
        .filter((decision) => decision.createdAt > frame.since || !known.has(decision.id));
      for (const chunk of chunkDecisions(missing)) {
        try {
          await this.network.sendExtension(pair.id, DECISION_SYNC_FRAME, { kind: "sync-state", decisions: chunk.map(toWire) });
        } catch {
          break; // A disconnect ends this catch-up; the next link re-asks.
        }
      }
      return;
    }
    for (const decision of frame.decisions) {
      if (this.host.importDecision(decision)) this.host.notifyDecision(decision);
    }
  }

  close(): void {
    this.closed = true;
    this.offLink();
  }
}

/** `current` is derived per broker from the supersedes chain; it never crosses the wire. */
function toWire(decision: OwnerDecision): Omit<OwnerDecision, "current"> {
  const { current: _ignored, ...wire } = decision;
  return wire;
}

function chunkDecisions(decisions: OwnerDecision[]): OwnerDecision[][] {
  const chunks: OwnerDecision[][] = [];
  let current: OwnerDecision[] = [], bytes = 0;
  const flush = () => { if (current.length) chunks.push(current); current = []; bytes = 0; };
  for (const decision of decisions) {
    const size = Buffer.byteLength(JSON.stringify(decision));
    if (current.length >= MAX_SYNC_STATE_COUNT || bytes + size > MAX_SYNC_STATE_BYTES) flush();
    current.push(decision);
    bytes += size;
  }
  flush();
  return chunks;
}
