import { EventEmitter } from "node:events";
import { createSocket, type Socket } from "node:dgram";
import type { NetworkInterfaceInfo } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCOVERY_GROUP, DISCOVERY_MULTICAST_TTL, DISCOVERY_PORT, NETWORK_VERSION } from "../src/network/constants.js";
import { discoveryInterfaces, NetworkDiscovery } from "../src/network/discovery.js";
import { readNetworkProfiles } from "../src/network/profiles.js";

const LOCAL = { id: "83cff368-8060-4db2-a8b2-503daf003cf9", name: "desktop", fingerprint: "a".repeat(64) };
const REMOTE = { id: "4c1f8730-8ef9-41a4-b5cd-a6ec46c105cf", name: "mac", fingerprint: "b".repeat(64) };
const LOOPBACK = "127.0.0.1";
const entry = (address: string, netmask = "255.255.255.0", internal = false): NetworkInterfaceInfo => ({
  address, netmask, family: "IPv4", internal, mac: "00:00:00:00:00:00", cidr: null,
});
const simulatedInterfaces = () => ({
  Ethernet: [entry("192.168.1.235")], WiFi: [entry("10.20.30.40", "255.255.0.0")],
  "vEthernet (WSL (Hyper-V firewall))": [entry("172.28.96.1", "255.255.240.0")],
  "vEthernet (Default Switch)": [entry("172.24.224.1", "255.255.240.0")],
  lo: [entry(LOOPBACK, "255.0.0.0", true)], disconnected: [entry("169.254.23.142")],
});
class FakeSocket extends EventEmitter {
  host = ""; boundPort = 0;
  failMembership = false;
  sendError: Error | null = null;
  bind = vi.fn((port: number, host: string, cb: () => void) => { this.host = host; this.boundPort = port || 49001; cb(); });
  address = () => ({ address: this.host, port: this.boundPort, family: "IPv4" });
  setBroadcast = vi.fn();
  setMulticastTTL = vi.fn();
  setMulticastInterface = vi.fn();
  addMembership = vi.fn(() => { if (this.failMembership) throw new Error("membership denied"); });
  dropMembership = vi.fn();
  send = vi.fn((_data: Buffer, _port: number, _host: string, cb: (err: Error | null) => void) => cb(this.sendError));
  close = vi.fn((cb: () => void) => cb());
}
const running: NetworkDiscovery[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((item) => item.close())); vi.restoreAllMocks(); });
function simulated(interfaces = simulatedInterfaces) {
  const sockets: FakeSocket[] = [];
  let now = 100;
  const discovery = new NetworkDiscovery({
    identity: LOCAL, port: 48148, interfaces, now: () => now,
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as Socket; },
  });
  running.push(discovery);
  return { discovery, sockets, setNow: (time: number) => { now = time; } };
}

