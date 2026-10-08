import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

it("keeps capability authority internal while legacy-visible peers and events cannot rewrite it", async () => {
  const observer = env.node("observer"); await observer.start();
  const joined: PeerInfo[] = [];
  observer.on("peer_joined", peer => joined.push(peer));
  const path = join(env.home, "storage-capabilities", `${process.pid}.json`);
  const owner = env.node("owner"); await owner.start();
  const before = readFileSync(path);
  await until(() => joined.some(peer => peer.name === "owner"));
  expect(joined.find(peer => peer.name === "owner")!.storeCapabilities).toBeUndefined();
  expect((await observer.peers()).every(peer => peer.storeCapabilities === undefined)).toBe(true);
  expect(readFileSync(path)).toEqual(before);
  const broker = (observer as any).broker;
  expect(broker.localPeers().find((peer: PeerInfo) => peer.name === "owner").storeCapabilities).toEqual({ json: 4, sqlite: 9 });
  await owner.relocate(env.home, "renamed-owner");
  const renamed = JSON.parse(readFileSync(path, "utf8"));
  expect(renamed.name).toBe("renamed-owner");
  expect(renamed.processIdentity).toBe(JSON.parse(before.toString()).processIdentity);
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
  const record = JSON.parse(readFileSync(join(env.home, "storage-capabilities", `${process.pid}.json`), "utf8"));
  expect(record).toMatchObject({ explicit: true, name: owner.name, json: 4, sqlite: 9 });
  expect(record.processIdentity).toBeTruthy();
});
