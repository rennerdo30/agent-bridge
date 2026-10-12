import { defineConfig } from "vitest/config";
export default defineConfig({ cacheDir: "apps/mobile/.test-cache/vite", test: { include: ["apps/mobile/test/*.test.ts"], environment: "node", maxWorkers: 1 } });
