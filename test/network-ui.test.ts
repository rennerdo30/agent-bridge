import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUi } from "../src/cli/ui.js";
import { BridgeNode } from "../src/core/node.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { nullLogger } from "../src/core/logger.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { applyWindowsFirewall, detectFirewall } from "../src/network/firewall.js";
import { makeEnv, type TestEnv } from "./helpers.js";

// Never probe or modify the host firewall in tests, even through an authenticated endpoint.
vi.mock("../src/network/firewall.js", async (original) => ({
  ...await original<typeof import("../src/network/firewall.js")>(),
  detectFirewall: vi.fn(async () => ({ state: "unknown", detail: "test policy" })),
  applyWindowsFirewall: vi.fn(async () => {}),
}));
const ACTIONS = ["configure", "pair", "link", "unlink", "verify", "firewall"];
const LOOPBACK = "127.0.0.1";
const environments: TestEnv[] = [];
const nodes: BridgeNode[] = [];
const dashboards: Awaited<ReturnType<typeof startUi>>[] = [];
let env: TestEnv, ui: Awaited<ReturnType<typeof startUi>>, cookie: string;
const base = () => new URL(ui.url).origin;
const headers = () => ({ cookie, "x-agent-bridge": "1", "content-type": "application/json" });
const post = (action: string, body = {}) => fetch(`${base()}/api/network/${action}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
const config = (name: string, enabled = true) => ({ ...DEFAULT_NETWORK_CONFIG, enabled, name, bind: LOOPBACK, port: 0, discovery: false });
function host(environment: TestEnv, name: string) {
  const node = new BridgeNode({ pipePath: environment.pipe, dbPath: environment.db, token: loadOrCreateToken(environment.home), agent: "claude", name, cwd: environment.home, autoWake: false, log: nullLogger, network: { home: environment.home, config: config(name, false) } });
  nodes.push(node);
  return node;
}
beforeEach(async () => {
  vi.clearAllMocks();
  env = makeEnv(); environments.push(env);
  await host(env, "local-pc").start();
  ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger, usage: async () => [] }); dashboards.push(ui);
  const response = await fetch(ui.url, { redirect: "manual" });
  cookie = response.headers.get("set-cookie")!.split(";")[0]!;
});
afterEach(async () => {
  for (const dashboard of dashboards.splice(0)) await dashboard.close();
  for (const node of nodes.splice(0)) await node.stop();
  for (const environment of environments.splice(0)) await environment.cleanup();
});

describe("authenticated dashboard network flow", () => {
  it("reports a missing broker as unavailable for both transfer endpoints", async () => {
    await nodes[0]!.stop();
    expect((await fetch(`${base()}/api/transfers`, { headers: { cookie } })).status).toBe(503);
    expect((await fetch(`${base()}/api/transfers/${randomUUID()}/cancel`, { method: "POST", headers: headers() })).status).toBe(503);
  });
  it("requires the dashboard secret for status and the custom header for every POST", async () => {
    expect((await fetch(`${base()}/api/network`)).status).toBe(403);
    expect((await fetch(`${base()}/api/transfers`)).status).toBe(403);
    expect((await fetch(`${base()}/api/transfers/${randomUUID()}/cancel`, { method: "POST", headers: { "x-agent-bridge": "1" } })).status).toBe(403);
    expect((await fetch(`${base()}/api/transfers/${randomUUID()}/cancel`, { method: "POST", headers: { cookie } })).status).toBe(403);
    for (const action of ACTIONS) {
      expect((await fetch(`${base()}/api/network/${action}`, { method: "POST", headers: { "x-agent-bridge": "1" }, body: "{}" })).status).toBe(403);
      expect((await fetch(`${base()}/api/network/${action}`, { method: "POST", headers: { cookie }, body: "{}" })).status).toBe(403);
    }
    expect(applyWindowsFirewall).not.toHaveBeenCalled();
    expect(detectFirewall).not.toHaveBeenCalled();
  });

  it("lists progress and cancels paired transfers using authenticated dashboard endpoints", async () => {
    expect(await (await fetch(`${base()}/api/transfers`, { headers: { cookie } })).json()).toEqual({ transfers: [] });
    await post("configure", { ...config("local-pc"), confirm: true });
    const other = makeEnv(); environments.push(other);
    const otherHost = host(other, "remote-pc"); await otherHost.start();
    const otherUi = await startUi({ home: other.home, pipe: other.pipe, port: 0, log: nullLogger, usage: async () => [] }); dashboards.push(otherUi);
    const login = await fetch(otherUi.url, { redirect: "manual" });
    const otherHeaders = { ...headers(), cookie: login.headers.get("set-cookie")!.split(";")[0]! }; const otherBase = new URL(otherUi.url).origin;
    await fetch(`${otherBase}/api/network/configure`, { method: "POST", headers: otherHeaders, body: JSON.stringify({ ...config("remote-pc"), confirm: true }) });
    const status = await (await fetch(`${otherBase}/api/network`, { headers: otherHeaders })).json();
    const invitation = await (await fetch(`${otherBase}/api/network/pair`, { method: "POST", headers: otherHeaders, body: "{}" })).json();
    await post("link", { code: invitation.code, address: `${LOOPBACK}:${status.port}` });
    const source = join(env.home, "cancel.bin"); const file = await open(source, "wx"); await file.truncate(64 * 1024 * 1024); await file.close();
    // A large disk-backed file keeps the transfer active while the authenticated endpoint cancels it.
    const sender = nodes[0]!;
    const started = await sender.sendFiles("remote-pc/remote-pc", [source]);
    const cancelled = await fetch(`${base()}/api/transfers/${started.id}/cancel`, { method: "POST", headers: headers() });
    expect(cancelled.status).toBe(200); expect(await cancelled.json()).toEqual({ id: started.id, cancelled: true });
    const listed = await (await fetch(`${base()}/api/transfers`, { headers: { cookie } })).json();
    expect(listed.transfers.find((transfer: { id: string }) => transfer.id === started.id)).toMatchObject({ id: started.id, direction: "send", status: "cancelled", bytes: expect.any(Number), totalBytes: expect.any(Number), percent: expect.any(Number), createdAt: expect.any(Number), updatedAt: expect.any(Number) });
    expect((await fetch(`${base()}/api/transfers/bad/cancel`, { method: "POST", headers: headers() })).status).toBe(400);
    expect((await fetch(`${base()}/api/transfers/${randomUUID()}/cancel`, { method: "POST", headers: headers() })).status).toBe(404);
    await post("configure", { enabled: false, confirm: true });
    expect((await (await fetch(`${base()}/api/transfers`, { headers: { cookie } })).json()).transfers).toHaveLength(1);
  });

  it("saves only confirmed valid settings, preserves other keys and reloads without restarting sessions", async () => {
    writeFileSync(join(env.home, "config.json"), JSON.stringify({ maxJobs: 8, network: { future: "keep" } }));
    expect((await post("configure", config("local-pc"))).status).toBe(400);
    expect((await post("configure", { ...config("local-pc"), port: -1, confirm: true })).status).toBe(400);
    expect((await post("configure", { ...config("local-pc"), confirm: true })).status).toBe(200);
    const state = await (await fetch(`${base()}/api/network`, { headers: { cookie } })).json();
    expect(state).toMatchObject({ enabled: true, identity: { name: "local-pc" }, config: config("local-pc") });
    expect(state.port).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(env.home, "config.json"), "utf8"))).toMatchObject({ version: 1, maxJobs: 8, network: { enabled: true, future: "keep" } });
    expect((await post("configure", { enabled: false, confirm: true })).status).toBe(200);
    expect(await (await fetch(`${base()}/api/network`, { headers: { cookie } })).json()).toMatchObject({ enabled: false, config: config("local-pc", false) });
  });

  it("creates and links codes, lists health/remote peers, verifies an echo and unlinks on loopback only", async () => {
    await post("configure", { ...config("local-pc"), confirm: true });
    const other = makeEnv(); environments.push(other);
    const otherHost = host(other, "remote-pc"); await otherHost.start();
    const otherUi = await startUi({ home: other.home, pipe: other.pipe, port: 0, log: nullLogger, usage: async () => [] }); dashboards.push(otherUi);
    const login = await fetch(otherUi.url, { redirect: "manual" });
    const otherHeaders = { ...headers(), cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    const otherBase = new URL(otherUi.url).origin;
    await fetch(`${otherBase}/api/network/configure`, { method: "POST", headers: otherHeaders, body: JSON.stringify({ ...config("remote-pc"), confirm: true }) });
    const remoteState = await (await fetch(`${otherBase}/api/network`, { headers: otherHeaders })).json();
    const invitation = await (await fetch(`${otherBase}/api/network/pair`, { method: "POST", headers: otherHeaders, body: "{}" })).json();
    expect(invitation.expiresAt - Date.now()).toBeGreaterThan(590_000);
    const linked = await post("link", { address: `${LOOPBACK}:${remoteState.port}`, code: invitation.code });
    expect(linked.status).toBe(200);
    const remote = await linked.json();
    expect(remote.name).toBe("remote-pc");
    const verified = await post("verify", { id: remote.id });
    expect(verified.status).toBe(200);
    expect(otherHost.unread()).toEqual([]);
    expect(await verified.json()).toMatchObject({ peers: [{ name: "remote-pc/remote-pc" }], roundTripMs: expect.any(Number) });
    const state = await (await fetch(`${base()}/api/network`, { headers: { cookie } })).json();
    expect(state.paired).toMatchObject([{ id: remote.id, connected: true, health: { lastVerifiedAt: expect.any(Number), roundTripMs: expect.any(Number) } }]);
    expect(JSON.stringify(state)).not.toContain(invitation.code);
    expect(await (await post("unlink", { id: remote.id })).json()).toEqual({ removed: true });
    expect((await post("verify", { id: remote.id })).status).toBe(409);
  });

  it("plans the firewall without applying and requires distinct confirmation to apply", async () => {
    await post("configure", { ...config("local-pc"), confirm: true });
    const plan = await post("firewall");
    expect(plan.status).toBe(200);
    expect(await plan.json()).toMatchObject({ plan: { platform: process.platform }, status: { detail: "test policy" } });
    expect(applyWindowsFirewall).not.toHaveBeenCalled();
    expect((await post("firewall", { apply: true })).status).toBe(400);
    expect(applyWindowsFirewall).not.toHaveBeenCalled();
    await post("firewall", { apply: true, confirm: true });
    expect(applyWindowsFirewall).toHaveBeenCalledWith(expect.objectContaining({ platform: process.platform }), true);
  });

  it("does not expose a secret in errors or logs for malformed or unavailable pairing", async () => {
    const secret = "keep-this-secret-out-of-errors";
    const response = await post("link", { address: "pc:48148", code: secret });
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain(secret);
    expect((await post("link", { code: secret })).status).toBe(400);
    expect((await post("verify", {})).status).toBe(400);
    expect((await post("unlink", {})).status).toBe(400);
    expect((await post("unknown")).status).toBe(404);
    const malformed = await fetch(`${base()}/api/network/link`, { method: "POST", headers: headers(), body: `{"code":"${secret}",` });
    expect(malformed.status).toBe(409);
    expect(await malformed.text()).not.toContain(secret);
    expect((await post("link", null as unknown as object)).status).toBe(400);
  });
});
