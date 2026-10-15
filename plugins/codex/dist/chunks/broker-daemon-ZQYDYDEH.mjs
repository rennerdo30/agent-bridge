import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  Broker
} from "./chunk-ZJO22YWL.mjs";
import "./chunk-PISNVC3G.mjs";
import "./chunk-EK3MVAU4.mjs";
import "./chunk-2E7EOFOS.mjs";
import "./chunk-ILEPXOLC.mjs";
import "./chunk-3MLQ37LX.mjs";
import "./chunk-VD47O4S4.mjs";
import {
  MessageStore
} from "./chunk-3A3MV5NB.mjs";
import "./chunk-5SGQ4VMX.mjs";
import {
  EndpointReservation
} from "./chunk-YQ6RXTTA.mjs";
import "./chunk-TZBCVENP.mjs";
import "./chunk-ZYYKBS73.mjs";
import "./chunk-YGKOYMWI.mjs";
import "./chunk-5T4RJ7IQ.mjs";
import "./chunk-72TFE3RP.mjs";
import "./chunk-UGXIQ7AG.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import "./chunk-CE5EGKJK.mjs";
import "./chunk-FE5BZOBY.mjs";
import "./chunk-OVC2JA2V.mjs";
import "./chunk-76X7DQOL.mjs";
import {
  BridgeClient
} from "./chunk-K2APWES6.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-PGDR2A6R.mjs";
import "./chunk-ML6EF2TB.mjs";
import "./chunk-QTHUI57J.mjs";
import "./chunk-SGNLNCNA.mjs";
import "./chunk-ZLPDRPGZ.mjs";
import "./chunk-Q2EWUQSM.mjs";
import "./chunk-Q4KC4TSQ.mjs";
import "./chunk-NEJUVKGO.mjs";
import "./chunk-4ZN3O4S6.mjs";
import "./chunk-OYDHKOEV.mjs";
import "./chunk-SPGRZ3MU.mjs";
import "./chunk-NR4D7G7R.mjs";
import "./chunk-L7NKUEJL.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-ZH2USODZ.mjs";
import "./chunk-E5ZSIZVD.mjs";
import "./chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-HJGP2JM4.mjs";
import "./chunk-Q5IQLWCD.mjs";
import "./chunk-QZCBQNZ3.mjs";
import {
  loadConfig
} from "./chunk-IJB7OPWL.mjs";
import "./chunk-6XRCYILV.mjs";
import "./chunk-AHTV3VZF.mjs";
import {
  BridgeError
} from "./chunk-IYJ5P7ML.mjs";
import "./chunk-VLWA2RF6.mjs";
import "./chunk-OX5J3NNH.mjs";
import "./chunk-HYOPFLLN.mjs";
import {
  refreshStorePeerIdentities
} from "./chunk-K2GEQFVF.mjs";
import "./chunk-2SAFLVLW.mjs";
import {
  JOBS_FILE,
  PROTOCOL_VERSION
} from "./chunk-HIVVJXLN.mjs";
import {
  ownProcessIdentity
} from "./chunk-HYVC3VSW.mjs";
import "./chunk-6RNADTH4.mjs";

// src/cli/broker-daemon.ts
import { join } from "node:path";
async function runBrokerDaemon(home, pipe, log) {
  const token = loadOrCreateToken(home);
  try {
    const client = await BridgeClient.connect(pipe, log);
    try {
      await client.request("auth", { protocol: PROTOCOL_VERSION, token });
      return 0;
    } finally {
      client.close();
    }
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")) throw error;
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
            mobile ??= await (await import("./activation-4CSBG6WQ.mjs")).configuredMobileDashboard(
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
            const { DashboardController } = await import("./dashboard-GP7MSLP5.mjs");
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
  runBrokerDaemon
};
