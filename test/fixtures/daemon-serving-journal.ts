import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Broker, assertLifecycleServingCapability } from "../../src/core/broker.js";
import { BridgeClient } from "../../src/core/client.js";
import { PROTOCOL_VERSION } from "../../src/core/constants.js";
import { EndpointReservation } from "../../src/core/endpoint-reservation.js";
import { nullLogger } from "../../src/core/logger.js";
import { resolveDbPath, resolvePipePath } from "../../src/core/paths.js";
import { MessageStore } from "../../src/core/store.js";
import { readProcessIdentity } from "../../src/core/process-identity.js";
import type { TestEnv } from "../helpers.js";
import { createOwnedHome } from "./owned-home.js";

export async function createServingJournalFixture(env: TestEnv) {
  if (process.platform !== "win32") throw new Error("Owned serving journal fixture is Windows-specific");
  const home = join(env.home, "serving-home");
  // OWNED NEW fixture HOME only, through the file's running owned-home helper.
  await createOwnedHome(home, "Owned journal HOME fixture unavailable");
  const endpoint = resolvePipePath(home, {}), reservation = await EndpointReservation.bind(endpoint);
  let broker: Broker | undefined;
  try {
    const store = new MessageStore(resolveDbPath(home), nullLogger), token = randomUUID();
    broker = new Broker(endpoint, store, nullLogger, token); broker.setHostingMode("daemon");
    await broker.listen(reservation);
    const client = await BridgeClient.connect(endpoint, nullLogger);
    try { await client.request("auth", { protocol: PROTOCOL_VERSION, token }); await client.request("ping", {}); }
    finally { client.close(); }
    const actual = assertLifecycleServingCapability(broker.lifecycleServingCapability("prepare", performance.now() + 5000), "prepare");
    const creationIdentity = await readProcessIdentity(process.pid);
    if (!creationIdentity) throw new Error("Owned journal fixture identity unavailable");
    const owner = { nonce: actual.ownerInstance, pid: process.pid, creationIdentity };
    return { home, broker, reservation, owner, async close() { await broker!.close(); await reservation.close(); } };
  } catch (error) { await broker?.close(); await reservation.close(); throw error; }
}
