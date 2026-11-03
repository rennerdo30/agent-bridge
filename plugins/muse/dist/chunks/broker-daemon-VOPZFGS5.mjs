import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  Broker
} from "./chunk-AMTKBPWE.mjs";
import {
  EndpointReservation
} from "./chunk-636TRCI4.mjs";
import "./chunk-FKTP3PJM.mjs";
import "./chunk-QK7KTN37.mjs";
import "./chunk-VX4T3AJR.mjs";
import "./chunk-QTSBERVU.mjs";
import "./chunk-EZ5FMFGP.mjs";
import "./chunk-GR2JUUJU.mjs";
import {
  MessageStore
} from "./chunk-MELRXY3E.mjs";
import "./chunk-FOGZ4C62.mjs";
import "./chunk-RUNK623W.mjs";
import "./chunk-5N7L7PPR.mjs";
import "./chunk-ME37T4ZK.mjs";
import "./chunk-2DXR4UWB.mjs";
import "./chunk-PIUJVSBK.mjs";
import "./chunk-MO4LLO26.mjs";
import "./chunk-NJ5KUBXQ.mjs";
import "./chunk-QETSCJMA.mjs";
import "./chunk-D5ZGWY46.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import "./chunk-VLV6NLZ5.mjs";
import "./chunk-EFTJLEG4.mjs";
import "./chunk-KOCDFJ23.mjs";
import "./chunk-4BIAQVMP.mjs";
import {
  BridgeClient
} from "./chunk-CPD7N7EY.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-W4SSIT7C.mjs";
import "./chunk-FC26X7NK.mjs";
import "./chunk-IIPG6NSD.mjs";
import "./chunk-X56HDV5C.mjs";
import "./chunk-2VXJZIEE.mjs";
import "./chunk-KQJV6YU3.mjs";
import "./chunk-XZ475COY.mjs";
import "./chunk-XSUBNXYL.mjs";
import "./chunk-7AAS3SBW.mjs";
import "./chunk-JFXJRZ6U.mjs";
import "./chunk-JFVHVXKY.mjs";
import "./chunk-26AIKQES.mjs";
import "./chunk-JTJOFBZ5.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-GUU6GAX6.mjs";
import "./chunk-65Q7CKMQ.mjs";
import "./chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import {
  resolveDbPath
} from "./chunk-6ACJ6BBT.mjs";
import "./chunk-Y3R7DNYE.mjs";
import "./chunk-F23PXWJA.mjs";
import "./chunk-ZNK2PPN3.mjs";
import {
  loadConfig
} from "./chunk-ILTKWOC4.mjs";
import "./chunk-AAI35QKV.mjs";
import "./chunk-MICPYU3I.mjs";
import "./chunk-TSXRAYDD.mjs";
import "./chunk-UEE6Z4PJ.mjs";
import "./chunk-HYOPFLLN.mjs";
import {
  BridgeError
} from "./chunk-IYJ5P7ML.mjs";
import {
  refreshStorePeerIdentities
} from "./chunk-F2RFTLGV.mjs";
import "./chunk-P4CW6EX2.mjs";
import {
  DAEMON_IDLE_EXIT_MS,
  HANDOVER_DRAIN_MS,
  JOBS_FILE,
  PROTOCOL_VERSION
} from "./chunk-5YJKJBJW.mjs";
import {
  ownProcessIdentity
} from "./chunk-AAH2UEC3.mjs";
import "./chunk-6RNADTH4.mjs";

