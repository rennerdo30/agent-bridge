import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { JSON_STORE_VERSION, readJsonStore, writeJsonStore } from "../src/core/json-store.js";
import { migrateJobOwnership } from "../src/core/job-handoff.js";
import { migrateJobArchives } from "../src/core/job-archive-migration.js";
import { loadConfig } from "../src/core/config.js";
import { readHistoryJobs, readRunLogs } from "../src/core/run-history.js";
import { ensureProjectFolder } from "../src/core/project-store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const tags = ["v0.27.0", "v0.27.1", "v0.28.0", "v0.28.1", "v0.28.2", "v0.29.0", "v0.29.10", "v0.29.13", "v0.29.14"];
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

// Compare every existing field recursively. Only the format marker and additive fields may differ.
function preserve(old: unknown, next: unknown, root = true): void {
  if (Array.isArray(old)) {
    expect(Array.isArray(next)).toBe(true); expect((next as unknown[]).length).toBe(old.length);
    old.forEach((value, i) => preserve(value, (next as unknown[])[i], false));
  } else if (old !== null && typeof old === "object") {
    expect(next).toBeTypeOf("object");
    for (const [key, value] of Object.entries(old)) if (!(root && key === "version")) preserve(value, (next as Record<string, unknown>)[key], false);
  } else expect(hash(JSON.stringify(next))).toBe(hash(JSON.stringify(old)));
}

it.each(tags)("retains every captured %s JSON/run/network/approval record through upgrade and replay", async (tag) => {
  const fixture = join(import.meta.dirname, "fixtures", "upgrade-json", tag);
  const manifest = JSON.parse(readFileSync(join(fixture, "manifest.json"), "utf8"));
  expect(manifest.commit).toMatch(/^[a-f0-9]{40}$/);
  cpSync(fixture, env.home, { recursive: true });
  execFileSync("git", ["init", "--quiet", env.home], { stdio: "pipe" });
  const original = new Map<string, Buffer>();
  for (const entry of manifest.files) {
    const source = readFileSync(join(fixture, entry.path));
    expect(hash(source)).toBe(entry.sha256); expect(source.length).toBe(entry.bytes);
    const path = join(env.home, entry.path);
    const bytes = Buffer.from(source.toString().replaceAll("__FIXTURE_HOME__", env.home.replaceAll("\\", "\\\\")));
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); original.set(entry.path, bytes);
  }
  const changed = new Set<string>();
  for (const [relative, bytes] of original) {
    // Pairing keys and pending capabilities use their own unchanged contracts. Logs and
    // archives are retained byte for byte. No callback or network operation is invoked.
    if (!relative.endsWith(".json") || relative.startsWith("network/") || relative.startsWith("approvals/") || relative.startsWith("archive/")) continue;
    const path = join(env.home, relative), old = JSON.parse(bytes.toString());
    const next = relative === "jobs.json" ? migrateJobOwnership(old) : { ...old, version: JSON_STORE_VERSION };
    writeJsonStore(path, next, old); preserve(old, readJsonStore(path));
    const backups = readdirSync(dirname(path)).filter(name => name.startsWith(`${relative.split("/").at(-1)}.backup-`));
    if (old.version !== JSON_STORE_VERSION) {
      expect(backups).toHaveLength(1); expect(hash(readFileSync(join(dirname(path), backups[0]!)))).toBe(hash(bytes));
    }
    const upgraded = readFileSync(path), prior = readJsonStore(path);
    writeJsonStore(path, prior as Record<string, unknown>, prior);
    expect(readFileSync(path)).toEqual(upgraded); // Second run is byte-idempotent.
    changed.add(relative);
  }
  for (const [relative, bytes] of original) if (!changed.has(relative)) expect(readFileSync(join(env.home, relative))).toEqual(bytes);
  // AB-206: readers use the job index; the elected archive worker imports the released archive files
  // (verified byte for byte before any original moves to cold storage).
  const imported = await migrateJobArchives(join(env.home, "jobs.json"));
  expect(imported.imported).toBeGreaterThan(0);
  expect([...readHistoryJobs(env.home).values()].map(job => job.id)).toEqual(expect.arrayContaining(["kept-job", "archived-job"]));
  expect(loadConfig(env.home, "codex", nullLogger, {})).toMatchObject({ maxJobs: 4, autoWake: false });
  expect(readRunLogs(env.home)).toHaveLength(1);
  expect(readFileSync(readRunLogs(env.home)[0]!.file, "utf8")).toContain("Original answer retained");
  const folder = ensureProjectFolder(env.home);
  expect(folder).toBeTruthy();
  // The local project-folder exclusion must not edit the owner's tracked ignore file.
  expect(readFileSync(join(env.home, ".git", "info", "exclude"), "utf8")).toContain(".agent-bridge");
});
