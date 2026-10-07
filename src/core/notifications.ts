import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type NotificationConfig } from "./config.js";
import type { Logger } from "./logger.js";

export type NotificationEvent = keyof NotificationConfig;
export interface NotificationCommand { bin: string; args: string[] }
const TITLE = "agent-bridge";
const TEXT: Record<NotificationEvent, string> = {
  approvals: "A subagent needs approval. Open the agent-bridge dashboard.",
  finish: "A subagent finished. Open the agent-bridge dashboard for its report.",
  fail: "A subagent failed. Open the agent-bridge dashboard for its report.",
};
const NOTIFICATION_TIMEOUT_MS = 5_000;
const EVENT_INTERVAL_MS = 5_000;
const RATE_WINDOW_MS = 60_000;
const MAX_NOTIFICATIONS_PER_WINDOW = 10;
const MAX_RATE_HOMES = 100;
const RATE_STATE_FILE = "notification-rate.json";
const RATE_LOCK_DIR = "notification-rate.lock";
/** Use the installed Windows PowerShell application identity; no module or registry changes needed. */
const WINDOWS_POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/** Only fixed event text reaches the OS: commands, paths, prompts, reports and reasons stay private. */
export function notificationCommands(platform: NodeJS.Platform, event: NotificationEvent): NotificationCommand[] {
  const body = TEXT[event];
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
      "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
      `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${TITLE}</text><text>${body}</text></binding></visual></toast>')`,
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_POWERSHELL_APP_ID}').Show($toast)`,
    ].join("; ");
    return [{ bin: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] }];
  }
  if (platform === "darwin") return [
    { bin: "terminal-notifier", args: ["-title", TITLE, "-message", body] },
    { bin: "osascript", args: ["-e", `display notification "${body}" with title "${TITLE}"`] },
  ];
  if (platform === "linux") return [{ bin: "notify-send", args: ["--app-name", TITLE, "--", TITLE, body] }];
  return [];
}

/** Bound both bursts and duplicate events; callers never wait for desktop helpers. */
export class NotificationLimiter {
  private readonly homes = new Map<string, { times: number[]; events: Partial<Record<NotificationEvent, number>> }>();

  take(home: string, event: NotificationEvent, now = Date.now()): boolean {
    let state = this.homes.get(home);
    if (!state) {
      if (this.homes.size >= MAX_RATE_HOMES) this.homes.delete(this.homes.keys().next().value!);
      state = { times: [], events: {} };
      this.homes.set(home, state);
    }
    state.times = state.times.filter((at) => now - at < RATE_WINDOW_MS);
    const last = state.events[event];
    if ((last !== undefined && now - last < EVENT_INTERVAL_MS) || state.times.length >= MAX_NOTIFICATIONS_PER_WINDOW) return false;
    state.times.push(now);
    state.events[event] = now;
    return true;
  }
}

const limiter = new NotificationLimiter();

/** Detached runners share the same home: a burst is bounded across those processes as well. */
export function takeNotificationSlot(home: string, event: NotificationEvent, now = Date.now()): boolean {
  const lock = join(home, RATE_LOCK_DIR);
  try {
    try { mkdirSync(lock); } catch {
      if (now - statSync(lock).mtimeMs < NOTIFICATION_TIMEOUT_MS) return false;
      rmdirSync(lock);
      mkdirSync(lock);
    }
  } catch { return false; }
  try {
    const file = join(home, RATE_STATE_FILE);
    let state: { times: number[]; events: Partial<Record<NotificationEvent, number>> } = { times: [], events: {} };
    try {
      const stored = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(stored.times) && stored.times.every((at: unknown) => typeof at === "number") && stored.events && typeof stored.events === "object") state = stored;
    } catch { /* A new or unreadable state starts a fresh rate window. */ }
    state.times = state.times.filter((at) => now - at < RATE_WINDOW_MS);
    const last = state.events[event];
    if ((typeof last === "number" && now - last < EVENT_INTERVAL_MS) || state.times.length >= MAX_NOTIFICATIONS_PER_WINDOW) return false;
    state.times.push(now);
    state.events[event] = now;
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    return true;
  } catch { return false; }
  finally { try { rmdirSync(lock); } catch { /* Best effort; stale locks expire. */ } }
}

