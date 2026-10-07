import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  isPluginCacheCwd
} from "./chunk-JJMNBQDB.mjs";
import {
  JSON_STORE_VERSION,
  assertStoreUpgrade,
  isRecord
} from "./chunk-CLF3ZYME.mjs";

// src/core/transcripts/common.ts
import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
var MAX_TRANSCRIPT_CHUNK_BYTES = 512 * 1024;
var MAX_TOOL_PREVIEW_CHARS = 1200;
var MAX_TEXT_CHARS = 16e3;
var MAX_TITLE_CHARS = 160;
var MAX_NATIVE_SUBAGENTS = 200;
var MAX_DISCOVERY_FILES = 2e4;
var MAX_DISCOVERY_BYTES = 8 * 1024 * 1024;
var MAX_CURSOR_CHARS = 256;
var SQLITE_READ_TIMEOUT_MS = 100;
var INITIAL_HEADER_BYTES = 8 * 1024;
var TRANSCRIPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function transcriptPaths(env = process.env, home = homedir()) {
  return {
    claude: resolve(env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude")),
    codex: resolve(env.CODEX_HOME?.trim() || join(home, ".codex")),
    opencode: resolve(join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "opencode")),
    antigravity: resolve(env.ANTIGRAVITY_CLI_HOME?.trim() || join(home, ".gemini", "antigravity-cli"))
  };
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function parse(value) {
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}
function time(value) {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : 0;
  return Number.isFinite(at) ? at : 0;
}
function preview(value, limit = MAX_TOOL_PREVIEW_CHARS) {
  let text = "";
  if (typeof value === "string") text = value;
  else if (value !== void 0 && value !== null) {
    try {
      text = JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return text.length > limit ? `${text.slice(0, limit)}\u2026` : text;
}
function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(object).filter((p) => ["text", "input_text", "output_text"].includes(p.type) && typeof p.text === "string").map((p) => p.text).join("\n");
}
function directory(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function fileStat(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}
function safeFile(root, file, canonicalRoot) {
  try {
    const actual = realpathSync.native(file), rel = relative(canonicalRoot ?? realpathSync.native(root), actual);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? actual : null;
  } catch {
    return null;
  }
}
function readJsonl(file, from = "0", maxBytes = MAX_TRANSCRIPT_CHUNK_BYTES) {
  const match = /^(?:j:)?(\d+)(?::([01]))?$/.exec(from);
  let offset = match ? Number(match[1]) : 0, discard = match?.[2] === "1";
  if (!Number.isSafeInteger(offset)) offset = 0;
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (offset > size) {
      offset = 0;
      discard = false;
    }
    if (offset > 0 && !discard) {
      const previous = Buffer.alloc(1);
      readSync(fd, previous, 0, 1, offset - 1);
      discard = previous[0] !== 10;
    }
    const buf = Buffer.alloc(Math.min(maxBytes, Math.max(0, size - offset)));
    const length = readSync(fd, buf, 0, buf.length, offset);
    const entries = [];
    let start = 0;
    for (let i = 0; i < length; i++) {
      if (buf[i] !== 10) continue;
      if (!discard) entries.push({ value: parse(buf.subarray(start, i).toString("utf8")), offset: offset + start });
      discard = false;
      start = i + 1;
    }
    if (start === 0 && length === maxBytes) {
      offset += length;
      discard = true;
    } else if (discard) offset += length;
    else offset += start;
    return { entries, next: `j:${offset}:${discard ? 1 : 0}` };
  } catch {
    return { entries: [], next: `j:${offset}:${discard ? 1 : 0}` };
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function readHead(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    for (let limit = INITIAL_HEADER_BYTES; limit <= MAX_TRANSCRIPT_CHUNK_BYTES; limit *= 2) {
      const buf = Buffer.alloc(Math.min(size, limit));
      const length = readSync(fd, buf, 0, buf.length, 0), newline = buf.indexOf(10);
      if (newline >= 0) return parse(buf.subarray(0, newline).toString("utf8"));
      if (length < limit) break;
    }
    return {};
  } catch {
    return {};
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function readTail(file) {
  const size = fileStat(file)?.size ?? 0;
  return readJsonl(file, String(Math.max(0, size - MAX_TRANSCRIPT_CHUNK_BYTES))).entries.map((e) => e.value);
}
function scanJsonl(file) {
  const entries = [];
  let from = "0";
  for (let bytes2 = 0; bytes2 < MAX_DISCOVERY_BYTES; bytes2 += MAX_TRANSCRIPT_CHUNK_BYTES) {
    const page = readJsonl(file, from);
    entries.push(...page.entries);
    if (page.next === from) break;
    from = page.next;
  }
  return entries;
}

// src/core/file-cache.ts
import { readFileSync, statSync as statSync2 } from "node:fs";
var MAX_BYTES = 8 * 1024 * 1024;
var MAX_ENTRIES = 2048;
var cache = /* @__PURE__ */ new Map();
var bytes = 0;
function fileSignature(st) {
  return `${st.dev}:${st.ino}:${st.birthtimeMs}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`;
}
function readJsonSnapshot(file) {
  const st = statSync2(file), signature = fileSignature(st);
  const saved = cache.get(file);
  if (saved?.signature === signature) {
    cache.delete(file);
    cache.set(file, saved);
    return saved;
  }
  if (saved) {
    cache.delete(file);
    bytes -= saved.bytes;
  }
  const next = { signature, value: JSON.parse(readFileSync(file, "utf8")), bytes: st.size };
  if (st.size <= MAX_BYTES) {
    cache.set(file, next);
    bytes += st.size;
    while (bytes > MAX_BYTES || cache.size > MAX_ENTRIES) {
      const first = cache.keys().next().value;
      bytes -= cache.get(first).bytes;
      cache.delete(first);
    }
  }
  return next;
}

// src/core/project-identity.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync as readFileSync2, realpathSync as realpathSync2, statSync as statSync3 } from "node:fs";
import { dirname, join as join2, resolve as resolve2 } from "node:path";
function canonicalProjectRoot(cwd) {
  if (isPluginCacheCwd(cwd)) return null;
  const visibleRoot = (root) => isPluginCacheCwd(root) ? null : root;
  try {
    const physical = realpathSync2.native(cwd);
    if (isPluginCacheCwd(physical)) return null;
    if (!statSync3(physical).isDirectory()) return null;
    const git = (args) => execFileSync(
      "git",
      ["-C", physical, "rev-parse", ...args],
      { encoding: "utf8", timeout: 3e3, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    try {
      const top = realpathSync2.native(git(["--show-toplevel"]));
      const common = realpathSync2.native(resolve2(physical, git(["--git-common-dir"])));
      if (common.endsWith("/.git") || common.endsWith("\\.git")) return visibleRoot(realpathSync2.native(dirname(common)));
      try {
        const configured = execFileSync(
          "git",
          ["--git-dir", common, "config", "--get", "core.worktree"],
          { encoding: "utf8", timeout: 3e3, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
        ).trim();
        if (configured) return visibleRoot(realpathSync2.native(resolve2(common, configured)));
      } catch {
      }
      const worktrees = execFileSync(
        "git",
        ["-C", physical, "worktree", "list", "--porcelain"],
        { encoding: "utf8", timeout: 3e3, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
      );
      const main = worktrees.split(/\r?\n\r?\n/).find((entry) => !/^bare$/m.test(entry));
      const root = main && /^worktree (.+)$/m.exec(main)?.[1];
      return visibleRoot(root ? realpathSync2.native(root) : top);
    } catch {
      return physical;
    }
  } catch {
    return null;
  }
}
function projectKey(root) {
  return process.platform === "win32" ? root.toLowerCase() : root;
}
function projectGroupsEnabled(root, home, agent) {
  if (!root) return false;
  try {
    const records = [];
    for (const path of [home && join2(home, "config.json"), join2(root, ".agent-bridge", "config.json")]) {
      if (!path || !existsSync(path)) {
        records.push({});
        continue;
      }
      const value = JSON.parse(readFileSync2(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      records.push(value);
    }
    const section = (value) => {
      const local = agent ? value[agent] : void 0;
      return local && typeof local === "object" && !Array.isArray(local) ? local : {};
    };
    const [globalConfig, projectConfig] = records;
    const enabled = [
      section(projectConfig).projectGroups,
      projectConfig.projectGroups,
      section(globalConfig).projectGroups,
      globalConfig.projectGroups
    ].find((v) => v !== void 0);
    return enabled === void 0 || enabled === true;
  } catch {
    return false;
  }
}
function migrateProjectJobs(records) {
  const roots = /* @__PURE__ */ new Map();
  const rootFor = (cwd) => {
    if (!roots.has(cwd)) roots.set(cwd, canonicalProjectRoot(cwd));
    return roots.get(cwd) ?? null;
  };
  return records.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const job = entry;
    if (typeof job.projectRoot === "string") return entry;
    const worktree = job.worktree;
    for (const value of [worktree?.repoRoot, job.workdir]) {
      if (typeof value !== "string") continue;
      const root = rootFor(value);
      if (root) return { ...job, projectRoot: root };
    }
    return entry;
  });
}

// src/core/job-archive.ts
import { randomUUID } from "node:crypto";
import { closeSync as closeSync2, existsSync as existsSync2, fsyncSync, mkdirSync, openSync as openSync2, readdirSync as readdirSync2, writeFileSync } from "node:fs";
import { basename, dirname as dirname2, join as join3 } from "node:path";
var snapshots = /* @__PURE__ */ new Map();
var EMPTY_SNAPSHOT = { signature: "", jobs: [] };
function readArchivedJobs(path) {
  return structuredClone(readArchivedJobSnapshot(path).jobs);
}
function readArchivedJobSnapshot(path) {
  const dir = join3(dirname2(path), "archive");
  if (!existsSync2(dir)) return EMPTY_SNAPSHOT;
  const sources = [];
  const signatures = [];
  let bytes2 = 0;
  for (const file of readdirSync2(dir).sort()) {
    if (!file.startsWith(`${basename(path)}.overflow.json-`) && !/^jobs-.*\.json$/.test(file)) continue;
    const snapshot = readJsonSnapshot(join3(dir, file));
    const value = snapshot.value;
    if (!isRecord(value) || value.version !== void 0 && (!Number.isInteger(value.version) || value.version < 0 || value.version > JSON_STORE_VERSION) || !Array.isArray(value.jobs)) throw new Error(`invalid job archive: ${file}`);
    signatures.push(`${file}:${snapshot.signature}`);
    sources.push({ value });
    bytes2 += snapshot.bytes;
  }
  const signature = signatures.join("\n"), saved = snapshots.get(path);
  if (saved?.signature === signature) return saved;
  const jobs = /* @__PURE__ */ new Map();
  for (const source of sources) for (const job of source.value.jobs) {
    if (isRecord(job) && typeof job.id === "string") jobs.set(job.id, job);
  }
  const next = { signature, jobs: [...jobs.values()] };
  snapshots.delete(path);
  if (bytes2 <= 8 * 1024 * 1024) snapshots.set(path, next);
  if (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value);
  return next;
}
function archiveJobs(path, jobs) {
  assertStoreUpgrade(dirname2(path), "json", 0, JSON_STORE_VERSION);
  const dir = join3(dirname2(path), "archive");
  mkdirSync(dir, { recursive: true, mode: 448 });
  const target = join3(dir, `jobs-${Date.now()}-${randomUUID()}.json`);
  writeFileSync(target, JSON.stringify({ version: JSON_STORE_VERSION, jobs }, null, 2) + "\n", { mode: 384, flag: "wx" });
  const fd = openSync2(target, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync2(fd);
  }
  return target;
}

export {
  MAX_TRANSCRIPT_CHUNK_BYTES,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_NATIVE_SUBAGENTS,
  MAX_DISCOVERY_FILES,
  MAX_CURSOR_CHARS,
  SQLITE_READ_TIMEOUT_MS,
  TRANSCRIPT_ID,
  transcriptPaths,
  object,
  parse,
  time,
  preview,
  contentText,
  directory,
  fileStat,
  safeFile,
  readJsonl,
  readHead,
  readTail,
  scanJsonl,
  fileSignature,
  readJsonSnapshot,
  canonicalProjectRoot,
  projectKey,
  projectGroupsEnabled,
  migrateProjectJobs,
  readArchivedJobs,
  readArchivedJobSnapshot,
  archiveJobs
};
