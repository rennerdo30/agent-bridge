import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  Broker
} from "./chunk-OIRTPULD.mjs";
import "./chunk-PNSD3O5L.mjs";
import "./chunk-BLI7AHCU.mjs";
import "./chunk-VTJAD6DT.mjs";
import "./chunk-URYKUXJU.mjs";
import "./chunk-JELCC6JB.mjs";
import {
  MessageStore
} from "./chunk-DCOFYPAZ.mjs";
import "./chunk-PD7WDWMI.mjs";
import "./chunk-U6MA4TR2.mjs";
import "./chunk-LSW2UXWP.mjs";
import "./chunk-M3NEJWZQ.mjs";
import "./chunk-F7JXPAW4.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import "./chunk-7CXSO26J.mjs";
import "./chunk-UISHVEDU.mjs";
import "./chunk-OWLVCDRV.mjs";
import "./chunk-CE5EGKJK.mjs";
import "./chunk-RMCHQA52.mjs";
import "./chunk-I4JRD75E.mjs";
import "./chunk-MRLEVSUM.mjs";
import {
  BridgeClient
} from "./chunk-I7WXGY35.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-KYWLNV7B.mjs";
import "./chunk-FC4XMVT5.mjs";
import "./chunk-XG2CM6V2.mjs";
import "./chunk-C44ELGCV.mjs";
import "./chunk-6NK4XVHR.mjs";
import "./chunk-AJ3G2ZXC.mjs";
import "./chunk-KQJ5KQYW.mjs";
import "./chunk-UUSRNKCB.mjs";
import "./chunk-CNEMWRSZ.mjs";
import "./chunk-ABC6XFSI.mjs";
import "./chunk-HZAGME3J.mjs";
import "./chunk-HO4FDVUF.mjs";
import "./chunk-K4BSZ2BO.mjs";
import "./chunk-DUUQFMF5.mjs";
import "./chunk-HFRXC4WN.mjs";
import "./chunk-5YHR5XJE.mjs";
import "./chunk-KSRGXCIR.mjs";
import "./chunk-6KTEQAZ2.mjs";
import {
  resolveDbPath
} from "./chunk-OXAE5SYF.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-PV5RDKMR.mjs";
import {
  loadConfig
} from "./chunk-EI6SUMB4.mjs";
import {
  BridgeError
} from "./chunk-4QXHCXBU.mjs";
import "./chunk-A5FJFIHB.mjs";
import "./chunk-MIHYBRIY.mjs";
import "./chunk-WYCVEB3J.mjs";
import "./chunk-BK2JHAE4.mjs";
import "./chunk-WM3QOXKL.mjs";
import "./chunk-HYOPFLLN.mjs";
import {
  refreshStorePeerIdentities
} from "./chunk-IA7UPCXY.mjs";
import "./chunk-6JJ25VPZ.mjs";
import {
  JOBS_FILE,
  PROTOCOL_VERSION
} from "./chunk-AH7X4KST.mjs";
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
        mobile ??= await (await import("./activation-WFHJKPDW.mjs")).configuredMobileDashboard(
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
        const { DashboardController } = await import("./dashboard-YW4NQHXG.mjs");
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
      await broker.listen();
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
}
export {
  runBrokerDaemon
};
