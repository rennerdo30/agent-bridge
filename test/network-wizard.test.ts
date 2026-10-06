import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../src/core/client.js";
import { DEFAULT_NETWORK_CONFIG, writeNetworkConfig } from "../src/network/config.js";
import { applyWindowsFirewall, detectFirewall, planFirewall } from "../src/network/firewall.js";
import { PAIRING_TTL_MS } from "../src/network/constants.js";
import type { NetworkStatus } from "../src/network/link.js";
import { parseConnectOptions, runConnectWizard, type WizardDependencies, type WizardStep } from "../src/network/wizard.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const temporaryHome = () => { const home = mkdtempSync(join(tmpdir(), "bridge-wizard-")); homes.push(home); return home; };
const enabled = { ...DEFAULT_NETWORK_CONFIG, enabled: true, name: "local-pc", bind: "0.0.0.0", discovery: true };
const remote = { id: "83cff368-8060-4db2-a8b2-503daf003cf9", name: "remote-pc", fingerprint: "a".repeat(64), connected: true };

function wizard(initial: NetworkStatus = { enabled: true, config: enabled, paired: [], discovered: [] }) {
  let now = 0, status = initial;
  const steps: WizardStep[] = [];
  const calls: { op: string; args: unknown }[] = [];
  const request = vi.fn(async (op: string, args: unknown) => {
    calls.push({ op, args });
    if (op === "networkStatus") return status;
    if (op === "networkConfigure") { status = { ...status, enabled: true, config: args as typeof enabled, port: enabled.port }; return status; }
    if (op === "networkLink") { status = { ...status, paired: [remote] }; return remote; }
    if (op === "networkPair") return { code: "secret-code", expiresAt: now + PAIRING_TTL_MS };
    if (op === "networkVerify") return { roundTripMs: 2, peers: [{ name: "remote-pc/claude-app", agent: "claude" }] };
    throw new Error("unexpected request");
  });
  const deps: WizardDependencies = {
    request: request as BridgeClient["request"], config: DEFAULT_NETWORK_CONFIG, platform: "win32",
    prompt: vi.fn(async (_label, fallback) => fallback || ""), confirm: vi.fn(async () => false),
    out: vi.fn(), step: (step) => steps.push(step), firewallStatus: vi.fn(async () => ({ state: "unknown" as const, detail: "unconfirmed" })),
    applyFirewall: vi.fn(), clipboard: vi.fn(async () => true), now: () => now,
    sleep: vi.fn(async (ms) => { now += ms; status = { ...status, paired: [remote] }; }),
  };
  return { deps, steps, calls, request, setStatus: (next: NetworkStatus) => { status = next; }, setNow: (time: number) => { now = time; } };
}

describe("safe network configuration", () => {
  it("preserves other settings, agent sections and unknown nested network keys with a legacy backup", () => {
    const home = temporaryHome(), file = join(home, "config.json");
    const old = { maxJobs: 9, codex: { model: "custom" }, future: { nested: true }, network: { enabled: false, futureOption: "keep" } };
    writeFileSync(file, JSON.stringify(old));
    writeNetworkConfig(home, enabled);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ ...old, version: 1, network: { ...enabled, futureOption: "keep" } });
    expect(readdirSync(home).filter((f) => f.startsWith("config.json.backup-"))).toHaveLength(1);
    writeNetworkConfig(home, { ...enabled, enabled: false });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ maxJobs: 9, codex: old.codex, network: { enabled: false, futureOption: "keep" } });
  });

  it("refuses invalid and newer-version writes without overwriting the file", () => {
    const home = temporaryHome(), file = join(home, "config.json");
    const original = '{"version":99,"maxJobs":7}';
    writeFileSync(file, original);
    expect(() => writeNetworkConfig(home, enabled)).toThrow(/unsupported/);
    expect(() => writeNetworkConfig(home, { ...enabled, port: -1 })).toThrow();
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("archives corrupt input before writing a fresh versioned config", () => {
    const home = temporaryHome();
    writeFileSync(join(home, "config.json"), "{invalid");
    writeNetworkConfig(home, enabled);
    const preserved = readdirSync(home).find((f) => f.startsWith("config.json.corrupt-"))!;
    expect(readFileSync(join(home, preserved), "utf8")).toBe("{invalid");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toMatchObject({ version: 1, network: enabled });
  });
});

