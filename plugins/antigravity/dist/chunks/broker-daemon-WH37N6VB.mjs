import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  Broker
} from "./chunk-BURJWRON.mjs";
import "./chunk-EJRITPX6.mjs";
import "./chunk-ROZRKWIN.mjs";
import "./chunk-PN5D5QTP.mjs";
import "./chunk-TTOUANTX.mjs";
import "./chunk-OGYSQRRB.mjs";
import "./chunk-BQLX2WID.mjs";
import {
  MessageStore
} from "./chunk-MKSZBC7V.mjs";
import "./chunk-TW3MKAXB.mjs";
import {
  EndpointReservation
} from "./chunk-7KRUVWS4.mjs";
import "./chunk-56R2JUCL.mjs";
import "./chunk-MMRSLMAK.mjs";
import "./chunk-CJI2WFIH.mjs";
import "./chunk-VEVASND7.mjs";
import "./chunk-I6FU3UBJ.mjs";
import "./chunk-HFRXC4WN.mjs";
import "./chunk-T45DPX3D.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import "./chunk-CE5EGKJK.mjs";
import "./chunk-T5KLR7GG.mjs";
import "./chunk-OVC2JA2V.mjs";
import "./chunk-OS2IGECP.mjs";
import "./chunk-OTY7MWGM.mjs";
import {
  BridgeClient
} from "./chunk-7JCJMPVW.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-OMFOZZRX.mjs";
import "./chunk-CMMGKRH2.mjs";
import "./chunk-2LZMLFPN.mjs";
import "./chunk-CE7RTLL5.mjs";
import "./chunk-6TOQU7AY.mjs";
import "./chunk-V4VFK2LZ.mjs";
import "./chunk-PZ6QYUCT.mjs";
import "./chunk-3HX67A2Z.mjs";
import "./chunk-HZAGME3J.mjs";
import "./chunk-RGJ2AYC5.mjs";
import "./chunk-BUTBKOJ7.mjs";
import "./chunk-AUN6CJPS.mjs";
import "./chunk-33RFCVTF.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-SGOZUATY.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-ZT3W4XMU.mjs";
import "./chunk-AR6CIXT4.mjs";
import {
  loadConfig
} from "./chunk-KAR5Y757.mjs";
import "./chunk-EEBKADYD.mjs";
import "./chunk-RE3I7AXX.mjs";
import {
  BridgeError
} from "./chunk-IYJ5P7ML.mjs";
import "./chunk-TDA76SDP.mjs";
import "./chunk-HYOPFLLN.mjs";
import {
  refreshStorePeerIdentities
} from "./chunk-BKTTXFS6.mjs";
import "./chunk-AR4BZM3F.mjs";
import {
  JOBS_FILE,
  PROTOCOL_VERSION
} from "./chunk-HIVVJXLN.mjs";
import "./chunk-VNQ4UNAO.mjs";
import "./chunk-OX5J3NNH.mjs";
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
            mobile ??= await (await import("./activation-DL5FPVP6.mjs")).configuredMobileDashboard(
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
            const { DashboardController } = await import("./dashboard-E6VH54DS.mjs");
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
