// Collects the licenses of all third-party code that esbuild bundles into the plugins.
// The bundles ship copies of these packages, and their licenses (MIT, ISC, BSD, Apache-2.0)
// require the copyright and license text to travel with every copy.
//
// Used two ways:
// - scripts/build.mjs passes each build's metafile and writes dist/THIRD_PARTY_NOTICES.md;
// - `node scripts/third-party-notices.mjs [--check]` analyses the bundle entries without
//   writing bundles and writes (or verifies) the repository's THIRD_PARTY_NOTICES.md.
import { build } from "esbuild";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Vendored files under src/ that carry their own license.
const VENDORED = {
  "src/mobile/vendor/qrcode.js": {
    name: "qrcode-generator",
    version: "2.0.4",
    license: "MIT",
    repository: "https://github.com/kazuhikoarase/qrcode-generator",
    licenseFile: "src/mobile/vendor/LICENSE.qrcode.txt",
  },
};

function packageDirOf(input) {
  const marker = "node_modules/";
  const at = input.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = input.slice(at + marker.length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  return { dir: input.slice(0, at + marker.length) + name, name };
}

function repositoryOf(pkg) {
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!repo) return pkg.homepage ?? "";
  const url = repo
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^(?:git|ssh):\/\/(?:git@)?/, "https://")
    .replace(/^https:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^github:/, "https://github.com/");
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
}

function licenseTextOf(dir) {
  const files = readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => f.name);
  const license = files.find((f) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(f));
  if (!license) return null;
  // Apache-2.0 section 4(d): NOTICE files travel with the license.
  const notices = files.filter((f) => /^(notice|copyrightnotice)(\.(md|txt))?$/i.test(f));
  return [license, ...notices].map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n");
}

/** Third-party components among the given esbuild metafile inputs, sorted by name. */
export function collectNotices(inputPaths) {
  const found = new Map();
  for (const input of inputPaths) {
    const path = input.replaceAll("\\", "/");
    if (VENDORED[path]) {
      const v = VENDORED[path];
      found.set(v.name, { ...v, text: readFileSync(join(ROOT, v.licenseFile), "utf8").trim() });
      continue;
    }
    const owner = packageDirOf(path);
    if (!owner || found.has(owner.dir)) continue;
    const dir = join(ROOT, owner.dir);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const text = licenseTextOf(dir);
    if (!text) throw new Error(`third-party notices: ${owner.name} has no license file; add its text before bundling it`);
    found.set(owner.dir, { name: pkg.name ?? owner.name, version: pkg.version ?? "", license: pkg.license ?? "see text", repository: repositoryOf(pkg), text });
  }
  // One entry per name and version, even when a package is installed in several places.
  const unique = new Map([...found.values()].map((n) => [`${n.name}@${n.version}`, n]));
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function renderNotices(notices) {
  const head = [
    "# Third-party notices",
    "",
    "agent-bridge is MIT licensed (see LICENSE). Its plugin bundles include the following",
    "third-party software, each under its own license, reproduced below.",
    "",
    "| Component | Version | License |",
    "| --- | --- | --- |",
    ...notices.map((n) => `| ${n.repository ? `[${n.name}](${n.repository})` : n.name} | ${n.version} | ${n.license} |`),
    "",
  ];
  const body = notices.flatMap((n) => [`## ${n.name} ${n.version}`, "", "```text", n.text, "```", ""]);
  return [...head, ...body].join("\n");
}

/** Writes dist/THIRD_PARTY_NOTICES.md for one plugin from the metafiles of its builds. */
export function writeNoticesFor(outDir, metafiles) {
  const inputs = metafiles.flatMap((m) => Object.keys(m.inputs));
  writeFileSync(join(outDir, "THIRD_PARTY_NOTICES.md"), renderNotices(collectNotices(inputs)));
}

async function analyse() {
  const { ENTRIES, OPENCODE_ENTRY, EXTERNAL } = await import("./bundle-entries.mjs");
  const common = { absWorkingDir: ROOT, preserveSymlinks: true, bundle: true, platform: "node", format: "esm", target: "node24", write: false, metafile: true, logLevel: "error" };
  const main = await build({ ...common, entryPoints: Object.fromEntries(Object.entries(ENTRIES).map(([k, v]) => [k, join(ROOT, v)])), outdir: join(ROOT, ".agent-bridge-test", "notices"), splitting: true, external: EXTERNAL });
  const opencode = await build({ ...common, entryPoints: [join(ROOT, OPENCODE_ENTRY)], outfile: join(ROOT, ".agent-bridge-test", "notices", "opencode.js"), external: [...EXTERNAL, "@opencode-ai/plugin"] });
  return renderNotices(collectNotices([...Object.keys(main.metafile.inputs), ...Object.keys(opencode.metafile.inputs)]));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const target = join(ROOT, "THIRD_PARTY_NOTICES.md");
  const text = await analyse();
  if (process.argv.includes("--check")) {
    if (!existsSync(target) || readFileSync(target, "utf8") !== text) {
      console.error("THIRD_PARTY_NOTICES.md is out of date: run `node scripts/third-party-notices.mjs` and commit it.");
      process.exit(1);
    }
    console.log("THIRD_PARTY_NOTICES.md is up to date.");
  } else {
    writeFileSync(target, text);
    console.log(`wrote THIRD_PARTY_NOTICES.md`);
  }
}
