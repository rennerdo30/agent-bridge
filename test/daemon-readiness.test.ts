import { afterEach, expect, it, vi } from "vitest";
import { BridgeError } from "../src/core/protocol.js";
import { fixtureDaemonReadiness } from "./daemon-readiness.js";

afterEach(() => vi.restoreAllMocks());

it("does not mistake the tentative no-effect auth reply for an admitted daemon or a failed operation", async () => {
  let now = 0, admitted = false; vi.spyOn(Date, "now").mockImplementation(() => now);
  const probe = vi.fn(async () => {
    if (!admitted) throw new BridgeError("internal", "Core is initializing; no request was admitted.");
    return 271;
  });
  const pause = vi.fn(async () => { now += 100; admitted = true; });
  expect(await fixtureDaemonReadiness(probe, 1000, pause)).toBe(271);
  expect(probe).toHaveBeenCalledTimes(2); expect(pause).toHaveBeenCalledOnce();
});

it.each([
  new BridgeError("unauthorized", "rejected"), new BridgeError("protocol_mismatch", "rejected"),
  new BridgeError("internal", "other failure"), new BridgeError("timeout", "uncertain request"),
  Object.assign(new Error("Core is initializing; no request was admitted."), { code: "internal" }),
])("does not retry ambiguous failures or auth/protocol refusals: %s", async failure => {
  const pause = vi.fn(), probe = vi.fn(async () => { throw failure; });
  await expect(fixtureDaemonReadiness(probe, Date.now() + 1000, pause)).rejects.toBe(failure);
  expect(probe).toHaveBeenCalledOnce(); expect(pause).not.toHaveBeenCalled();
});

it("retains the original readiness deadline without sending an effect or making an extra pass", async () => {
  let now = 0; vi.spyOn(Date, "now").mockImplementation(() => now);
  const failure = Object.assign(new Error("not listening"), { code: "ENOENT" });
  const probe = vi.fn(async () => { throw failure; }), pause = vi.fn(async () => { now = 1000; });
  expect(await fixtureDaemonReadiness(probe, 1000, pause)).toBeUndefined();
  expect(probe).toHaveBeenCalledOnce(); expect(pause).toHaveBeenCalledOnce();
});
