import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  Broker
} from "./chunk-5Z7FP2SZ.mjs";
import {
  EndpointReservation
} from "./chunk-TX6MQ72Z.mjs";
import "./chunk-R5TSQCEF.mjs";
import "./chunk-LCLDOMKY.mjs";
import "./chunk-DSWZ6TAM.mjs";
import "./chunk-QESHHP6V.mjs";
import "./chunk-WEFPX3AV.mjs";
import "./chunk-35TOAW7U.mjs";
import {
  MessageStore
} from "./chunk-WHRRKPDH.mjs";
import "./chunk-2YQG2OO4.mjs";
import "./chunk-BS63GBZT.mjs";
import "./chunk-KOY2WEKW.mjs";
import "./chunk-TTWXBJZT.mjs";
import "./chunk-XG2YGX2R.mjs";
import "./chunk-GSHYN43Y.mjs";
import "./chunk-ITVUIRKV.mjs";
import "./chunk-S4SFV46C.mjs";
import "./chunk-QETSCJMA.mjs";
import "./chunk-22PNTCJL.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import "./chunk-U4A6B344.mjs";
import "./chunk-JHNQ77BE.mjs";
import "./chunk-W4CNSLCI.mjs";
import "./chunk-X7UA43OI.mjs";
import {
  BridgeClient
} from "./chunk-RRA7GRXQ.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-SYLVRHZ4.mjs";
import "./chunk-I5CUIIGG.mjs";
import "./chunk-RYSPEAAT.mjs";
import "./chunk-XKC4457S.mjs";
import "./chunk-RMZJYAQA.mjs";
import "./chunk-TESZISTY.mjs";
import "./chunk-HM4XQ2TA.mjs";
import "./chunk-XAOLY2E5.mjs";
import "./chunk-4ZN3O4S6.mjs";
import "./chunk-RCEGQOUT.mjs";
import "./chunk-PEHTELGP.mjs";
import "./chunk-MNRBNJYC.mjs";
import "./chunk-HMNVHTMT.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-GYQI4U5Y.mjs";
import "./chunk-CLBKEXQH.mjs";
import "./chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import {
  resolveDbPath
} from "./chunk-VDAHHSUA.mjs";
import "./chunk-56244RMS.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-6JYTZYAL.mjs";
import {
  loadConfig
} from "./chunk-JUASSGME.mjs";
import "./chunk-GM3TUDTN.mjs";
import "./chunk-HZ24RX6M.mjs";
import "./chunk-36POWMHG.mjs";
import "./chunk-I32N5HZ3.mjs";
import "./chunk-HYOPFLLN.mjs";
import {
  BridgeError
} from "./chunk-IYJ5P7ML.mjs";
import {
  refreshStorePeerIdentities
} from "./chunk-WJ7DMN4Z.mjs";
import "./chunk-QOFWTGFE.mjs";
import {
  DAEMON_IDLE_EXIT_MS,
  HANDOVER_DRAIN_MS,
  JOBS_FILE,
  PROTOCOL_VERSION
} from "./chunk-IICYOJJF.mjs";
import {
  ownProcessIdentity
} from "./chunk-ARGAVNKJ.mjs";
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
            mobile ??= await (await import("./activation-XQFTYTBH.mjs")).configuredMobileDashboard(
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
            const { DashboardController } = await import("./dashboard-OFL3G2WN.mjs");
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
