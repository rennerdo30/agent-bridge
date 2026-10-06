import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
let home: string;
let clients: Client[];
const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");
const call = async (client: Client, name: string, args = {}) => textOf(await client.callTool({ name, arguments: args }));
async function until(fn: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!await fn()) {
    if (Date.now() >= deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function connect(name: string, agent = "other", delivery = "hooks"): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`],
    env: { ...process.env, AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_DELIVERY: delivery, AGENT_BRIDGE_WAKE_ON_DIRECT: "off", AGENT_BRIDGE_AUTO_WAKE: "off", AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_DELEGATE_DEPTH: "0" } as Record<string, string>, stderr: "ignore" });
  const client = new Client({ name: "reload-test", version: "1" });
  clients.push(client);
  await client.connect(transport);
  await call(client, "peers");
  return client;
}
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "bridge-reload-mcp-")); clients = []; });
afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(!existsSync(SERVER))("stdio message wait recovery", () => {
  it("ignores transfer progress in default waits and hooks but exposes it on request", async () => {
    const sender = await connect("sender");
    const listener = await connect("listener");
    const conversation = "files-progress-transfer-id";
    await call(sender, "send", { to: "listener", conversation_id: conversation, message: "files: 19% transferring" });
    expect(await call(listener, "wait_for_message", { timeout_sec: 1 })).not.toContain("files: 19%");
    expect(await call(listener, "hook_event", { event: "PostToolUse" })).not.toContain("files: 19%");
    expect(await call(listener, "peers")).toContain("files: 19%");
    expect(await call(listener, "inbox", { mark_read: false })).toContain("files: 19%");
    expect(await call(listener, "wait_for_message", { conversation_id: conversation, timeout_sec: 1 })).toContain("files: 19%");
    await call(sender, "send", { to: "listener", conversation_id: "transfer-id", message: "files: completed" });
    expect(await call(listener, "wait_for_message", { timeout_sec: 1 })).toContain("files: completed");
  });

  it("offers the saved wait after transport replacement and resumes the original reply filters", async () => {
    const sender = await connect("sender");
    const listener = await connect("listener");
    await until(async () => (await call(sender, "peers")).includes("listener"));
    const sent = await call(listener, "send", { to: "sender", message: "question" });
    const id = /Message (\S+) sent/.exec(sent)![1]!;
    const waiting = call(listener, "wait_for_message", { from: "sender", reply_to: id, timeout_sec: 600 }).catch((err) => String(err));
    const dir = join(home, "message-waits");
    await until(() => existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".json")));
    const saved = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".json"))!), "utf8"));
    await listener.close();
    await waiting;
    const replacement = await connect("listener");
    expect(await call(replacement, "peers")).toContain(saved.id);
    const resumed = call(replacement, "wait_for_message", { resume_id: saved.id, timeout_sec: 5 });
    await call(sender, "send", { to: "listener", message: "answer after reconnect", reply_to: id });
    expect(await resumed).toContain("answer after reconnect");
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
    const tool = (await replacement.listTools()).tools.find((t) => t.name === "wait_for_message")!;
    expect(tool.description).toContain("110 seconds");
    expect(tool.description).toContain("120 seconds");
    expect(tool.description).toContain("/reload-plugins");
  });

  it("returns a consumption receipt through the MCP wait tool", async () => {
    const sender = await connect("sender");
    const recipient = await connect("recipient");
    await call(recipient, "hook_event", { event: "Stop", session_id: "recipient-session" });
    const sent = await call(sender, "send", { to: "recipient", message: "work" });
    const id = /Message (\S+) sent/.exec(sent)![1]!;
    expect(sent).toContain("will be read on its next turn");
    const receipt = call(sender, "wait_for_message", { read_receipt_of: id, timeout_sec: 5 });
    await until(async () => (await call(recipient, "inbox", { mark_read: false })).includes("work"));
    await call(recipient, "inbox");
    expect(await receipt).toContain(`Read receipt for ${id}`);
  });

  it("keeps a notification armed across session exit and returns the reply queued offline", async () => {
    const sender = await connect("sender");
    const listener = await connect("listener");
    await call(listener, "hook_event", { event: "SessionStart", session_id: "notify-session" });
    const sent = await call(listener, "send", { to: "sender", message: "slow question" });
    const id = /Message (\S+) sent/.exec(sent)![1]!;
    const registration = await call(listener, "wait_for_message", { from: "sender", reply_to: id });
    expect(registration).toContain("is armed");
    const resumeId = /Notification wait (\S+) is armed/.exec(registration)![1]!;
    await listener.close();
    await call(sender, "send", { to: "listener", message: "reply while offline", reply_to: id });
    await call(sender, "send", { to: "listener", message: "unrelated mail" });
    const replacement = await connect("listener");
    expect(await call(replacement, "peers")).toContain(resumeId);
    await call(replacement, "hook_event", { event: "SessionStart", session_id: "notify-session" });
    expect(await call(replacement, "wait_for_message", { resume_id: resumeId })).toContain("reply while offline");
    const inbox = await call(replacement, "inbox", { mark_read: false });
    expect(inbox).toContain("unrelated mail"); expect(inbox).not.toContain("reply while offline");
    expect(await call(replacement, "peers")).not.toContain(resumeId);
    const tool = (await replacement.listTools()).tools.find((t) => t.name === "wait_for_message")!;
    expect(tool.description).toContain('Default mode="notify"');
    expect(tool.description).not.toContain("repeat with the same filters");
  });

  it("pushes a matching notification through the channel with global and direct wake off", async () => {
    const sender = await connect("sender");
    const listener = await connect("listener", "claude", "channel");
    const pushed: string[] = [];
    listener.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.any() }),
      (notification) => { pushed.push(notification.params.content); });
    await call(listener, "wait_for_message", { from: "sender", conversation_id: "awaited-thread", mode: "notify" });
    // An agent-kind envelope normally cannot use direct wake. Only this subscription permits it.
    await call(sender, "send", { to: "claude", conversation_id: "unrelated-thread", message: "unrelated mail" });
    await call(sender, "send", { to: "claude", conversation_id: "awaited-thread", message: "channel answer" });
    await until(() => pushed.length > 0);
    expect(pushed).toEqual(["channel answer"]);
    await until(async () => !(await call(listener, "peers")).includes("Notification wait"));
    const inbox = await call(listener, "inbox", { mark_read: false });
    expect(inbox).toContain("unrelated mail"); expect(inbox).not.toContain("channel answer");
    // Muted mail already queued before registration is delivered through the channel once,
    // rather than being acknowledged in both the tool result and a channel notification.
    await call(sender, "send", { to: "claude", conversation_id: "queued-thread", message: "queued channel answer" });
    await until(async () => (await call(listener, "inbox", { mark_read: false })).includes("queued channel answer"));
    const registration = await call(listener, "wait_for_message", { from: "sender", conversation_id: "queued-thread", mode: "notify" });
    expect(registration).not.toContain("queued channel answer");
    await until(() => pushed.length === 2);
    expect(pushed).toEqual(["channel answer", "queued channel answer"]);
    await until(async () => !(await call(listener, "inbox", { mark_read: false })).includes("queued channel answer"));
  });
});
