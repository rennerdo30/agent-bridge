import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  isPluginCacheCwd
} from "./chunk-I7XFUMWM.mjs";

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
  for (let bytes = 0; bytes < MAX_DISCOVERY_BYTES; bytes += MAX_TRANSCRIPT_CHUNK_BYTES) {
    const page = readJsonl(file, from);
    entries.push(...page.entries);
    if (page.next === from) break;
    from = page.next;
  }
  return entries;
}

// src/core/project-identity.ts
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync as realpathSync2, statSync as statSync2 } from "node:fs";
import { basename, delimiter, dirname, isAbsolute as isAbsolute2, join as join2, relative as relative2, resolve as resolve2 } from "node:path";
var projectRoots = /* @__PURE__ */ new Map();
var PROJECT_ROOT_CACHE_MS = 3e4;
function canonicalProjectRoot(cwd) {
  if (isPluginCacheCwd(cwd)) return null;
  const visibleRoot = (root) => isPluginCacheCwd(root) ? null : root;
  try {
    const physical = realpathSync2.native(cwd);
    if (isPluginCacheCwd(physical)) return null;
    if (!statSync2(physical).isDirectory()) return null;
    const cached = projectRoots.get(physical), now = Date.now(), discovery = discoverProjectRoot(physical);
    if (cached && cached.expiresAt > now && cached.marker === discovery.marker) return cached.root;
    const root = discovery.fallback ? resolveProjectRoot(physical, visibleRoot) : discovery.root === null ? null : visibleRoot(discovery.root);
    if (projectRoots.size >= 256) projectRoots.delete(projectRoots.keys().next().value);
    projectRoots.set(physical, { root, expiresAt: now + PROJECT_ROOT_CACHE_MS, marker: discovery.marker });
    return root;
  } catch {
    return null;
  }
}
function discoveryCeiling(physical, configured) {
  if (!configured) return null;
  const cwd = physical.replace(/\\/g, "/");
  let canonicalize = true, ceiling = null;
  for (const entry of configured.split(delimiter)) {
    if (!entry) {
      canonicalize = false;
      continue;
    }
    if (!isAbsolute2(entry)) continue;
    let candidate = entry;
    if (canonicalize) {
      try {
        candidate = realpathSync2.native(entry).replace(/\\/g, "/");
      } catch {
        continue;
      }
    }
    if (candidate.endsWith("/")) candidate = candidate.slice(0, -1);
    if (!cwd.startsWith(`${candidate}/`) || cwd.length <= candidate.length + 1) continue;
    if (ceiling === null || candidate.length > ceiling.length) ceiling = candidate;
  }
  return ceiling;
}
function discoverProjectRoot(physical) {
  const configuredCeilings = process.env.GIT_CEILING_DIRECTORIES;
  const ceiling = discoveryCeiling(physical, configuredCeilings);
  const markers = [JSON.stringify(["ceiling", configuredCeilings, ceiling])];
  const checkedDirectories = /* @__PURE__ */ new Set();
  const stamp = (path) => {
    const stat = lstatSync(path);
    markers.push(`${path}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}:${stat.size}`);
    if (stat.isSymbolicLink()) throw new Error("linked Git metadata");
    return stat;
  };
  const text = (path, maxBytes = 8192) => {
    const stat = stamp(path);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("unsupported Git metadata file");
    const value = readFileSync(path, "utf8");
    markers.push(value);
    return value.trim();
  };
  const directory2 = (path) => {
    const result = realpathSync2.native(path);
    for (let at = resolve2(path); ; at = dirname(at)) {
      if (checkedDirectories.has(at)) break;
      if (!stamp(at).isDirectory()) throw new Error("unsupported Git metadata directory");
      checkedDirectories.add(at);
      if (dirname(at) === at) break;
    }
    return result;
  };
  const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const repository = (common) => {
    if (!/^(ref: refs\/[^\r\n]+|[0-9a-fA-F]{40,64})$/.test(text(join2(common, "HEAD")))) throw new Error("invalid Git HEAD");
    directory2(join2(common, "objects"));
    directory2(join2(common, "refs"));
    const config = text(join2(common, "config"), 64 * 1024);
    let core = false, bare, unusual = false;
    for (const line of config.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]/.exec(line);
      if (section) {
        core = section[1].toLowerCase() === "core";
        if (/^include(?:if)?(?:\s|$)/i.test(section[1])) unusual = true;
        continue;
      }
      if (!core) continue;
      const option = /^\s*([\w.-]+)\s*=\s*(.*?)\s*(?:[#;].*)?$/.exec(line);
      if (option?.[1]?.toLowerCase() === "bare") bare = option[2]?.toLowerCase();
      if (option?.[1]?.toLowerCase() === "worktree") unusual = true;
    }
    if (bare === "true") return "bare";
    return unusual || bare !== "false" ? "unusual" : "ordinary";
  };
  for (let root = physical; ; root = dirname(root)) {
    if (root !== physical && root.replace(/\\/g, "/").replace(/\/$/, "") === ceiling)
      return { marker: markers.join("|"), root: physical };
    const pointer = join2(root, ".git");
    let stat;
    try {
      stat = stamp(pointer);
    } catch (error) {
      if (error.code === "ENOENT") {
        if (dirname(root) === root) return { marker: markers.join("|"), root: physical };
        continue;
      }
      return { marker: markers.join("|"), root: null };
    }
    try {
      if (stat.isDirectory()) {
        const gitDir2 = directory2(pointer), layout2 = repository(gitDir2);
        return { marker: markers.join("|"), root: layout2 === "bare" ? physical : root, fallback: layout2 === "unusual" };
      }
      const match = /^gitdir:\s+([^\r\n]+)$/.exec(text(pointer));
      if (!match) throw new Error("invalid Git directory pointer");
      const gitDir = directory2(resolve2(root, match[1]));
      if (!/^(ref: refs\/[^\r\n]+|[0-9a-fA-F]{40,64})$/.test(text(join2(gitDir, "HEAD")))) throw new Error("invalid Git worktree HEAD");
      let commonPointer;
      try {
        commonPointer = text(join2(gitDir, "commondir"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        repository(gitDir);
        return { marker: markers.join("|"), root: null, fallback: true };
      }
      if (!commonPointer || /[\r\n]/.test(commonPointer)) throw new Error("invalid Git common directory pointer");
      const common = directory2(resolve2(gitDir, commonPointer)), layout = repository(common);
      if (layout !== "ordinary" || basename(common).toLowerCase() !== ".git") return { marker: markers.join("|"), root: null, fallback: true };
      const entry = relative2(join2(common, "worktrees"), gitDir);
      if (!entry || entry === ".." || entry.startsWith("..\\") || entry.startsWith("../") || /[\\/]/.test(entry)) throw new Error("Git worktree pointer is outside its common directory");
      const backPointer = text(join2(gitDir, "gitdir"));
      if (!backPointer || /[\r\n]/.test(backPointer) || !samePath(realpathSync2.native(resolve2(gitDir, backPointer)), realpathSync2.native(pointer))) throw new Error("Git worktree pointer does not identify this checkout");
      return { marker: markers.join("|"), root: dirname(common) };
    } catch {
      return { marker: markers.join("|"), root: null };
    }
  }
}
function resolveProjectRoot(physical, visibleRoot) {
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
      const value = JSON.parse(readFileSync(path, "utf8"));
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
var conversationRoots = /* @__PURE__ */ new Map();
function conversationProject(cwd) {
  if (!cwd || isPluginCacheCwd(cwd)) return "";
  try {
    if (isPluginCacheCwd(realpathSync2.native(cwd))) return "";
  } catch {
  }
  const cacheKey = JSON.stringify([cwd, process.env.GIT_CEILING_DIRECTORIES]);
  const known = conversationRoots.get(cacheKey);
  if (known !== void 0) return known;
  const canonical = canonicalProjectRoot(cwd);
  const root = canonical ? projectKey(canonical) : existsSync(cwd) ? "" : projectKey(resolve2(cwd));
  if (conversationRoots.size >= 256) conversationRoots.delete(conversationRoots.keys().next().value);
  conversationRoots.set(cacheKey, root);
  return root;
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
  canonicalProjectRoot,
  projectKey,
  projectGroupsEnabled,
  migrateProjectJobs,
  conversationProject
};
