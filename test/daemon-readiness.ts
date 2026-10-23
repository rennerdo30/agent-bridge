import { setTimeout as delay } from "node:timers/promises";
import { BridgeError } from "../src/core/protocol.js";

/** Fixture discovery only: callers supply auth/ping, never a mailbox operation. */
export async function fixtureDaemonReadiness(probe: () => Promise<number>, deadline: number,
  pause: () => Promise<unknown> = () => delay(100)): Promise<number | undefined> {
  while (Date.now() < deadline) {
    try { return await probe(); }
    catch (error) {
      // The reservation has not authenticated, registered or admitted a request.
      // Only this exact typed refusal permits another auth/ping discovery pass.
      const tentative = error instanceof BridgeError && error.code === "internal" &&
        error.message === "Core is initializing; no request was admitted.";
      if (!tentative && !["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await pause();
    }
  }
  return undefined;
}
