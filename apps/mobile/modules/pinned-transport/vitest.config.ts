import { defineConfig } from "vitest/config";
export default defineConfig({ cacheDir: "apps/mobile/.test-cache/pinned-transport", test: {
  include: ["apps/mobile/modules/pinned-transport/test/*.test.ts"], environment: "node", maxWorkers: 1,
} });