describe("firewall planning without executing OS changes", () => {
  it("plans Private/LAN Windows TCP and optional discovery UDP rules and rejects injected ports", () => {
    expect(planFirewall("win32", 49000, true).commands).toEqual([
      'netsh advfirewall firewall add rule name="agent-bridge TCP 49000" dir=in action=allow protocol=TCP localport=49000 profile=private remoteip=LocalSubnet',
      'netsh advfirewall firewall add rule name="agent-bridge UDP 48149" dir=in action=allow protocol=UDP localport=48149 profile=private remoteip=LocalSubnet',
    ]);
    expect(planFirewall("win32", 49000, false).commands).toHaveLength(1);
    for (const port of [0, -1, 65536, NaN]) expect(() => planFirewall("win32", port, true)).toThrow();
  });

  it("gives macOS application commands and Linux subnet guidance", () => {
    expect(planFirewall("darwin", 48148, true).commands.join("\n")).toContain("socketfilterfw --unblockapp");
    expect(planFirewall("darwin", 48148, true).explanation).toContain("UDP 48149");
    expect(planFirewall("linux", 49000, true).commands).toContain("sudo ufw allow from 192.168.1.0/24 to any port 49000 proto tcp");
    expect(planFirewall("linux", 49000, false).commands).toHaveLength(1);
  });

  it("checks exact Windows rules conservatively and reports unknown for unavailable policy", async () => {
    const plan = planFirewall("win32", 48148, true);
    const run = vi.fn(async () => JSON.stringify([
      { name: "agent-bridge TCP 48148", port: "48148", protocol: "TCP", remote: "LocalSubnet" },
      { name: "agent-bridge UDP 48149", port: "48149", protocol: "UDP", remote: "LocalSubnet" },
    ]));
    expect((await detectFirewall(plan, run)).state).toBe("allowed");
    expect(run.mock.calls).toHaveLength(1);
    expect((await detectFirewall(plan, async () => "[]")).state).toBe("unknown");
    expect((await detectFirewall(plan, async () => { throw new Error("denied"); })).state).toBe("unknown");
    const linuxRunner = vi.fn();
    expect((await detectFirewall(planFirewall("linux", 48148, true), linuxRunner)).state).toBe("unknown");
    expect(linuxRunner).not.toHaveBeenCalled();
  });

  it("requires separate explicit confirmation and plans UAC invocation with an injected runner", async () => {
    const run = vi.fn(async () => "");
    await expect(applyWindowsFirewall(planFirewall("win32", 48148, true), false, run)).rejects.toThrow(/confirmation/);
    await expect(applyWindowsFirewall(planFirewall("linux", 48148, true), true, run)).rejects.toThrow(/confirmation/);
    expect(run).not.toHaveBeenCalled();
    await applyWindowsFirewall(planFirewall("win32", 48148, true), true, run);
    const invocation = run.mock.calls[0] as unknown as [string, string[]];
    expect(invocation[1].join(" ")).toContain("-Verb RunAs -WindowStyle Hidden");
    const encoded = /EncodedCommand ([A-Za-z0-9+/=]+)/.exec(invocation[1].join(" "))![1]!;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain("localport=48149");
  });
});

