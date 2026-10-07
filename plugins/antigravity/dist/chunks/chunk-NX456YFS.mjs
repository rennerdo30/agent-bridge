import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  archiveFile
} from "./chunk-CLF3ZYME.mjs";
import {
  assertUnlinked,
  atomicPluginWrite,
  selectRuntime
} from "./chunk-HPETZCQA.mjs";
import {
  APP_VERSION
} from "./chunk-DQEWVRBU.mjs";

// src/cli/opencode-install.ts
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
var INSTALL_MARKER = "agent-bridge";
var PLUGIN_FILE = "agent-bridge.js";
var SERVER_DIR = "agent-bridge";
var SKILL_REL = join("skills", "agent-bridge", "SKILL.md");
var AGENTS_DIR = "agents";
function opencodeConfigDir(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "opencode");
}
function pluginSourceDir(name, marker, fromFile = fileURLToPath(import.meta.url)) {
  let dir = dirname(fromFile);
  for (let i = 0; i < 5; i++) {
    for (const candidate of [join(dir, "plugins", name), join(dir, "..", name)]) {
      if (existsSync(join(candidate, marker))) return resolve(candidate);
    }
    dir = dirname(dir);
  }
  return null;
}
var opencodeSourceDir = (from) => pluginSourceDir("opencode", join("dist", PLUGIN_FILE), from);
function ownedByUs(path) {
  try {
    return readFileSync(path, "utf8").includes(INSTALL_MARKER);
  } catch {
    return false;
  }
}
function copyAll(copies, configDir) {
  const res = { configDir, files: [], skipped: [] };
  for (const [from, to] of copies) {
    if (!existsSync(from)) throw new Error(`missing build output: ${from} (run npm run build)`);
    if (existsSync(to) && !ownedByUs(to)) {
      res.skipped.push(to);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    assertUnlinked(from);
    assertUnlinked(to);
    atomicPluginWrite(to, readFileSync(from, "utf8"));
    res.files.push(to);
  }
  return res;
}
var AGENT_SOURCE_SUFFIX = ".agent.md";
function agentCopies(sourceDir, targetDir) {
  const dir = join(sourceDir, AGENTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(AGENT_SOURCE_SUFFIX)).map((f) => [join(dir, f), join(targetDir, AGENTS_DIR, f.slice(0, -AGENT_SOURCE_SUFFIX.length) + ".md")]);
}
function installOpencode(sourceDir, configDir = opencodeConfigDir()) {
  assertUnlinked(configDir);
  const native = join(configDir, "plugins", PLUGIN_FILE);
  assertUnlinked(native);
  if (existsSync(native) && !ownedByUs(native)) throw new Error(`Refusing to replace an unowned opencode plugin: ${native}`);
  const root = selectRuntime(join(configDir, SERVER_DIR), "opencode", sourceDir, APP_VERSION);
  const result = copyAll(
    [
      [join(sourceDir, SKILL_REL), join(configDir, SKILL_REL)],
      ...agentCopies(sourceDir, configDir)
    ],
    configDir
  );
  const url = pathToFileURL(join(root, "dist", PLUGIN_FILE)).href;
  atomicPluginWrite(native, `// agent-bridge: immutable plugin entry; previous versions are retained.
export * from ${JSON.stringify(url)};
`);
  result.files.push(native, root);
  return result;
}
function uninstallOpencode(configDir = opencodeConfigDir(), sourceDir = opencodeSourceDir()) {
  const targets = [join(configDir, "plugins", PLUGIN_FILE), join(configDir, "plugins", SERVER_DIR), join(configDir, "skills", "agent-bridge")];
  if (sourceDir) targets.push(...agentCopies(sourceDir, configDir).map(([, to]) => to));
  return removeOwned(targets, configDir);
}
function removeOwned(targets, configDir) {
  const res = { configDir, files: [], skipped: [] };
  for (const p of targets) {
    if (!existsSync(p)) continue;
    const isOurFile = p.endsWith(".md") || p.endsWith(".toml") ? ownedByUs(p) : true;
    if (!isOurFile) {
      res.skipped.push(p);
      continue;
    }
    archiveFile(p);
    res.files.push(p);
  }
  return res;
}

export {
  INSTALL_MARKER,
  opencodeConfigDir,
  pluginSourceDir,
  opencodeSourceDir,
  installOpencode,
  uninstallOpencode
};
