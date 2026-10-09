import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FAKE_CLAUDE } from "../scripts/release-runner-fixture.js";

it("flushes synthetic native completion and exits while its parent HTTP listener remains open", async () => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!; mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, "native-cli-exit-"));
  const script = join(home, "fixture.mjs"), marker = join(home, "marker.json"), release = join(home, "release");
  const context = Buffer.from("Retained synthetic context and completion proof.\n");
  writeFileSync(script, FAKE_CLAUDE, { flag: "wx" });
  writeFileSync(join(home, "context.txt"), context, { flag: "wx" });
  let consumed = false;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Drain this generated request. */ }
    response.setHeader("content-type", "application/json");
    if (request.url === "/inbox") response.end(JSON.stringify({ messages: consumed ? [] : [{ id: "fixture-message", body: "Retain this live instruction" }] }));
    else {
      if (request.url === "/message") { consumed = true; writeFileSync(release, "Synthetic release.\n", { flag: "wx" }); }
      response.end("{}");
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture listener missing");
  const child = spawn(process.execPath, [script], { cwd: home, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: {
    ...process.env, AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_PARENT_URL: `http://127.0.0.1:${address.port}`, AGENT_BRIDGE_PARENT_TOKEN: "synthetic-fixture-token",
  } });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  const exited = once(child, "exit");
  try {
    child.stdin.end(`fixture_marker=${marker} fixture_release=${release} Hold generated context.`);
    expect(await exited).toEqual([0, null]);
    expect(stderr).toBe(""); expect(server.listening).toBe(true);
    const result = stdout.trim().split("\n").map(line => JSON.parse(line)).find(value => value.type === "result");
    expect(result).toMatchObject({ subtype: "success", is_error: false });
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ exited: true, receivedLive: ["Retain this live instruction"] });
    expect(readFileSync(join(home, "context.txt"))).toEqual(context);
    expect(readFileSync(script, "utf8")).toBe(FAKE_CLAUDE);
    expect(readFileSync(`${marker}.live.jsonl`, "utf8")).toContain("Retain this live instruction");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
