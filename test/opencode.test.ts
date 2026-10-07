import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { installOpencode, uninstallOpencode } from "../src/cli/opencode-install.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { parseOpencodeJsonl, unwrapNpmShim } from "../src/core/delegate.js";
import { watchServeOutput } from "../src/core/opencode-served.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { jsonSchemaToZodShape } from "../src/opencode/schema.js";

const REPO = join(import.meta.dirname, "..");
const SERVER = join(REPO, "plugins", "opencode", "dist", "server.mjs");

describe("parseOpencodeJsonl", () => {
  it("returns the session id and the text of the last message", () => {
    const out = [
      '{"type":"step_start","sessionID":"ses_1","part":{"messageID":"m1"}}',
      '{"type":"text","sessionID":"ses_1","part":{"messageID":"m1","type":"text","text":"thinking out loud"}}',
      '{"type":"tool_use","sessionID":"ses_1","part":{"messageID":"m1"}}',
      '{"type":"text","sessionID":"ses_1","part":{"messageID":"m2","type":"text","text":"4"}}',
      '{"type":"text","sessionID":"ses_1","part":{"messageID":"m2","type":"text","text":"2"}}',
      '{"type":"step_finish","sessionID":"ses_1","part":{"messageID":"m2"}}',
    ].join("\n");
    expect(parseOpencodeJsonl(out)).toEqual({ sessionId: "ses_1", text: "42", error: null });
  });
  it("reports errors", () => {
    expect(parseOpencodeJsonl('{"type":"error","sessionID":"s","error":{"data":{"message":"no provider"}}}').error).toBe("no provider");
  });
});

describe("unwrapNpmShim", () => {
  it("finds the native exe behind an npm .cmd shim", () => {
    const shim = '@ECHO off\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n';
    const r = unwrapNpmShim("C:\\npm\\opencode.cmd", () => shim);
    expect(r?.command.replace(/\\/g, "/")).toMatch(/npm\/node_modules\/opencode-ai\/bin\/opencode\.exe$/);
    expect(r?.prefix).toEqual([]);
  });
  it("runs JS shims with node", () => {
    const shim = 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\x\\cli.js" %*\r\n';
    const r = unwrapNpmShim("C:\\npm\\x.cmd", () => shim);
    expect(r?.command).toBe(process.execPath);
    expect(r?.prefix[0]?.replace(/\\/g, "/")).toMatch(/node_modules\/x\/cli\.js$/);
  });
  it("returns null for unknown shims", () => {
    expect(unwrapNpmShim("C:\\x.cmd", () => "echo hi")).toBeNull();
  });
});

describe("watchServeOutput", () => {
  it("finds the listen line after lots of output, keeping only a bounded tail", () => {
    const urls: string[] = [];
    const w = watchServeOutput((u) => urls.push(u));
    const noise = "INFO booting something\n".repeat(1_000);
    for (let i = 0; i < 100; i++) w.onData(noise);
    expect(w.tail().length).toBeLessThanOrEqual(4_000);
    w.onData("opencode server listening on http://127.0.0.1:4567/\n");
    expect(urls).toEqual(["http://127.0.0.1:4567"]);
    // A running server's log is drained but not kept.
    for (let i = 0; i < 100; i++) w.onData(noise);
    expect(w.tail()).toBe("");
    expect(urls).toHaveLength(1);
  });
});

describe("jsonSchemaToZodShape", () => {
  it("converts required, optional, enum, number and boolean fields", () => {
    const shape = jsonSchemaToZodShape(z, {
      type: "object",
      properties: {
        to: { type: "string", minLength: 1 },
        n: { type: "integer", minimum: 1, maximum: 5 },
        flag: { type: "boolean" },
        mode: { type: "string", enum: ["a", "b"] },
        either: { anyOf: [{ type: "boolean" }, { type: "string" }] },
      },
      required: ["to"],
    });
    const schema = z.object(shape);
    expect(schema.parse({ to: "x" })).toEqual({ to: "x" });
    expect(() => schema.parse({})).toThrow();
    expect(() => schema.parse({ to: "x", n: 9 })).toThrow();
    expect(() => schema.parse({ to: "x", mode: "c" })).toThrow();
    expect(schema.parse({ to: "x", either: "true", flag: false, n: 2, mode: "b" })).toMatchObject({ n: 2, mode: "b" });
  });
});