describe("injected connect wizard", () => {
  it("enables and reloads safely, connects manually and verifies the remote peer list", async () => {
    const w = wizard({ enabled: false, config: DEFAULT_NETWORK_CONFIG, paired: [], discovered: [] });
    expect(await runConnectWizard(parseConnectOptions(["--non-interactive", "--yes", "--address", "192.168.1.20:48148", "--code", "private"]), w.deps)).toBe(0);
    expect(w.steps).toEqual(["enable", "firewall", "reload", "choose", "pair", "verify", "done"]);
    expect(w.calls.find((c) => c.op === "networkConfigure")?.args).toMatchObject({ enabled: true, bind: "0.0.0.0", discovery: true });
    expect(w.calls.find((c) => c.op === "networkLink")?.args).toEqual({ host: "192.168.1.20", port: 48148, code: "private" });
    expect(w.deps.confirm).not.toHaveBeenCalled();
    expect(w.deps.applyFirewall).not.toHaveBeenCalled();
    expect(w.deps.out).toHaveBeenCalledWith("Remote peer: remote-pc/claude-app (claude)");
  });

  it("cancels before saving and never treats --yes as firewall permission", async () => {
    const w = wizard({ enabled: false, paired: [], discovered: [] });
    expect(await runConnectWizard(parseConnectOptions([]), w.deps)).toBe(1);
    expect(w.calls.map((c) => c.op)).toEqual(["networkStatus"]);
    const next = wizard();
    await runConnectWizard(parseConnectOptions(["--yes", "--address", "pc:48148", "--code", "private"]), next.deps);
    expect(next.deps.confirm).toHaveBeenCalledWith(expect.stringContaining("UAC"));
    expect(next.deps.applyFirewall).not.toHaveBeenCalled();
  });

  it("copies a created code, counts down and finishes only for a newly connected PC", async () => {
    const w = wizard({ enabled: true, config: enabled, paired: [{ ...remote, id: "existing" }], discovered: [] });
    expect(await runConnectWizard(parseConnectOptions(["--non-interactive", "--create"]), w.deps)).toBe(0);
    expect(w.deps.clipboard).toHaveBeenCalledWith("secret-code");
    expect(w.deps.out).toHaveBeenCalledWith(expect.stringContaining("10:00 remaining"));
    expect(w.deps.sleep).toHaveBeenCalled();
    expect(w.calls.find((c) => c.op === "networkVerify")?.args).toEqual({ id: remote.id });
  });

  it("expires cleanly without verifying, with a clipboard fallback", async () => {
    const w = wizard();
    w.deps.clipboard = vi.fn(async () => false);
    w.deps.sleep = async () => { w.setNow(PAIRING_TTL_MS); };
    expect(await runConnectWizard(parseConnectOptions(["--non-interactive", "--create"]), w.deps)).toBe(1);
    expect(w.deps.out).toHaveBeenCalledWith(expect.stringContaining("Clipboard unavailable"));
    expect(w.calls.some((c) => c.op === "networkVerify")).toBe(false);
  });

  it("selects a discovered instance and requests the secret without echo", async () => {
    const w = wizard({ enabled: true, config: enabled, paired: [], discovered: [{ ...remote, host: "192.168.1.2", port: 49000, seenAt: 0 }] });
    w.deps.prompt = vi.fn(async (label) => label.startsWith("Create") ? "connect" : label.startsWith("Discovered") ? "1" : "secret");
    await runConnectWizard(parseConnectOptions([]), w.deps);
    expect(w.deps.prompt).toHaveBeenCalledWith("Secret code from the other PC", "", true);
    expect(w.calls.find((c) => c.op === "networkLink")?.args).toMatchObject({ host: "192.168.1.2", port: 49000 });
    expect(w.deps.out).not.toHaveBeenCalledWith("secret");
  });

  it("cancels a pending invitation wait through an injected signal", async () => {
    const w = wizard(), cancellation = new AbortController();
    w.deps.signal = cancellation.signal;
    w.deps.sleep = async () => { cancellation.abort(); };
    await expect(runConnectWizard(parseConnectOptions(["--non-interactive", "--create"]), w.deps)).rejects.toThrow();
    expect(w.calls.some((c) => c.op === "networkVerify")).toBe(false);
  });

  it("rejects ambiguous or unsafe unattended flags", () => {
    for (const args of [["--non-interactive"], ["--non-interactive", "--create", "--firewall"], ["--create", "--address", "pc:48148"], ["--port"], ["--bogus"]]) expect(() => parseConnectOptions(args)).toThrow();
  });
});
