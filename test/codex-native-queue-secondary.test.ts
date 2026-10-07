import { it } from "vitest";
import { nativeCodexBin, verifyNativeCodexIdleQueue } from "./codex-native-queue-fixture.js";

it.skipIf(!nativeCodexBin)("real Codex queue wakes an attached idle secondary TUI mock on the same app-server", async () => {
  await verifyNativeCodexIdleQueue("secondary");
});
