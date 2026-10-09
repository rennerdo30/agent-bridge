import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  APP_VERSION,
  PROTOCOL_VERSION
} from "./chunk-7EOIPV3B.mjs";

// src/core/plugin-runtime.ts
import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
var RUNTIME_SCHEMA = 1;
var runtimeRoot = (home, client) => join(home, "plugin-versions", client);
function assertUnlinked(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Plugin links are not supported: ${current}`);
    if (dirname(current) === current) break;
  }
}
function pluginFiles(root, rel = "") {
  assertUnlinked(root);
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const path = join(rel, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Plugin links are not supported: ${path}`);
    if (entry.isDirectory()) return pluginFiles(root, path);
    if (!entry.isFile()) throw new Error(`Unsupported plugin file: ${path}`);
    return [path];
  }).sort();
}
function digest(root) {
  const hash = createHash("sha256");
  for (const rel of pluginFiles(root)) hash.update(rel.replaceAll("\\", "/")).update("\0").update(readFileSync(join(root, rel))).update("\0");
  return hash.digest("hex");
}
function validatePluginPublication(source, base, version) {
  releaseVersion(version);
  assertUnlinked(source);
  assertUnlinked(base);
  const target = join(base, version);
  assertUnlinked(target);
  if (existsSync(target) && digest(source) !== digest(target)) throw new Error(`Immutable plugin version differs: ${target}. Release a new patch; existing files were preserved.`);
}
function releaseVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected a patch release version, got ${version}`);
}
function publishPlugin(source, base, version = APP_VERSION) {
  releaseVersion(version);
  assertUnlinked(source);
  assertUnlinked(base);
  const target = join(base, version);
  assertUnlinked(target);
  if (existsSync(target)) {
    if (digest(source) !== digest(target)) throw new Error(`Immutable plugin version differs: ${target}. Release a new patch; existing files were preserved.`);
    return target;
  }
  const files = pluginFiles(source);
  const staging = join(dirname(base), `.agent-bridge-stage-${randomUUID()}`);
  assertUnlinked(staging);
  mkdirSync(staging, { recursive: true });
  for (const rel of files) {
    mkdirSync(dirname(join(staging, rel)), { recursive: true });
    copyFileSync(join(source, rel), join(staging, rel));
  }
  mkdirSync(base, { recursive: true });
  if (existsSync(target)) {
    if (digest(staging) !== digest(target)) throw new Error(`Concurrent immutable version differs: ${target}`);
    return target;
  }
  renameSync(staging, target);
  return target;
}
function atomicPluginWrite(path, text) {
  assertUnlinked(path);
  mkdirSync(dirname(path), { recursive: true });
  const previous = existsSync(path) ? readFileSync(path) : null;
  const content = Buffer.from(text);
  if (previous?.equals(content)) return;
  const tmp = `${path}.${randomUUID()}.tmp`, backup = `${path}.backup-${Date.now()}-${randomUUID()}`;
  assertUnlinked(tmp);
  assertUnlinked(backup);
  if (previous) copyFileSync(path, backup);
  writeFileSync(tmp, content, { flag: "wx", mode: 384 });
  const current = existsSync(path) ? readFileSync(path) : null;
  if (previous === null !== (current === null) || previous && !previous.equals(current)) throw new Error(`Plugin metadata changed concurrently; preserved both copies: ${path}`);
  renameSync(tmp, path);
}
function selectRuntime(home, client, source, version = APP_VERSION) {
  releaseVersion(version);
  const base = runtimeRoot(home, client);
  const path = join(base, "active.json");
  assertUnlinked(path);
  if (existsSync(path)) {
    const old = JSON.parse(readFileSync(path, "utf8"));
    if (old.schemaVersion !== RUNTIME_SCHEMA) throw new Error("Unknown runtime selector format; preserved unchanged");
    releaseVersion(old.version);
    const a = old.version.split(".").map(Number), b = version.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (a[i] > b[i]) throw new Error("A newer plugin runtime is already selected; preserved unchanged");
      if (a[i] < b[i]) break;
    }
  }
  const root = publishPlugin(source, base, version);
  atomicPluginWrite(path, JSON.stringify({ schemaVersion: RUNTIME_SCHEMA, version, protocol: PROTOCOL_VERSION }, null, 2) + "\n");
  return root;
}
function selectedWorker(home, client, fallback) {
  const base = runtimeRoot(home, client), path = join(base, "active.json");
  try {
    assertUnlinked(path);
    const active = JSON.parse(readFileSync(path, "utf8"));
    releaseVersion(active.version);
    if (active.schemaVersion !== RUNTIME_SCHEMA || active.protocol !== PROTOCOL_VERSION) throw new Error("Incompatible runtime selector");
    const worker = join(base, active.version, "dist", "worker.mjs");
    assertUnlinked(worker);
    if (!existsSync(worker)) throw new Error("Missing selected worker");
    return { worker, version: active.version };
  } catch {
    return { worker: fallback, version: APP_VERSION };
  }
}
function recordRuntimeSession(home, session) {
  atomicPluginWrite(join(home, "plugin-sessions", `${session.pid}.json`), JSON.stringify({ schemaVersion: RUNTIME_SCHEMA, ...session }) + "\n");
}
function liveRuntimeSessions(home, client) {
  const dir = join(home, "plugin-sessions");
  if (!existsSync(dir)) return [];
  assertUnlinked(dir);
  return readdirSync(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
    try {
      const path = join(dir, file);
      assertUnlinked(path);
      const session = JSON.parse(readFileSync(path, "utf8"));
      if (session.schemaVersion !== RUNTIME_SCHEMA || session.client !== client || !Number.isSafeInteger(session.pid) || session.pid <= 0) return [];
      process.kill(session.pid, 0);
      return [session];
    } catch {
      return [];
    }
  });
}

export {
  assertUnlinked,
  pluginFiles,
  validatePluginPublication,
  releaseVersion,
  publishPlugin,
  atomicPluginWrite,
  selectRuntime,
  selectedWorker,
  recordRuntimeSession,
  liveRuntimeSessions
};
