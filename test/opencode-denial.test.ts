import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { delegateToOpencodeServed } from "../src/core/opencode-served.js";

it("passes the supervisor's denial reason through opencode's permission reply", async () => {
  const root = join(process.cwd(), ".agent-bridge-test");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "opencode-denial-"));
  writeFileSync(join(dir, "serve"), `
import { createServer } from "node:http";
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
  try {
    const res = await delegateToOpencodeServed({ bin: process.execPath, cwd: dir, prompt: "task", timeoutSec: 10, log: nullLogger,
      onPermission: async (r) => {
        expect(r).toMatchObject({ tool: "mcp:pair-desk", detail: "pair-desk_set_build: *" });
        return { allow: false, message: "Denied by supervisor parent: publish only from merged master" };
      },
    });
    expect(JSON.parse(res.text)).toEqual({ reply: "reject", message: "Denied by supervisor parent: publish only from merged master" });
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 15_000);
