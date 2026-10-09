import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { PermissionRelay, RELAY_TOKEN_ENV, RELAY_URL_ENV, type PermissionRequest } from "../src/core/relay.js";
import { loadOrCreateToken } from "../src/core/token.js";

// AB-244: multi-byte characters split across HTTP chunks, and the token file's create-then-write window.
it("decodes a request body whose chunks split a multi-byte character", async () => {
  const seen: PermissionRequest[] = [];
  const relay = new PermissionRelay(async (r) => (seen.push(r), { allow: false, message: "no" }), nullLogger);
  await relay.start();
  try {
    const env = relay.childEnv(), url = new URL(env[RELAY_URL_ENV]!);
    const detail = "Grüße 日本語 🙂 ".repeat(50);
    const body = Buffer.from(JSON.stringify({ agent: "codex", tool: "Bash", detail }));
    const split = body.indexOf(Buffer.from("ü")) + 1; // inside the two-byte "ü"
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env[RELAY_TOKEN_ENV]}`, "content-length": body.length } }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", reject);
      req.flushHeaders();
      req.write(body.subarray(0, split));
      setTimeout(() => req.end(body.subarray(split)), 100);
    });
    expect(seen[0]?.detail).toBe(detail);
  } finally { await relay.stop(); }
});

it("waits briefly for a token another process created but has not written yet", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-token-"));
  try {
    const file = join(home, "token");
    writeFileSync(file, "");
    const writer = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(file)}, "abc123"), 300)`], { stdio: "ignore" });
    try { expect(loadOrCreateToken(home)).toBe("abc123"); }
    finally { writer.kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
