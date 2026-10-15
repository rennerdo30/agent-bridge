import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  Broker
} from "./chunk-6AVR6QCF.mjs";
import "./chunk-Y6P6T2CT.mjs";
import "./chunk-AEOO4W3R.mjs";
import "./chunk-LX674HNK.mjs";
import "./chunk-G5U45FRE.mjs";
import "./chunk-5MXDH27I.mjs";
import "./chunk-VFZTGGKQ.mjs";
import {
  MessageStore
} from "./chunk-4DJPNIFK.mjs";
import "./chunk-SP62MW5S.mjs";
import {
  EndpointReservation
} from "./chunk-CNOHD2U3.mjs";
import "./chunk-LH2FGM5X.mjs";
import "./chunk-E4HUOXIL.mjs";
import "./chunk-WXRMFW2M.mjs";
import "./chunk-RWNACVI7.mjs";
import "./chunk-645EABDJ.mjs";
import "./chunk-HFRXC4WN.mjs";
import "./chunk-ZNFSTUTJ.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import "./chunk-CE5EGKJK.mjs";
import "./chunk-PA4IKD7D.mjs";
import "./chunk-OVC2JA2V.mjs";
import "./chunk-BLJOQ4IE.mjs";
import "./chunk-CRUS2CM2.mjs";
import {
  BridgeClient
} from "./chunk-SFABJ7R4.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-DZ224LAW.mjs";
import "./chunk-66VUFIBS.mjs";
import "./chunk-UOSZCOMB.mjs";
import "./chunk-4MGDH6P4.mjs";
import "./chunk-32VTIIWS.mjs";
import "./chunk-V4VFK2LZ.mjs";
import "./chunk-PZ6QYUCT.mjs";
import "./chunk-3XI26TCG.mjs";
import "./chunk-HZAGME3J.mjs";
import "./chunk-B2TUERJZ.mjs";
import "./chunk-IFCHCM2B.mjs";
import "./chunk-23357HT4.mjs";
import "./chunk-MMA733KX.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-3MV7B6VI.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-KW3CITQI.mjs";
import "./chunk-4H5DTXKU.mjs";
import {
  loadConfig
} from "./chunk-2NHSQ4EH.mjs";
import "./chunk-3X2VUWP6.mjs";
import "./chunk-RE3I7AXX.mjs";
import {
  BridgeError
} from "./chunk-IYJ5P7ML.mjs";
import "./chunk-RZEJWGWA.mjs";
import "./chunk-HYOPFLLN.mjs";
import {
  refreshStorePeerIdentities
} from "./chunk-BQPZDGG6.mjs";
import "./chunk-OIZ5WNNF.mjs";
import {
  JOBS_FILE,
  PROTOCOL_VERSION
} from "./chunk-HIVVJXLN.mjs";
import "./chunk-EMB34XJI.mjs";
import "./chunk-OX5J3NNH.mjs";
import {
  ownProcessIdentity
} from "./chunk-W6KF56AK.mjs";
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
            mobile ??= await (await import("./activation-7OJIT3SZ.mjs")).configuredMobileDashboard(
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
            const { DashboardController } = await import("./dashboard-V47QQH3R.mjs");
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
