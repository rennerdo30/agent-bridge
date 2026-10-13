import { expect, it, vi } from "vitest";
import { BROKER_SUCCESSOR_GRACE_MS } from "../src/core/broker-upgrade.js";
import { CONNECT_TIMEOUT_MS, ELECTION_RETRY_MAX_MS, RECONNECT_BACKOFF_MIN_MS } from "../src/core/constants.js";
import { makeEnv, until } from "./helpers.js";

vi.mock("../src/core/broker-upgrade.js", async original => ({
  ...await original<typeof import("../src/core/broker-upgrade.js")>(),
  // No polling tick can account for a handover observed in this test's budget.
  BROKER_UPGRADE_CHECK_MS: 60_000,
}));

it.each(["hello", "eligibility"])("reacts to a newer eligible %s without waiting for the polling timer", async mode => {
  const env = makeEnv();
  try {
    const old = env.node("old");
    (old as any).version = "0.30.12"; await old.start(); (old as any).broker.version = "0.30.12";
    const sent = await old.send({ to: "later", body: "retained by reactive handover" });
    const next = env.node("next");
    if (mode === "eligibility") await next.setBrokerEligibility(false);
    await next.start();
    if (mode === "eligibility") { expect(old.isBroker).toBe(true); await next.setBrokerEligibility(true); }
    await until(() => next.isBroker && old.isConnected && !old.isBroker,
      BROKER_SUCCESSOR_GRACE_MS + RECONNECT_BACKOFF_MIN_MS + ELECTION_RETRY_MAX_MS + 2 * CONNECT_TIMEOUT_MS);
    const later = env.node("later"); await later.start(); await until(() => later.unread().length === 1);
    expect(later.unread()[0]?.id).toBe(sent.messages[0]?.id);
  } finally { vi.restoreAllMocks(); await env.cleanup(); }
});
