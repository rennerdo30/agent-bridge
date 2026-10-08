import { configDefaults, defineConfig } from "vitest/config";
import { fastTests, integrationTests } from "./scripts/test-lanes.mjs";

/** Tests start real named pipes / sockets and child processes; shared CI runners can be slow. */
const lane = process.env.AGENT_BRIDGE_TEST_LANE ?? "all";
const TEST_TIMEOUT_MS = lane === "fast" ? 30_000 : 120_000;

export default defineConfig({
  // Keep writable test caches in this checkout when dependencies are shared read-only.
  cacheDir: ".agent-bridge-test/vite",
  test: {
    include: lane === "fast" ? fastTests : lane === "integration" ? integrationTests : ["test/**/*.test.ts"],
    maxWorkers: process.platform === "win32" && lane !== "fast" ? 1 : undefined,
    exclude: [...configDefaults.exclude, ".agent-bridge-test/**"],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    // Never inherit the parent link of a subagent that runs the suite.
    setupFiles: ["./test/setup-env.ts"],
  },
});
