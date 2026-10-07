// Bundles the MCP server and CLI into each plugin folder so installed plugins need no npm install,
// and keeps every manifest's version in sync with package.json.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIRS = ["plugins/claude", "plugins/codex", "plugins/opencode"];
const MANIFESTS = [
  "plugins/claude/.claude-plugin/plugin.json",
  "plugins/codex/.codex-plugin/plugin.json",
  "plugins/opencode/package.json",
  ".claude-plugin/marketplace.json",
];
const ENTRIES = { server: "src/mcp/main.ts", cli: "src/cli/main.ts", "history-worker": "src/core/history-worker.ts" };
const NODE_TARGET = "node22";
const SHEBANG = "#!/usr/bin/env node\n";
const REQUIRE_SHIM = "import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);";

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const constantsPath = join(ROOT, "src/core/constants.ts");
if (!readFileSync(constantsPath, "utf8").includes(`APP_VERSION = "${version}"`)) {
  throw new Error(`APP_VERSION in src/core/constants.ts does not match package.json version ${version}`);
}

for (const rel of MANIFESTS) {
  const path = join(ROOT, rel);
  const json = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(json.plugins)) json.plugins.forEach((p) => (p.version = version));
  else json.version = version;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}

for (const dir of PLUGIN_DIRS) {
  for (const [name, entry] of Object.entries(ENTRIES)) {
    await build({
      entryPoints: [join(ROOT, entry)],
      outfile: join(ROOT, dir, "dist", `${name}.mjs`),
      bundle: true,
      platform: "node",
      format: "esm",
      target: NODE_TARGET,
      external: ["node:*"],
      legalComments: "eof",
      logLevel: "warning",
      // Some bundled CommonJS dependencies call require(); give them one in ESM output.
      // The CLI also gets a shebang so it works as the package's bin (npx github:...).
      banner: { js: (name === "cli" ? SHEBANG : "") + REQUIRE_SHIM },
    });
  }
  console.log(`built ${dir}/dist (v${version})`);
}

// The opencode plugin runs inside opencode (Bun) and spawns dist/server.mjs with Node.
await build({
  entryPoints: [join(ROOT, "src/opencode/plugin.ts")],
  outfile: join(ROOT, "plugins/opencode/dist/agent-bridge.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: NODE_TARGET,
  external: ["node:*", "@opencode-ai/plugin"],
  legalComments: "eof",
  logLevel: "warning",
});
console.log(`built plugins/opencode/dist/agent-bridge.js (v${version})`);
