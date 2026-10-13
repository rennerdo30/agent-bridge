import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
/** AB-208: a process's capability record is a bridge.db metadata row keyed by its PID. */
function capabilityRecord(pid = process.pid): string {
  const db = new DatabaseSync(join(env.home, "bridge.db"), { readOnly: true });
  try { return String(db.prepare("SELECT value FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(String(pid))!.value); }
  finally { db.close(); }
}
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

it("keeps capability authority internal while legacy-visible peers and events cannot rewrite it", async () => {
  const observer = env.node("observer"); await observer.start();
  const joined: PeerInfo[] = [];
  observer.on("peer_joined", peer => joined.push(peer));
  const owner = env.node("owner"); await owner.start();
  const before = capabilityRecord();
  await until(() => joined.some(peer => peer.name === "owner"));
  expect(joined.find(peer => peer.name === "owner")!.storeCapabilities).toBeUndefined();
  expect((await observer.peers()).every(peer => peer.storeCapabilities === undefined)).toBe(true);
  expect(capabilityRecord()).toBe(before);
  const broker = (observer as any).broker;
  expect(broker.localPeers().find((peer: PeerInfo) => peer.name === "owner").storeCapabilities).toEqual({ json: 4, sqlite: 9, jobArchive: 1 });
  await owner.relocate(env.home, "renamed-owner");
  const renamed = JSON.parse(capabilityRecord());
  expect(renamed.name).toBe("renamed-owner");
  expect(renamed.processIdentity).toBe(JSON.parse(before).processIdentity);
});

it("does not publish explicit hello capabilities through an older broker", async () => {
  const observer = env.node("observer"); await observer.start();
  const request = BridgeClient.prototype.request;
  let helloCaps: unknown = "not sent";
  vi.spyOn(BridgeClient.prototype, "request").mockImplementation(async function (this: BridgeClient, op, args: any) {
    if (op === "hello") helloCaps = args.peer.storeCapabilities;
    const result: any = await request.call(this, op, args);
    return op === "ping" ? { ...result, brokerVersion: "0.29.17" } : result;
  });
  const owner = env.node("owner"); await owner.start();
  expect(helloCaps).toBeUndefined();
  const record = JSON.parse(capabilityRecord());
  expect(record).toMatchObject({ explicit: true, name: owner.name, json: 4, sqlite: 9 });
  expect(record.processIdentity).toBeTruthy();
});