describe("discovery interface routing", () => {
  it("computes directed broadcasts and skips virtual, disconnected, loopback and invalid subnets", () => {
    const selected = discoveryInterfaces({
      ...simulatedInterfaces(), invalid: [entry("192.0.2.5", "255.0.255.0")],
      pointToPoint: [entry("192.0.2.7", "255.255.255.254")],
      duplicate: [entry("192.168.1.235")],
    });
    expect(selected.interfaces).toEqual([
      { name: "Ethernet", address: "192.168.1.235", netmask: "255.255.255.0", broadcast: "192.168.1.255" },
      { name: "WiFi", address: "10.20.30.40", netmask: "255.255.0.0", broadcast: "10.20.255.255" },
    ]);
    expect(selected.skippedInterfaces).toHaveLength(6);
  });

  it("binds the listener to all addresses and announces broadcast and multicast on each LAN", async () => {
    const { discovery, sockets } = simulated();
    await discovery.start();
    expect(sockets[0]!.bind).toHaveBeenCalledWith(DISCOVERY_PORT, "0.0.0.0", expect.any(Function));
    expect(sockets[0]!.addMembership.mock.calls).toEqual([[DISCOVERY_GROUP, "192.168.1.235"], [DISCOVERY_GROUP, "10.20.30.40"]]);
    for (const [index, address, broadcast] of [[1, "192.168.1.235", "192.168.1.255"], [2, "10.20.30.40", "10.20.255.255"]] as const) {
      const socket = sockets[index]!;
      expect(socket.bind).toHaveBeenCalledWith(0, address, expect.any(Function));
      expect(socket.setBroadcast).toHaveBeenCalledWith(true);
      expect(socket.setMulticastTTL).toHaveBeenCalledWith(DISCOVERY_MULTICAST_TTL);
      expect(socket.setMulticastInterface).toHaveBeenCalledWith(address);
      expect(socket.send.mock.calls.map((call) => call[2])).toEqual([broadcast, DISCOVERY_GROUP]);
    }
    expect(discovery.diagnostics()).toMatchObject({ lastSentAt: 100, lastReceivedAt: null, lastError: null });
    expect(discovery.diagnostics().interfaces.every((item) => item.announcing && item.multicast && item.lastSentAt === 100)).toBe(true);
    await discovery.close();
    expect(sockets.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
  });

  it("refreshes changed interfaces and never announces through a removed adapter", async () => {
    let interfaces = simulatedInterfaces();
    const { discovery, sockets } = simulated(() => interfaces);
    await discovery.start();
    interfaces = { ...interfaces, Ethernet: [entry("192.168.2.235")] };
    await discovery.announce();
    expect(sockets[0]!.dropMembership).toHaveBeenCalledWith(DISCOVERY_GROUP, "192.168.1.235");
    expect(sockets[1]!.close).toHaveBeenCalledOnce();
    expect(sockets[1]!.send).toHaveBeenCalledTimes(2);
    expect(discovery.diagnostics().interfaces.map((item) => item.broadcast)).toEqual(["10.20.255.255", "192.168.2.255"]);
  });

  it("retains broadcast fallback and diagnostics when multicast membership fails", async () => {
    const { discovery, sockets } = simulated();
    // Create the listener before refresh, then force its membership call to fail.
    const starting = discovery.start();
    sockets[0]!.failMembership = true;
    await starting;
    expect(sockets[1]!.send.mock.calls.map((call) => call[2])).toEqual(["192.168.1.255"]);
    expect(discovery.diagnostics()).toMatchObject({ lastSentAt: 100, lastError: { at: 100, message: expect.stringContaining("membership denied") } });
    expect(discovery.diagnostics().interfaces.every((item) => !item.multicast)).toBe(true);
  });

  it("records send errors and counts only valid remote announcements as received", async () => {
    const { discovery, sockets, setNow } = simulated();
    await discovery.start();
    setNow(200);
    sockets[1]!.sendError = new Error("blocked");
    await discovery.announce();
    expect(discovery.diagnostics().lastError).toMatchObject({ at: 200, message: expect.stringContaining("blocked") });
    discovery.observe(Buffer.from("{"), LOOPBACK);
    discovery.observe(Buffer.from(JSON.stringify({ service: "agent-bridge", v: NETWORK_VERSION, ...LOCAL, port: 48148 })), LOOPBACK);
    expect(discovery.diagnostics().lastReceivedAt).toBeNull();
    discovery.observe(Buffer.from(JSON.stringify({ service: "agent-bridge", v: NETWORK_VERSION, ...REMOTE, port: 48148 })), "192.168.1.2");
    expect(discovery.diagnostics().lastReceivedAt).toBe(200);
    const snapshot = discovery.diagnostics(); snapshot.interfaces[0]!.name = "mutated";
    expect(discovery.diagnostics().interfaces[0]!.name).toBe("Ethernet");
  });

  it("exchanges real loopback datagrams and reports send and receive timestamps", async () => {
    const left = new NetworkDiscovery({ identity: LOCAL, port: 48148, bind: LOOPBACK, udpPort: 0, destination: LOOPBACK });
    const right = new NetworkDiscovery({ identity: REMOTE, port: 48148, bind: LOOPBACK, udpPort: 0, destination: LOOPBACK });
    running.push(left, right);
    await left.start(); await right.start();
    await left.announce(right.port); await right.announce(left.port);
    await vi.waitFor(() => { expect(left.instances()).toHaveLength(1); expect(right.instances()).toHaveLength(1); });
    expect(left.diagnostics()).toMatchObject({ lastSentAt: expect.any(Number), lastReceivedAt: expect.any(Number), lastError: null });
  });

  it("closes its listener after a bind error", async () => {
    const occupied = createSocket("udp4");
    await new Promise<void>((resolve) => occupied.bind(0, LOOPBACK, resolve));
    const discovery = new NetworkDiscovery({ identity: LOCAL, port: 48148, bind: LOOPBACK, udpPort: occupied.address().port, destination: LOOPBACK });
    running.push(discovery);
    try {
      await expect(discovery.start()).rejects.toThrow();
      expect(discovery.diagnostics().port).toBe(0);
      expect(discovery.diagnostics().lastError).not.toBeNull();
    } finally { await new Promise<void>((resolve) => occupied.close(resolve)); }
  });
});

describe("read-only Windows profile hints", () => {
  it("explains why Private firewall rules do not apply to Public interfaces", async () => {
    const run = vi.fn(async () => JSON.stringify([{ interfaceAlias: "WiFi", interfaceIndex: 10, category: "Public" }]));
    expect(await readNetworkProfiles("win32", run)).toMatchObject({
      networkProfiles: [{ interfaceAlias: "WiFi", interfaceIndex: 10, category: "Public" }],
      networkProfileHint: expect.stringContaining("Private firewall rules do not apply"),
    });
    expect(run.mock.calls).toHaveLength(1);
    const args = (run.mock.calls[0] as unknown as [string, string[]])[1].join(" ");
    expect(args).toContain("Get-NetConnectionProfile");
    expect(args).not.toMatch(/Set-|New-|Remove-/);
  });

  it("does not claim Public blocking for Private profiles and handles unavailable queries", async () => {
    expect(await readNetworkProfiles("win32", async () => JSON.stringify([{ interfaceAlias: "Ethernet", interfaceIndex: 10, category: "Private" }]))).toMatchObject({ networkProfileHint: null });
    expect(await readNetworkProfiles("win32", async () => { throw new Error("denied"); })).toMatchObject({ networkProfileHint: expect.stringContaining("could not be checked") });
    const run = vi.fn();
    expect(await readNetworkProfiles("darwin", run)).toEqual({ networkProfiles: [], networkProfileHint: null });
    expect(run).not.toHaveBeenCalled();
  });
});
