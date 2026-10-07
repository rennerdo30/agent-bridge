import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { CODING_AGENTS, type BridgeMessage, type PeerInfo } from "../src/core/protocol.js";
import { formatDelivery, formatPeer } from "../src/mcp/format.js";
import { registerTools } from "../src/mcp/server.js";
import { makeEnv, type TestEnv } from "./helpers.js";
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });
const mail = (recipient: string, quiet: boolean): BridgeMessage => ({ id: randomUUID(), from: { id: "job:finished", name: "finished-job", agent: "codex" }, to: recipient, recipient, body: quiet ? "OLD_QUIET_COPY" : "ACTIONABLE_MAIL", conversationId: quiet ? "siblings-finished:note" : "work", replyTo: null, hop: 0, createdAt: Date.now() - (quiet ? 7 * 3600000 : 0), readAt: null });
it.each(CODING_AGENTS)("%s default inbox hides historical quiet copies without consuming them", async agent => {
  const node = env.node("receiver", agent); await node.start();
  node.deliverLocal(mail(node.name, true)); node.deliverLocal(mail(node.name, false));
  const callbacks = new Map<string, any>();
  registerTools({ registerTool: (name: string, _config: unknown, cb: any) => callbacks.set(name, cb) } as any,
    { agent, cfg: DEFAULT_CONFIG, node, log: nullLogger, home: env.home, cwd: () => env.home, channelActive: () => false }, []);
  const response = await callbacks.get("inbox")({}, {});
  expect(response.content[0].text).toContain("ACTIONABLE_MAIL");
  expect(response.content[0].text).not.toContain("OLD_QUIET_COPY");
  expect(node.unread()).toHaveLength(1);
  const filteredPeek = await callbacks.get("inbox")({ mark_read: false, include_quiet: false }, {});
  expect(filteredPeek.content[0].text).not.toContain("OLD_QUIET_COPY");
  const peek = await callbacks.get("inbox")({ mark_read: false, include_quiet: true }, {});
  expect(peek.content[0].text).toContain("0 actionable message(s), 1 retained quiet");
  expect(peek.content[0].text).toContain("7h 0m old");
  expect(peek.content[0].text).not.toContain("new message(s)");
  expect(node.unread()).toHaveLength(1);
});
it("delivery describes activity, wake policy and consumption path consistently", () => {
  const message = mail("receiver", false);
  for (const activity of ["busy", "idle", null] as const) for (const enabled of [true, false]) {
    const text = formatDelivery({ messages: [message], deliveredTo: ["receiver"], queuedFor: [], recipientStates: [{ name: "receiver", activity, autoWake: false, wakeOnDirect: enabled, wakeAvailable: true }] }).join("\n");
    expect(text).toContain(activity ?? "activity unknown");
    expect(text).toContain(enabled ? activity === "idle" ? "wake requested" : "wake policy enabled" : "no wake for this delivery");
    expect(text).toContain("Delivery does not mean read");
    expect(text).not.toContain("waiting for the peer to consume");
  }
  expect(formatPeer({ name: "unknown", agent: "codex", startedAt: Date.now(), cwd: "/fixture" } as PeerInfo)).toContain("activity unknown (no busy/idle report)");
});
