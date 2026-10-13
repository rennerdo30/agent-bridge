import { join } from "node:path";
import { Broker } from "../core/broker.js";
import { BridgeClient } from "../core/client.js";
import { loadConfig } from "../core/config.js";
import { JOBS_FILE, PROTOCOL_VERSION } from "../core/constants.js";
import type { Logger } from "../core/logger.js";
import { resolveDbPath } from "../core/paths.js";
import { MessageStore } from "../core/store.js";
import { loadOrCreateToken } from "../core/token.js";
import { refreshStorePeerIdentities } from "../core/store-compatibility.js";
import { BridgeError } from "../core/protocol.js";
import type { DashboardInfo } from "./dashboard.js";
import { EndpointReservation } from "../core/endpoint-reservation.js";

/** Existing broker and services, owned by a demand-start process rather than an MCP session. */
export async function runBrokerDaemon(home: string, pipe: string, log: Logger): Promise<number> {
  const token = loadOrCreateToken(home);
  try {
    const client = await BridgeClient.connect(pipe, log);
    try { await client.request("auth", { protocol: PROTOCOL_VERSION, token }); return 0; }
    finally { client.close(); }
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  let reservation: EndpointReservation;
  try { reservation = await EndpointReservation.bind(pipe); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return 0;
    throw error;
  }
  // No broker-owner store, lease or side worker exists before exclusive bind.
  try {
  const config = loadConfig(home, "other", log);
  // The first eligible client supplies its already-resolved startup config, as embedded hosting did.
  if (process.env.AGENT_BRIDGE_DAEMON_CONFIG) {
    const startup = JSON.parse(process.env.AGENT_BRIDGE_DAEMON_CONFIG);
    config.network = startup.network; config.mobile = startup.mobile; config.dashboardPort = startup.dashboardPort;
  }
  void refreshStorePeerIdentities(home).catch(() => {});
  const store = new MessageStore(resolveDbPath(home), log.child("store"));
  try {
  const broker = new Broker(pipe, store, log.child("broker"), token, Date.now, join(home, JOBS_FILE), { home, config: config.network }, { ensure: (force, port) => ensureDashboard(force, port) });
  broker.setHostingMode("daemon");
  let stopping = false, release!: () => void;
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const stop = () => { stopping = true; release(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  let dashboard: import("./dashboard.js").DashboardController | undefined;
  let mobile: import("../mobile/activation.js").MobileActivation | undefined;
  let listening = false;
  let dashboardOpening: Promise<DashboardInfo | null> | undefined;
  let dashboardPort: number | undefined;
  let info: DashboardInfo | null = null;
  const ensureDashboard = (force: boolean, requestedPort?: number): Promise<DashboardInfo | null> => {
    if (stopping) return Promise.reject(new BridgeError("bad_request", "Daemon is draining."));
    if (!force && !config.dashboard) return Promise.resolve(null);
    const port = requestedPort ?? config.dashboardPort;
    if (dashboardPort !== undefined && dashboardPort !== port) return Promise.reject(new BridgeError("bad_request", "Dashboard is already configured on a different port; no listener was changed."));
    if (info) return Promise.resolve(info);
    if (dashboardOpening) return dashboardOpening;
    dashboardPort = port;
    dashboardOpening = (async () => {
      let status: (() => string) | undefined;
      if (config.mobile) {
        mobile ??= await (await import("../mobile/activation.js")).configuredMobileDashboard({ isBroker: true,
          initializeMobileOwnerQuestions: () => !stopping && broker.initializeMobileOwnerQuestions(), mobileHostContext: () => broker.mobileHostContext() },
        config.mobile, { home, pipe, port, log });
        info = await mobile?.start() ?? null; status = mobile?.status;
      }
      if (!info) {
        const { DashboardController } = await import("./dashboard.js");
        dashboard ??= new DashboardController({ home, pipe, port, log, ...(status ? { mobileStatus: status } : {}) });
        info = await dashboard.ensure();
      }
      return info;
    })().catch(() => { throw new BridgeError("bad_request", "Daemon dashboard unavailable."); }).finally(() => { dashboardOpening = undefined; });
    return dashboardOpening;
  };
  try {
    try { await broker.listen(reservation); listening = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      // Every bind loser exits without unlinking or closing the winner's endpoint.
      return 0;
    }
    if (!stopping && process.env.AGENT_BRIDGE_DAEMON_DASHBOARD === "1") {
      await ensureDashboard(false).catch(() => log.warn("daemon dashboard unavailable"));
    }
    if (!stopping) await stopped;
    return 0;
  } finally {
    process.off("SIGTERM", stop); process.off("SIGINT", stop);
    await dashboardOpening?.catch(() => {});
    await mobile?.close().catch(() => {});
    await dashboard?.close().catch(() => {});
    // Losing listeners must not close/unlink the winner's endpoint.
    if (listening) await broker.close(); else store.close();
  }
  } catch (error) { store.close(); throw error; }
  } finally { await reservation.close(); }
}
