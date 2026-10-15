import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  Broker
} from "./chunk-4L6TL2Y2.mjs";
import "./chunk-VJMVKI5U.mjs";
import "./chunk-QQTTXACS.mjs";
import "./chunk-7NY35EHL.mjs";
import "./chunk-XXUXLFEE.mjs";
import "./chunk-BDRJ27YH.mjs";
import "./chunk-PDJX7QW3.mjs";
import {
  MessageStore
} from "./chunk-JYBILP32.mjs";
import "./chunk-Y2NVK2K2.mjs";
import {
  EndpointReservation
} from "./chunk-7KRUVWS4.mjs";
import "./chunk-BWKAWC4R.mjs";
import "./chunk-BLIFTOCX.mjs";
import "./chunk-XXD3FPT7.mjs";
import "./chunk-W7LGWN37.mjs";
import "./chunk-E6DYXR6L.mjs";
import "./chunk-HFRXC4WN.mjs";
import "./chunk-RNSGOAUN.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import "./chunk-CE5EGKJK.mjs";
import "./chunk-QKWJX5KI.mjs";
import "./chunk-OVC2JA2V.mjs";
import "./chunk-6GB5V3SB.mjs";
import "./chunk-OTY7MWGM.mjs";
import {
  BridgeClient
} from "./chunk-7JCJMPVW.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-3WG4KJ4A.mjs";
import "./chunk-3CKVIQIW.mjs";
import "./chunk-TTRPTYLF.mjs";
import "./chunk-OVLKPORL.mjs";
import "./chunk-SOSAKSVH.mjs";
import "./chunk-V4VFK2LZ.mjs";
import "./chunk-PZ6QYUCT.mjs";
import "./chunk-MM32GUX3.mjs";
import "./chunk-HZAGME3J.mjs";
import "./chunk-V6YPHOKD.mjs";
import "./chunk-ZG6FSXFH.mjs";
import "./chunk-ZQH63GEB.mjs";
import "./chunk-G3JNKNPN.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-26TSVBIO.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath
} from "./chunk-ZT3W4XMU.mjs";
import "./chunk-5ULR62DP.mjs";
import {
  loadConfig
} from "./chunk-GUU5SJ6T.mjs";
import "./chunk-BOKHWZQ3.mjs";
import "./chunk-RE3I7AXX.mjs";
import {
  BridgeError
} from "./chunk-IYJ5P7ML.mjs";
import "./chunk-WEZZ2PWR.mjs";
import "./chunk-HYOPFLLN.mjs";
import {
  refreshStorePeerIdentities
} from "./chunk-JJ6UMMYX.mjs";
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
            mobile ??= await (await import("./activation-I6QM3SLI.mjs")).configuredMobileDashboard(
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
            const { DashboardController } = await import("./dashboard-KB7RUW45.mjs");
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