// src/cli/broker-daemon.ts
import { join } from "node:path";
function daemonIdleExitMs(value = process.env.AGENT_BRIDGE_DAEMON_IDLE_EXIT_MS) {
  const ms = value !== void 0 && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  return ms >= 1e3 && ms <= 24 * 60 * 6e4 ? ms : DAEMON_IDLE_EXIT_MS;
}
async function runBrokerDaemon(home, pipe, log) {
  const token = loadOrCreateToken(home);
  for (const deadline = Date.now() + HANDOVER_DRAIN_MS + 5e3; ; ) {
    let client;
    try {
      client = await BridgeClient.connect(pipe, log);
    } catch (error) {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")) break;
      throw error;
    }
    try {
      await client.request("auth", { protocol: PROTOCOL_VERSION, token });
      return 0;
    } catch (error) {
      if (!(error instanceof BridgeError && error.details?.handover === true)) throw error;
    } finally {
      client.close();
    }
    if (Date.now() >= deadline) return 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  void ownProcessIdentity();
  let reservation;
  try {
    reservation = await EndpointReservation.bind(pipe);
  } catch (error) {
    if (error.code === "EADDRINUSE") return 0;
    throw error;
  }
  try {
    const config = loadConfig(home, "other", log);
    if (process.env.AGENT_BRIDGE_DAEMON_CONFIG) {
      const startup = JSON.parse(process.env.AGENT_BRIDGE_DAEMON_CONFIG);
      config.network = startup.network;
      config.mobile = startup.mobile;
      config.dashboardPort = startup.dashboardPort;
    }
    void refreshStorePeerIdentities(home).catch(() => {
    });
    const store = new MessageStore(resolveDbPath(home), log.child("store"));
    try {
      const broker = new Broker(pipe, store, log.child("broker"), token, Date.now, join(home, JOBS_FILE), { home, config: config.network }, { ensure: (force, port) => ensureDashboard(force, port) });
      broker.setHostingMode("daemon");
      let stopping = false, release;
      const stopped = new Promise((resolve) => {
        release = resolve;
      });
      const stop = () => {
        stopping = true;
        release();
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      broker.onNewerClient(stop);
      let dashboard;
      let mobile;
      let listening = false;
      let dashboardOpening;
      let dashboardPort;
      let info = null;
      const idleMs = daemonIdleExitMs();
      broker.exitWhenIdle(idleMs, stop, () => dashboard?.activity?.active(idleMs) ? "dashboard_client" : mobile?.clientActivity(idleMs) ? "mobile_client" : void 0);
      const ensureDashboard = (force, requestedPort) => {
        if (stopping) return Promise.reject(new BridgeError("bad_request", "Daemon is draining."));
        if (!force && !config.dashboard) return Promise.resolve(null);
        const port = requestedPort ?? config.dashboardPort;
        if (dashboardPort !== void 0 && dashboardPort !== port) return Promise.reject(new BridgeError("bad_request", "Dashboard is already configured on a different port; no listener was changed."));
        if (info) return Promise.resolve(info);
        if (dashboardOpening) return dashboardOpening;
        dashboardPort = port;
        dashboardOpening = (async () => {
          let status;
          if (config.mobile) {
            mobile ??= await (await import("./activation-7K3ABWP5.mjs")).configuredMobileDashboard(
              {
                isBroker: true,
                initializeMobileOwnerQuestions: () => !stopping && broker.initializeMobileOwnerQuestions(),
                mobileHostContext: () => broker.mobileHostContext()
              },
              config.mobile,
              { home, pipe, port, log }
            );
            info = await mobile?.start() ?? null;
            status = mobile?.status;
          }
          if (!info) {
            const { DashboardController } = await import("./dashboard-DCGQ5M3D.mjs");
            dashboard ??= new DashboardController({ home, pipe, port, log, ...status ? { mobileStatus: status } : {} });
            info = await dashboard.ensure();
          }
          return info;
        })().catch(() => {
          throw new BridgeError("bad_request", "Daemon dashboard unavailable.");
        }).finally(() => {
          dashboardOpening = void 0;
        });
        return dashboardOpening;
      };
      try {
        try {
          await broker.listen(reservation);
          listening = true;
        } catch (error) {
          if (error.code !== "EADDRINUSE") throw error;
          return 0;
        }
        if (!stopping && process.env.AGENT_BRIDGE_DAEMON_DASHBOARD === "1") {
          await ensureDashboard(false).catch(() => log.warn("daemon dashboard unavailable"));
        }
        if (!stopping) await stopped;
        return 0;
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
        if (listening && !await broker.drain()) log.warn("daemon stopped with requests still running after the drain period");
        await dashboardOpening?.catch(() => {
        });
        await mobile?.close().catch(() => {
        });
        await dashboard?.close().catch(() => {
        });
        if (listening) await broker.close();
        else store.close();
      }
    } catch (error) {
      store.close();
      throw error;
    }
  } finally {
    await reservation.close();
  }
}
export {
  daemonIdleExitMs,
  runBrokerDaemon
};
