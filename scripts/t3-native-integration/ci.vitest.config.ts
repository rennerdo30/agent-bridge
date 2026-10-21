// Standalone config deliberately avoids T3's loadRepoEnv/build config.
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
export default defineConfig({
  test: {
    include: [
      "apps/server/src/orchestration-v2/Adapters/CodexBridgeDynamicTools*.test.ts",
      "packages/effect-codex-app-server/src/PrivateRequestAdmission.test.ts",
      "packages/effect-codex-app-server/src/PrivateProtocolLifecycle.test.ts",
      "packages/effect-codex-app-server/src/protocol.test.ts",
    ],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 5_000,
  },
});
