import { defineConfig } from "vitest/config";

/** Tests start real named pipes / sockets and child processes; shared CI runners can be slow. */
const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
  },
});