function launch(commands: NotificationCommand[], log: Logger): void {
  const command = commands[0];
  if (!command) return;
  try {
    const child = spawn(command.bin, command.args, { stdio: "ignore", windowsHide: true, detached: true });
    const timer = setTimeout(() => child.kill(), NOTIFICATION_TIMEOUT_MS);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
    child.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT" && commands.length > 1) launch(commands.slice(1), log);
      else log.debug("desktop notification unavailable");
    });
    child.unref();
  } catch { log.debug("desktop notification unavailable"); }
}

/** Question toasts use the same native helpers as approvals. Only a validated local link is exposed. */
export function questionNotificationCommands(platform: NodeJS.Platform, dashboardUrl: string): NotificationCommand[] {
  const url = new URL(dashboardUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || [...url.searchParams.keys()].join(",") !== "t" || !/^#\/approvals\?question=[0-9a-f-]{36}$/.test(url.hash) || !/^[0-9a-f]{48}$/.test(url.searchParams.get("t") ?? "")) throw new Error("Invalid question dashboard link");
  const body = "A question needs your answer. Click to answer in agent-bridge.";
  if (platform === "win32") {
    const xmlUrl = dashboardUrl.replaceAll("&", "&amp;");
    const command = notificationCommands(platform, "approvals")[0]!;
    const script = Buffer.from(command.args.at(-1)!, "base64").toString("utf16le")
      .replace("<toast>", `<toast activationType="protocol" launch="${xmlUrl}">`)
      .replace(TEXT.approvals, body);
    return [{ ...command, args: [...command.args.slice(0,-1), Buffer.from(script,"utf16le").toString("base64")] }];
  }
  if (platform === "darwin") return [
    { bin: "terminal-notifier", args: ["-title", TITLE, "-message", body, "-open", dashboardUrl] },
    { bin: "osascript", args: ["-e", `display notification "${body}" with title "${TITLE}"`] },
  ];
  if (platform === "linux") return [{ bin: "notify-send", args: ["--app-name", TITLE, "--expire-time=15000", "--action=answer=Answer", "--wait", "--", TITLE, body] }];
  return [];
}

export function notifyOwnerQuestion(url: string, log: Logger): void {
  // The registry claims one channel per question; do not apply the job-event limiter to questions.
  if (process.platform !== "linux") { launch(questionNotificationCommands(process.platform, url), log); return; }
  const command = questionNotificationCommands("linux", url)[0]!;
  const child = spawn(command.bin, command.args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const timer=setTimeout(() => child.kill(),20000); timer.unref();
  let action = ""; child.stdout.on("data", data => { action = (action + String(data)).slice(0,100); });
  child.once("exit", () => { clearTimeout(timer); if (action.trim() === "answer") { const opener = spawn("xdg-open", [url], { stdio: "ignore", detached: true }); opener.on("error", () => log.debug("question link opener unavailable")); opener.unref(); } });
  child.once("error", () => { clearTimeout(timer); log.debug("desktop notification unavailable"); }); child.unref();
}

export function notifyJobEvent(home: string, event: NotificationEvent, log: Logger): void {
  // Schedule all work outside the permission/result path. Configuration errors cannot block a job.
  const task = setImmediate(() => {
    try {
      if (!loadConfig(home, "other", log).notifications[event] || !limiter.take(home, event) || !takeNotificationSlot(home, event)) return;
      launch(notificationCommands(process.platform, event), log);
    } catch { log.debug("desktop notification unavailable"); }
  });
  task.unref();
}
