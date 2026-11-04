// Bundles the MCP server and CLI into each plugin folder so installed plugins need no npm install,
// and keeps every manifest's version in sync with package.json.
import { build } from "esbuild";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRIES, OPENCODE_ENTRY, EXTERNAL } from "./bundle-entries.mjs";
import { writeNoticesFor } from "./third-party-notices.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIRS = ["plugins/claude", "plugins/codex", "plugins/opencode", "plugins/antigravity", "plugins/muse"];
const MANIFESTS = [
  "plugins/claude/.claude-plugin/plugin.json",
  "plugins/codex/.codex-plugin/plugin.json",
  "plugins/opencode/package.json",
  "plugins/antigravity/package.json",
  "plugins/antigravity/plugin.json",
  "plugins/muse/.muse-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];
const NODE_TARGET = "node24";
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

const metafiles = new Map();
for (const dir of PLUGIN_DIRS) {
  // Retain prior chunks, including hashes no longer referenced by the new entrypoints.
  // Build only mutates generated output in this checkout; no installed runtime is touched.
  const chunks = join(ROOT, dir, "dist", "chunks");
  if (existsSync(chunks)) {
    const archive = join(ROOT, ".agent-bridge-test", "bundle-archive", randomUUID());
    mkdirSync(archive, { recursive: true });
    renameSync(chunks, join(archive, "chunks"));
  }
  {
    const result = await build({
      absWorkingDir: ROOT,
      // Shared read-only dependencies must have the same logical paths as CI's local cache.
      preserveSymlinks: true,
      entryPoints: Object.fromEntries(Object.entries(ENTRIES).map(([name, entry]) => [name, join(ROOT, entry)])),
      outdir: join(ROOT, dir, "dist"),
      outExtension: { ".js": ".mjs" },
      chunkNames: "chunks/[name]-[hash]",
      splitting: true,
      bundle: true,
      platform: "node",
      format: "esm",
      target: NODE_TARGET,
      external: EXTERNAL,
      legalComments: "eof",
      metafile: true,
      logLevel: "warning",
      // Some bundled CommonJS dependencies call require(); give them one in ESM output.
      // The CLI also gets a shebang so it works as the package's bin (npx github:...).
      banner: { js: REQUIRE_SHIM },
    });
    metafiles.set(dir, [result.metafile]);
  }
  const cli = join(ROOT, dir, "dist", "cli.mjs");
  writeFileSync(cli, SHEBANG + readFileSync(cli, "utf8"));
  console.log(`built ${dir}/dist (v${version})`);
}

// The opencode plugin runs inside opencode (Bun) and spawns dist/server.mjs with Node.
const opencode = await build({
  absWorkingDir: ROOT,
  preserveSymlinks: true,
  entryPoints: [join(ROOT, OPENCODE_ENTRY)],
  outfile: join(ROOT, "plugins/opencode/dist/agent-bridge.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: NODE_TARGET,
  external: [...EXTERNAL, "@opencode-ai/plugin"],
  legalComments: "eof",
  metafile: true,
  logLevel: "warning",
});
console.log(`built plugins/opencode/dist/agent-bridge.js (v${version})`);
metafiles.get("plugins/opencode").push(opencode.metafile);

// The bundles contain third-party code; its licenses must ship with every copy.
for (const [dir, files] of metafiles) writeNoticesFor(join(ROOT, dir, "dist"), files);
console.log("wrote dist/THIRD_PARTY_NOTICES.md for every plugin");
