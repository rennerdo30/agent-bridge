import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUi, classifyPeers } from "../src/cli/ui.js";
import { readDashboard } from "../src/core/dashboard-read.js";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeClient } from "../src/core/client.js";
import { JOBS_FILE, PROTOCOL_VERSION } from "../src/core/constants.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { until } from "./helpers.js";
import { NetworkService } from "../src/network/link.js";
import { RemoteDashboard } from "../src/network/remote-dashboard.js";
import { DASHBOARD_CAPABILITY, DASHBOARD_FRAME, DASHBOARD_RATE_LIMIT, DASHBOARD_TIMEOUT_MS, dashboardRequestSchema } from "../src/network/dashboard-protocol.js";
import { CODEX_SESSION, CODEX_CHILD, installTranscriptFixtures } from "./transcript-fixtures.js";

import { aHome, bHome, cleanup, cfg, RUN, JOB, seed, links, node, admin, peer } from "./remote-dashboard-fixture.js";

describe("paired dashboard HTTP", () => {
  it("restores paired links and remote peers when a session with stale disabled config takes over", async () => {
    const disabled = { ...cfg("alpha"), enabled: false };
    const first = await node(aHome, "first", false, disabled, false);
    await first.setSessionId("first-session");
    const successor = await node(aHome, "successor", false, { ...disabled }, false);
    await successor.setSessionId("successor-session");
    await node(bHome, "session");
    const a = await admin(aHome), b = await admin(bHome);
    await a.request("networkConfigure", cfg("alpha"));
    const status = await b.request("networkStatus", {});
    const invitation = await b.request("networkPair", {});
    await a.request("networkLink", { code: invitation.code, host: "127.0.0.1", port: status.port! });
    expect((await successor.peers()).some((peer) => peer.name === "beta/session")).toBe(true);
    a.close();
    await first.stop();
    await until(() => successor.isBroker && successor.isConnected, 15_000);
    let restored = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await successor.peers()).some((peer) => peer.name === "beta/session")) { restored = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(restored).toBe(true);
    expect(await successor.networkStatus()).toMatchObject({ enabled: true, paired: [{ connected: true, name: "beta" }] });
    const message = await successor.send({ to: "beta/session", body: "after takeover" });
    expect(message.deliveredTo).toContain("beta/session");
  });

  it("reads a reloaded session immediately through both the local reader and paired proxy", async () => {
    const fixture = seed(); vi.stubEnv("CODEX_HOME", fixture.paths.codex);
    await node(aHome, "local");
    const original = await node(bHome, "session");
    const a = await admin(aHome), b = await admin(bHome);
    const status = await b.request("networkStatus", {});
    const invitation = await b.request("networkPair", {});
    await a.request("networkLink", { code: invitation.code, host: "127.0.0.1", port: status.port! });
    b.close(); await original.stop();
    const reloaded = await node(bHome, "session", false, { ...cfg("beta"), port: status.port! }, false);
    expect(reloaded.currentSessionId).toBe(CODEX_SESSION);
    const peers = await reloaded.peers();
    const local = await readDashboard({ home: bHome, log: nullLogger, peers: () => peers, transcripts: fixture.paths }, { path: "/api/sessions/session/chat" });
    expect(local.status).toBe(200);
    const ui = await startUi({ home: aHome, pipe: resolvePipePath(aHome, {}), port: 0, log: nullLogger }); cleanup.push(() => ui.close());
    const base = ui.url.replace(/\/\?t=.*$/, "");
    const cookie = String((await fetch(ui.url, { redirect: "manual" })).headers.get("set-cookie")).split(";")[0]!;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      response = await fetch(`${base}/api/sessions/beta%2Fsession/chat`, { headers: { cookie } });
      if (response.status === 200) break;
      await response.arrayBuffer();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ...local.body as object, host: "beta" });
  });
});
