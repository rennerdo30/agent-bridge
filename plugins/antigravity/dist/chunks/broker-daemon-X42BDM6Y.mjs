import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  Broker
} from "./chunk-7H445LHY.mjs";
import "./chunk-S6D46GPW.mjs";
import "./chunk-PYWHS2KS.mjs";
import "./chunk-NZ46E7FV.mjs";
import "./chunk-54EQVBE3.mjs";
import "./chunk-G3GFDLFB.mjs";
import {
  MessageStore
} from "./chunk-DQZM2C6A.mjs";
import "./chunk-64TEMWJP.mjs";
import {
  EndpointReservation
} from "./chunk-STHSNPE2.mjs";
import "./chunk-ZZYJ6JT5.mjs";
import "./chunk-EZ6AP6GU.mjs";
import "./chunk-VBKAHWNN.mjs";
import "./chunk-SSBS4UJ2.mjs";
import "./chunk-XRDENSLT.mjs";
import "./chunk-YFEPPNJP.mjs";
import "./chunk-5D5JJI3U.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import "./chunk-CE5EGKJK.mjs";
import "./chunk-KJ76IOTY.mjs";
import "./chunk-L532E7LB.mjs";
import "./chunk-GSECV4GV.mjs";
import "./chunk-XB5BJ567.mjs";
import {
  BridgeClient
} from "./chunk-ASAE72VD.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-P7XEMW2I.mjs";
import "./chunk-OHBE7NMM.mjs";
import "./chunk-6P65RSGE.mjs";
import "./chunk-27TG33K6.mjs";
import "./chunk-ABTE2HH2.mjs";
import "./chunk-HL77AKKV.mjs";
import "./chunk-6X5RM53J.mjs";
import "./chunk-GU7RYQWR.mjs";
import "./chunk-HZAGME3J.mjs";
import "./chunk-OGCI3LAE.mjs";
import "./chunk-X6NBQF5C.mjs";
import "./chunk-IMJI7Z7U.mjs";
import "./chunk-HFRXC4WN.mjs";
import "./chunk-2HKYNEVU.mjs";
import "./chunk-QEAGPKR6.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-XXRMZ4WL.mjs";
import "./chunk-SGLKLGWY.mjs";
import {
  loadConfig
} from "./chunk-TGMXHXCW.mjs";
import "./chunk-SQ6EFEOQ.mjs";
import "./chunk-EA6YAI7Y.mjs";
import {
  BridgeError
} from "./chunk-4QXHCXBU.mjs";
import "./chunk-CUBGS4RC.mjs";
import "./chunk-TEK6WK2V.mjs";
import "./chunk-HYOPFLLN.mjs";
import {
  refreshStorePeerIdentities
} from "./chunk-GEXILR6G.mjs";
import "./chunk-2JCQIMR7.mjs";
import {
  JOBS_FILE,
  PROTOCOL_VERSION
} from "./chunk-EZXQJRQM.mjs";
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
            mobile ??= await (await import("./activation-7CLYMQX4.mjs")).configuredMobileDashboard(
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
            const { DashboardController } = await import("./dashboard-XH7Z2Y5T.mjs");
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
