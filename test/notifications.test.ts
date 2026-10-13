import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { notificationCommands, NotificationLimiter, notifyJobEvent, takeNotificationSlot } from "../src/core/notifications.js";

// Exercise asynchronous launch with fake child processes; no OS notification helper is executed.
vi.unmock("../src/core/notifications.js");
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));

let home: string;
beforeEach(() => { vi.clearAllMocks(); home = mkdtempSync(join(tmpdir(), "agent-bridge-notifications-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("desktop notification commands (never executed)", () => {
  it("uses built-in Windows toasts in a hidden PowerShell without external modules", () => {
    const [command] = notificationCommands("win32", "approvals");
    expect(command!.bin).toBe("powershell.exe");
    expect(command!.args).toContain("Hidden");
    const script = Buffer.from(command!.args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("Windows.UI.Notifications.ToastNotificationManager");
    expect(script).toContain("CreateToastNotifier");
    expect(script).toContain("ToastGeneric");
    expect(script).not.toMatch(/BurntToast|Import-Module|Set-ItemProperty/);
  });

  it("prefers terminal-notifier on macOS with built-in osascript as fallback", () => {
    const commands = notificationCommands("darwin", "finish");
    expect(commands.map((c) => c.bin)).toEqual(["terminal-notifier", "osascript"]);
    expect(commands[1]!.args.join(" ")).toContain("display notification");
  });

  it("uses notify-send on Linux and no commands on unsupported systems", () => {
    expect(notificationCommands("linux", "fail")[0]).toMatchObject({ bin: "notify-send" });
    expect(notificationCommands("aix", "approvals")).toEqual([]);
  });

  it("contains fixed event text only, with no caller-supplied job data", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      for (const event of ["approvals", "finish", "fail"] as const) {
        expect(notificationCommands(platform, event)).toEqual(notificationCommands(platform, event));
        const text = JSON.stringify(notificationCommands(platform, event));
        expect(text).not.toMatch(/AGENT_BRIDGE_RELAY_TOKEN|Authorization|cwd|command|reason/);
      }
    }
  });
});

describe("notification config and rate limits", () => {
  it("enables all events by default and supports partial per-event settings", () => {
    expect(loadConfig(home, "other", nullLogger, {}).notifications).toEqual({ approvals: true, finish: true, fail: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ notifications: { finish: false, approvals: "off" } }));
    expect(loadConfig(home, "other", nullLogger, {}).notifications).toEqual({ approvals: false, finish: false, fail: true });
  });

  it("rejects invalid settings without disabling safe defaults", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ notifications: { approvals: 42 } }));
    expect(loadConfig(home, "other", nullLogger, {}).notifications.approvals).toBe(true);
  });

  it("bounds per-event duplicates and bursts while allowing independent homes", () => {
    const limiter = new NotificationLimiter();
    expect(limiter.take(home, "approvals", 0)).toBe(true);
    expect(limiter.take(home, "approvals", 1)).toBe(false);
    expect(limiter.take(home, "finish", 1)).toBe(true);
    expect(limiter.take("another-home", "approvals", 1)).toBe(true);
    for (let i = 1; i <= 8; i++) expect(limiter.take(home, "approvals", i * 5_000)).toBe(true);
    expect(limiter.take(home, "fail", 40_001)).toBe(false);
    expect(limiter.take(home, "fail", 60_001)).toBe(true);
  });

  it("shares the rate window across detached runner instances", () => {
    expect(takeNotificationSlot(home, "approvals", 0)).toBe(true);
    expect(takeNotificationSlot(home, "approvals", 1)).toBe(false);
    expect(takeNotificationSlot(home, "finish", 1)).toBe(true);
    expect(takeNotificationSlot(home, "approvals", 5_000)).toBe(true);
    expect(takeNotificationSlot(home, "approvals", 60_001)).toBe(true);
  });

  it("returns before launching a hidden helper and never waits for it", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    expect(notifyJobEvent(home, "approvals", nullLogger)).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), { stdio: "ignore", windowsHide: true, detached: true });
    expect(child.unref).toHaveBeenCalledOnce();
    child.emit("exit", 0);
  });

  it("respects disabled events and contains launch failures", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ notifications: { approvals: false } }));
    notifyJobEvent(home, "approvals", nullLogger);
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).not.toHaveBeenCalled();
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error("no desktop"); });
    expect(notifyJobEvent(home, "finish", nullLogger)).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledOnce();
  });
});
