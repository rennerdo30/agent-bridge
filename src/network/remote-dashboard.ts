import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readDashboard, type DashboardReadContext } from "../core/dashboard-read.js";
import type { NetworkService } from "./link.js";
import type { NetworkPair } from "./pairing.js";
import { DASHBOARD_CAPABILITY, DASHBOARD_FRAME, DASHBOARD_TIMEOUT_MS, DASHBOARD_RATE_LIMIT, DASHBOARD_RATE_WINDOW_MS, DASHBOARD_MAX_PENDING, DASHBOARD_MAX_RESPONSE_BYTES, dashboardRequestSchema, dashboardWireSchema, type DashboardReadRequest, type DashboardReadResult } from "./dashboard-protocol.js";

interface Pending { host: string; resolve: (value: DashboardReadResult) => void; timer: NodeJS.Timeout }
export const dashboardError = (code: string, error: string, status = 503): DashboardReadResult => ({ status, body: { code, error } });

/** Read-only inspection by authenticated paired owners, using the local dashboard's own readers. */
export class RemoteDashboard {
  private readonly pending = new Map<string, Pending>();
  private readonly rates = new Map<string, { at: number; count: number }>();
  private closed = false;
  constructor(private readonly network: NetworkService, private readonly context: DashboardReadContext) {
    network.registerExtension(DASHBOARD_FRAME, DASHBOARD_CAPABILITY, (payload, pair) => this.receive(payload, pair));
  }

  async request(host: string, raw: DashboardReadRequest): Promise<DashboardReadResult> {
    const parsed = dashboardRequestSchema.safeParse(raw);
    if (!parsed.success) return dashboardError("bad_request", "Invalid dashboard read request.", 400);
    const pair = this.network.status().paired.find((p) => p.id === host || p.name === host);
    if (this.closed || !pair?.connected) return dashboardError("remote_offline", "The paired PC is not connected.");
    if (!this.network.peerSupports(host, DASHBOARD_CAPABILITY)) return dashboardError("remote_update_needed", "Update and restart the paired PC's hosting sessions to read its dashboard.", 409);
    if (this.pending.size >= DASHBOARD_MAX_PENDING) return dashboardError("remote_busy", "Too many pending dashboard reads.", 429);
    const rid = randomUUID();
    const response = new Promise<DashboardReadResult>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(rid); resolve(dashboardError("remote_timeout", "The paired dashboard read timed out.", 504)); }, DASHBOARD_TIMEOUT_MS);
      this.pending.set(rid, { host: pair.id, resolve, timer });
    });
    try { await this.network.sendExtension(host, DASHBOARD_FRAME, { kind: "request", rid, request: parsed.data }); }
    catch { this.finish(rid, dashboardError("remote_offline", "The paired PC disconnected.")); }
    return response;
  }

  private finish(rid: string, result: DashboardReadResult): void {
    const pending = this.pending.get(rid);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(rid); pending.resolve(result);
  }

  private async receive(payload: Record<string, unknown>, pair: NetworkPair): Promise<void> {
    const parsed = dashboardWireSchema.safeParse(payload);
    if (!parsed.success) {
      if (payload.kind === "request" && z.uuid().safeParse(payload.rid).success) {
        try { await this.network.sendExtension(pair.id, DASHBOARD_FRAME, { kind: "response", rid: payload.rid, result: dashboardError("bad_request", "Invalid dashboard read request.", 400) }); } catch { /* requester times out */ }
      }
      return;
    }
    const frame = parsed.data;
    if (frame.kind === "response") {
      if (this.pending.get(frame.rid)?.host === pair.id) this.finish(frame.rid, frame.result);
      return;
    }
    const now = Date.now();
    let rate = this.rates.get(pair.id);
    if (!rate || now - rate.at >= DASHBOARD_RATE_WINDOW_MS) { rate = { at: now, count: 0 }; this.rates.set(pair.id, rate); }
    let result: DashboardReadResult;
    if (++rate.count > DASHBOARD_RATE_LIMIT) result = dashboardError("remote_rate_limited", "Dashboard read rate limit reached.", 429);
    else {
      try { result = await readDashboard(this.context, frame.request); }
      catch { result = dashboardError("remote_read_failed", "The paired dashboard could not read this record.", 500); }
    }
    if (Buffer.byteLength(JSON.stringify(result)) > DASHBOARD_MAX_RESPONSE_BYTES) result = dashboardError("remote_response_too_large", "This dashboard page is too large; request a smaller page.", 413);
    // A disconnect is a read failure, never grounds to tear down a replacement link.
    try { await this.network.sendExtension(pair.id, DASHBOARD_FRAME, { kind: "response", rid: frame.rid, result }); } catch { /* requester times out */ }
  }

  close(): void {
    this.closed = true;
    for (const rid of this.pending.keys()) this.finish(rid, dashboardError("remote_offline", "Networking stopped."));
    this.rates.clear();
  }
}
