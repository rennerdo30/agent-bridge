import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { delegateToOpencodeServed } from "../src/core/opencode-served.js";
import { opencodeVersion, pidAlive } from "../src/core/delegate.js";
import { parseOpencodeVersion } from "../src/core/opencode-native-tools.js";

it("passes the supervisor's denial reason through opencode's permission reply", async () => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!;
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "opencode-denial-"));
  writeFileSync(join(dir, "serve"), `
const { createServer } = require("node:http");
const { writeFileSync } = require("node:fs");
writeFileSync("serve.pid", String(process.pid));
let events; let decision;
const event = (type, properties) => events.write("data: " + JSON.stringify({ type, properties }) + "\\n\\n");
const server = createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/event") { events = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": connected\\n\\n"); return; }
  let text = ""; for await (const chunk of req) text += chunk;
  let response = {};
  if (path === "/session") response = { id: "session" };
  if (path === "/mcp") response = { "pair-desk": {} };
  if (path === "/session/session/prompt_async") setTimeout(() => event("permission.asked", { id: "permission", sessionID: "session", permission: "pair-desk_set_build", patterns: ["*"] }), 10);
  if (path === "/permission/permission/reply") { decision = JSON.parse(text); setTimeout(() => event("session.idle", { sessionID: "session" }), 10); }
  if (path === "/session/session/message") response = [{ info: { role: "assistant" }, parts: [{ type: "text", text: JSON.stringify(decision) }] }];
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response));
});
server.listen(0, "127.0.0.1", () => console.log("listening on http://127.0.0.1:" + server.address().port));
`);
  // A supported opencode version for the version gate; every other invocation runs the fake server above.
  const script = join(dir, "fake.mjs");
  writeFileSync(script, `#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
if (process.argv[2] === "--version") { console.log("opencode v1.18.35"); process.exit(0); }
createRequire(import.meta.url)(fileURLToPath(new URL("serve", import.meta.url)));
`);
  const bin = process.platform === "win32" ? join(dir, "opencode.cmd") : script;
  if (process.platform === "win32") writeFileSync(bin, '@ECHO off\r\n"%dp0%\\fake.mjs" %*\r\n');
  else chmodSync(script, 0o755);
  try {
    // The probe must see the fixture's opencode version, not the Node runtime's.
    const probed = await opencodeVersion(bin, dir, nullLogger);
    expect(probed).toBe("opencode v1.18.35");
    expect(parseOpencodeVersion(probed).api).toBe("v1");
    const res = await delegateToOpencodeServed({ bin, cwd: dir, prompt: "task", timeoutSec: 10, log: nullLogger,
      onPermission: async (r) => {
        expect(r).toMatchObject({ tool: "mcp:pair-desk", detail: "pair-desk_set_build: *" });
        return { allow: false, message: "Denied by supervisor parent: publish only from merged master" };
      },
    });
    expect(JSON.parse(res.text)).toEqual({ reply: "reject", message: "Denied by supervisor parent: publish only from merged master" });
    expect(pidAlive(Number(readFileSync(join(dir, "serve.pid"), "utf8")))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 15_000);
