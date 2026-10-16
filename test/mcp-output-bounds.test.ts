import { describe, expect, it } from "vitest";
import { boundMcpText, pageMcpLines, takeMcpEntries } from "../src/mcp/output-bounds.js";
import { registerTools } from "../src/mcp/server.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("MCP listing frame bounds", () => {
  it("keeps a fake listing larger than the MCP frame below the limit and makes every page reachable", () => {
    const entries = Array.from({ length: 2_500 }, (_, index) => `job-${index} ${"x".repeat(90)}`);
    expect(entries.join("\n").length).toBeGreaterThan(200_000);
    const seen: string[] = [];
    for (let offset = 0; offset < entries.length;) {
      const page = pageMcpLines(entries, { offset, limit: 200 });
      expect(page.text.length).toBeLessThan(180_000);
      seen.push(...page.entries);
      offset = page.nextOffset!;
      if (page.nextOffset === null) break;
    }
    expect(seen).toEqual(entries);
    expect(boundMcpText(entries.join("\n")).length).toBeLessThan(180_000);
  });

  it("bounds the actual delegated peers tool and lets callers filter and page siblings", async () => {
    const siblings = Array.from({ length: 2_500 }, (_, i) => ({ name: `codex-job-${String(i).padStart(4, "0")}`,
      title: `Fake listing ${"x".repeat(80)}`, agent: "codex", status: i < 3 ? "running" : "done" }));
    const handlers = new Map<string, (args: any, extra: any) => Promise<any>>();
    registerTools({ registerTool: (name: string, _spec: unknown, fn: any) => handlers.set(name, fn) } as any,
      { agent: "codex", node: undefined, parent: { name: "parent", siblings: { peers: async () => siblings } },
        home: "E:/synthetic-home", cfg: DEFAULT_CONFIG, log: nullLogger, cwd: () => "E:/synthetic-home", channelActive: () => false } as any, []);
    const peers = handlers.get("peers")!;
    const extra = { signal: new AbortController().signal };
    const first = (await peers({}, extra)).content[0].text as string;
    expect(first.length).toBeLessThan(180_000);
    expect(first).toContain("Sibling jobs: 2500 total");
    expect(first).toContain("codex-job-0000");
    const filtered = (await peers({ status: "running", limit: 1, offset: 1 }, extra)).content[0].text as string;
    expect(filtered).toContain("codex-job-0001");
    expect(filtered).not.toContain("codex-job-0000");
    expect(filtered).toContain("next offset: 2");
  });

  it("summarizes a large fake broker peer listing with live peers first", async () => {
    const home = mkdtempSync(join(tmpdir(), "ab-404-peers-"));
    try {
      const peers = Array.from({ length: 2_500 }, (_, i) => ({ id: `id-${i}`, name: `codex-session-${i}`,
        agent: "codex", cwd: home, sessionId: `session-${i}`, startedAt: Date.now(), activity: "idle",
        autoWake: false, version: "0.30.21" }));
      const node = { id: "self", name: "self", isBroker: false, autoWakeEnabled: false, wasReplaced: false,
        setNotificationWaitHandlers: () => {}, peers: async () => peers, health: async () => null,
        refreshPending: async () => {}, projectJobs: async () => [], unread: () => [], brokerLoad: async () => null };
      const handlers = new Map<string, (args: any, extra: any) => Promise<any>>();
      registerTools({ registerTool: (name: string, _spec: unknown, fn: any) => handlers.set(name, fn) } as any,
        { agent: "codex", node, home, cfg: DEFAULT_CONFIG, log: nullLogger, cwd: () => home, channelActive: () => false } as any, []);
      const call = (args: Record<string, unknown>) => handlers.get("peers")!(args, { signal: new AbortController().signal });
      const first = (await call({})).content[0].text as string;
      expect(first.length).toBeLessThan(180_000);
      expect(first).toContain("2500 live peers");
      expect(first).toContain("codex-session-0");
      expect(first).toContain("next offset:");
      const filtered = (await call({ name: "session-2499", limit: 10 })).content[0].text as string;
      expect(filtered).toContain("codex-session-2499");
      expect(filtered).not.toContain("codex-session-0 (");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("does not select an oversized inbox message for acknowledgement", () => {
    const messages = ["x".repeat(200_000), "small"];
    expect(takeMcpEntries(messages, ms => ms.join("\n"))).toEqual({ entries: [], oversizedFirst: true });
    expect(JSON.parse(boundMcpText(JSON.stringify(messages))).truncated).toBe(true);
    expect(boundMcpText(JSON.stringify(["\\".repeat(200_000)])).length).toBeLessThan(180_000);
  });
});
