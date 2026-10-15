import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  Broker
} from "./chunk-Q6WIZXMM.mjs";
import "./chunk-3O4FANXH.mjs";
import "./chunk-5ODRFWUC.mjs";
import "./chunk-UP7B3IAO.mjs";
import "./chunk-O6JYMBRZ.mjs";
import "./chunk-EJOLALGI.mjs";
import "./chunk-PKQM4FT7.mjs";
import {
  MessageStore
} from "./chunk-K5TPNON6.mjs";
import "./chunk-7AY2BNQ3.mjs";
import {
  EndpointReservation
} from "./chunk-QTJWQC2O.mjs";
import "./chunk-BZOKQWO2.mjs";
import "./chunk-5DKRQCMP.mjs";
import "./chunk-NYYOAM7P.mjs";
import "./chunk-FYOGWEEN.mjs";
import "./chunk-2IGPD6CX.mjs";
import "./chunk-HFRXC4WN.mjs";
import "./chunk-ZY42XIHJ.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import "./chunk-CE5EGKJK.mjs";
import "./chunk-ZDJZGWFQ.mjs";
import "./chunk-P2FX6QQM.mjs";
import "./chunk-27TGTADT.mjs";
import "./chunk-ATJC2N3J.mjs";
import {
  BridgeClient
} from "./chunk-ZP45A35R.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-BUFYODVF.mjs";
import "./chunk-TK3APK3O.mjs";
import "./chunk-E7IONS7E.mjs";
import "./chunk-HS6DDUE5.mjs";
import "./chunk-AK5FU4JB.mjs";
import "./chunk-Z2YSUEGN.mjs";
import "./chunk-GH2EGBH2.mjs";
import "./chunk-VNJ6NDSK.mjs";
import "./chunk-HZAGME3J.mjs";
import "./chunk-6SM7Z3QO.mjs";
import "./chunk-JA3PXUE2.mjs";
import "./chunk-DATKUSST.mjs";
import "./chunk-MNCHFAWD.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-LM3PW3XM.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-CHGUU5ZH.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-MKVSTCXZ.mjs";
import "./chunk-T4SNBDYX.mjs";
import {
  loadConfig
} from "./chunk-MLQQ7KYC.mjs";
import "./chunk-DBCS4LQM.mjs";
import "./chunk-RVBPLF75.mjs";
import {
  BridgeError
} from "./chunk-JF4RUO76.mjs";
import "./chunk-4KZM24EZ.mjs";
import "./chunk-HYOPFLLN.mjs";
import {
  refreshStorePeerIdentities
} from "./chunk-OUVLODTM.mjs";
import "./chunk-LG5QXURA.mjs";
import {
  JOBS_FILE,
  PROTOCOL_VERSION
} from "./chunk-NT6Y2SKY.mjs";
import "./chunk-VNQ4UNAO.mjs";
import "./chunk-NVDPULGI.mjs";
import "./chunk-DEWCC5JJ.mjs";
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
            mobile ??= await (await import("./activation-YPEQEH2K.mjs")).configuredMobileDashboard(
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
            const { DashboardController } = await import("./dashboard-TO57EKMV.mjs");
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
