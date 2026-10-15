import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  Broker
} from "./chunk-REYFKXWP.mjs";
import "./chunk-Z7ZUAA6X.mjs";
import "./chunk-KWAOBW6F.mjs";
import "./chunk-3SFC4UNO.mjs";
import "./chunk-6ORO4SRR.mjs";
import "./chunk-U23VOOPW.mjs";
import "./chunk-GE6S3I24.mjs";
import {
  MessageStore
} from "./chunk-CYQYJS7T.mjs";
import "./chunk-5IRXJQC5.mjs";
import {
  EndpointReservation
} from "./chunk-D67MGEX6.mjs";
import "./chunk-NUKBWI2C.mjs";
import "./chunk-BRSL3AS7.mjs";
import "./chunk-FC5SUIBI.mjs";
import "./chunk-3EU2JFGJ.mjs";
import "./chunk-NHXDT6HJ.mjs";
import "./chunk-HFRXC4WN.mjs";
import "./chunk-BQKXWUBY.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import "./chunk-CE5EGKJK.mjs";
import "./chunk-OWL64MBN.mjs";
import "./chunk-I263LBHO.mjs";
import "./chunk-O3RZGVHK.mjs";
import "./chunk-2PXFURA6.mjs";
import {
  BridgeClient
} from "./chunk-B3K53X7D.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-EH2D4DSB.mjs";
import "./chunk-PMHRBYVO.mjs";
import "./chunk-BZKC74JP.mjs";
import "./chunk-XKD7DY5S.mjs";
import "./chunk-VG2BPYQG.mjs";
import "./chunk-RVDZO344.mjs";
import "./chunk-BDVUYUUR.mjs";
import "./chunk-4NI65KN4.mjs";
import "./chunk-HZAGME3J.mjs";
import "./chunk-QUJ3KA6K.mjs";
import "./chunk-Z7XOA4UX.mjs";
import "./chunk-NGVYFQBO.mjs";
import "./chunk-BJ5JARC7.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-DEG2WWA3.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-5FNZ2HXA.mjs";
import "./chunk-CAIIZP3X.mjs";
import {
  loadConfig
} from "./chunk-S72NJQVR.mjs";
import "./chunk-KUUDTYJ7.mjs";
import "./chunk-5H3R35DU.mjs";
import {
  BridgeError
} from "./chunk-IYJ5P7ML.mjs";
import "./chunk-54NYPMRK.mjs";
import "./chunk-HYOPFLLN.mjs";
import {
  refreshStorePeerIdentities
} from "./chunk-LNAYXYZY.mjs";
import "./chunk-SAM43D5P.mjs";
import {
  DAEMON_IDLE_EXIT_MS,
  HANDOVER_DRAIN_MS,
  JOBS_FILE,
  PROTOCOL_VERSION
} from "./chunk-QLF3MF4O.mjs";
import "./chunk-EMB34XJI.mjs";
import "./chunk-OX5J3NNH.mjs";
import {
  ownProcessIdentity
} from "./chunk-W6KF56AK.mjs";
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
      broker.exitWhenIdle(daemonIdleExitMs(), stop);
      let dashboard;
      let mobile;
      let listening = false;
      let dashboardOpening;
      let dashboardPort;
      let info = null;
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
            mobile ??= await (await import("./activation-QTONBB2H.mjs")).configuredMobileDashboard(
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
            const { DashboardController } = await import("./dashboard-7QJTVQH7.mjs");
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
