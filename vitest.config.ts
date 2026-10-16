import { configDefaults, defineConfig } from "vitest/config";
import { fastTests, integrationTests } from "./scripts/test-lanes.mjs";
import { DurationShardSequencer } from "./scripts/test-shards.mjs";

/** Tests start real named pipes / sockets and child processes; shared CI runners can be slow. */
const lane = process.env.AGENT_BRIDGE_TEST_LANE ?? "all";
const TEST_TIMEOUT_MS = lane === "fast" ? 30_000 : 120_000;

export default defineConfig({
  // Root tests import the portable mobile client without installing the Expo app.
  tsconfig: "./tsconfig.json",
  // Keep writable test caches in this checkout when dependencies are shared read-only.
  cacheDir: ".agent-bridge-test/vite",
  test: {
    include: lane === "fast" ? fastTests : lane === "integration" ? integrationTests : ["test/**/*.test.ts"],
    maxWorkers: process.platform === "win32" && lane !== "fast" ? 1 : undefined,
    exclude: [...configDefaults.exclude, ".agent-bridge-test/**"],
    // --shard=i/n packs files by measured Windows duration; execution order is unchanged.
    sequence: { sequencer: DurationShardSequencer },
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    // Never inherit the parent link of a subagent that runs the suite.
    setupFiles: ["./test/setup-env.ts"],
    // Applies test/known-flaky.json: listed tests are skipped here and run in the
    // non-blocking known-flaky lane (AGENT_BRIDGE_KNOWN_FLAKY=only). See CONTRIBUTING.md.
    runner: "./scripts/known-flaky-runner.mjs",
  },
});