describe("installers", () => {
  const rel = (base: string, files: string[]) => files.map((f) => f.slice(base.length).replace(/\\/g, "/")).sort();

  it("installs the opencode plugin, server, skill and subagents and removes them again", () => {
    const cfg = mkdtempSync(join(tmpdir(), "ab-oc-"));
    const src = join(REPO, "plugins", "opencode");
    try {
      const res = installOpencode(src, cfg);
      expect(rel(cfg, res.files).filter((f) => !f.startsWith("/agent-bridge/plugin-versions/"))).toEqual([
        "/agents/antigravity.md",
        "/agents/claude.md",
        "/agents/codex.md",
        "/plugins/agent-bridge.js",
        "/skills/agent-bridge/SKILL.md",
      ]);
      expect(res.files.some((file) => file.includes("plugin-versions"))).toBe(true);
      expect(uninstallOpencode(cfg, src).files).toHaveLength(5);
      expect(uninstallOpencode(cfg, src).files).toHaveLength(0);
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  it("never overwrites or removes an agent file the user wrote", () => {
    const cfg = mkdtempSync(join(tmpdir(), "ab-oc-"));
    const src = join(REPO, "plugins", "opencode");
    try {
      mkdirSync(join(cfg, "agents"), { recursive: true });
      writeFileSync(join(cfg, "agents", "claude.md"), "my own claude agent");
      const res = installOpencode(src, cfg);
      expect(rel(cfg, res.skipped)).toEqual(["/agents/claude.md"]);
      expect(readFileSync(join(cfg, "agents", "claude.md"), "utf8")).toBe("my own claude agent");
      const un = uninstallOpencode(cfg, src);
      expect(rel(cfg, un.skipped)).toEqual(["/agents/claude.md"]);
      expect(existsSync(join(cfg, "agents", "claude.md"))).toBe(true);
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});

/** Drive the real plugin with a fake opencode client and a real bridge server child process. */
describe("opencode plugin", () => {
  const home = mkdtempSync(join(tmpdir(), "ab-ocp-"));
  const prompts: { id: string; text: string; noReply: boolean }[] = [];
  let hooks: any;
  let peer: BridgeNode;

  beforeAll(async () => {
    process.env.AGENT_BRIDGE_HOME = home;
    process.env.AGENT_BRIDGE_OPENCODE_SERVER = SERVER;
    process.env.AGENT_BRIDGE_NAME = "opencode-test";
    process.env.AGENT_BRIDGE_LINGER_SEC = "5";
    writeFileSync(join(home, "config.json"), "{}");
    const client = {
      session: {
        promptAsync: async (opts: any) => {
          prompts.push({ id: opts.path.id, text: opts.body.parts[0].text, noReply: Boolean(opts.body.noReply) });
          return { data: undefined };
        },
      },
    };
    const { AgentBridgePlugin } = await import("../src/opencode/plugin.js");
    hooks = await AgentBridgePlugin({ client, directory: home });
    peer = new BridgeNode({ pipePath: resolvePipePath(home, {}), token: loadOrCreateToken(home), dbPath: resolveDbPath(home), agent: "claude", name: "claude-peer", cwd: home, autoWake: false, log: nullLogger });
    await peer.start();
  }, 30_000);

  afterAll(async () => {
    await hooks?.dispose?.();
    await peer?.stop();
    for (const k of ["AGENT_BRIDGE_HOME", "AGENT_BRIDGE_OPENCODE_SERVER", "AGENT_BRIDGE_NAME", "AGENT_BRIDGE_LINGER_SEC"]) delete process.env[k];
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("exposes the bridge tools with a prefix and hides the hook endpoint", () => {
    const names = Object.keys(hooks.tool).sort();
    expect(names).toContain("bridge_send");
    expect(names).toContain("bridge_ask_claude");
    expect(names).toContain("bridge_spawn_codex");
    expect(names).not.toContain("bridge_hook_event");
    expect(names.some((n) => n.includes("opencode"))).toBe(false);
  });

  it("sends through a native tool and delivers the reply by starting a turn when idle", async () => {
    await hooks["chat.message"]({ sessionID: "ses_A" });
    const sent = await hooks.tool.bridge_send.execute({ to: "claude-peer", message: "ping from opencode" }, { sessionID: "ses_A", abort: new AbortController().signal });
    expect(sent).toContain("Delivered to inbox: claude-peer");
    const got = await peer.waitForMessage(3_000);
    expect(got?.body).toBe("ping from opencode");

    // Session finishes its turn; the listen window is open because it just sent a message.
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_A", status: { type: "idle" } } } });
    await peer.send({ to: got!.from.name, body: "pong from claude", replyTo: got!.id });
    const replies = () => prompts.filter((p) => p.text.includes("pong from claude"));
    await expect.poll(() => replies().length, { timeout: 8_000 }).toBe(1);
    expect(replies()[0]).toMatchObject({ id: "ses_A", noReply: false });
  }, 20_000);

  it("feeds mail to a busy session through the system prompt", async () => {
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_A", status: { type: "busy" } } } });
    await peer.send({ to: "opencode-test", body: "while you work" });
    await new Promise((r) => setTimeout(r, 300));
    const output = { system: [] as string[] };
    const before = prompts.length;
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_A" }, output);
    expect(output.system.join("\n")).toContain("while you work");
    // Also stored in the session, so a failed step does not lose mail that is already marked read.
    const stored = prompts.slice(before);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "ses_A", noReply: true });
    expect(stored[0]!.text).toContain("while you work");
  });
});
