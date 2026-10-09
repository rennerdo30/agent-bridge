import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { bundleFiles, bundleFilesBounded, extractBundle, legacyJobCopies, readBundleManifest, retireBundled } from "../src/core/archive-bundle.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

const copy = (n: number) => `jobs-${1791524700000 + n}-${String(n).padStart(8, "0")}-0000-4000-8000-000000000000.json`;

function seed(dir: string): Map<string, Buffer> {
  mkdirSync(dir, { recursive: true });
  const files = new Map<string, Buffer>();
  for (let i = 0; i < 40; i++) {
    // Mostly identical snapshots, like repeated per-node publications.
    const body = Buffer.from(JSON.stringify({ version: 1, jobs: [{ id: `job-${i % 5}`, prompt: "x".repeat(2000) }] }, null, 2) + "\n");
    writeFileSync(join(dir, copy(i)), body);
    files.set(copy(i), body);
  }
  writeFileSync(join(dir, "jobs-content-abc.json"), "{}");
  return files;
}

it("selects only legacy per-save copies", () => {
  const dir = join(env.home, "archive");
  seed(dir);
  const names = legacyJobCopies(dir);
  expect(names).toHaveLength(40);
  expect(names).not.toContain("jobs-content-abc.json");
});

it("restores every original byte-exact and stores identical copies once", () => {
  const dir = join(env.home, "archive"), out = join(dir, "cold-bundles");
  const files = seed(dir);
  const manifestPath = bundleFiles(dir, legacyJobCopies(dir), out, 1);
  const manifest = readBundleManifest(manifestPath);
  expect(manifest.entries).toHaveLength(40);
  expect(manifest.blobs).toHaveLength(5);
  const restored = extractBundle(manifestPath);
  for (const [name, bytes] of files) expect(restored.get(name)!.equals(bytes)).toBe(true);
  // Bundling never moves or changes the originals.
  for (const [name, bytes] of files) expect(readFileSync(join(dir, name)).equals(bytes)).toBe(true);
  expect(readFileSync(join(out, manifest.bundle)).length).toBeLessThan([...files.values()].reduce((n, b) => n + b.length, 0) / 10);
});

it("detects a damaged bundle", () => {
  const dir = join(env.home, "archive"), out = join(dir, "cold-bundles");
  seed(dir);
  const manifestPath = bundleFiles(dir, legacyJobCopies(dir), out, 1);
  const bundle = join(out, readBundleManifest(manifestPath).bundle);
  const bytes = readFileSync(bundle); bytes[bytes.length - 1] = bytes.at(-1)! ^ 0xff;
  writeFileSync(bundle, bytes);
  expect(() => extractBundle(manifestPath)).toThrow(/checksum mismatch/);
  expect(() => retireBundled(dir, manifestPath, join(dir, "cold"))).toThrow();
  expect(legacyJobCopies(dir)).toHaveLength(40);
});

it("moves only verified, unchanged originals and keeps everything else", () => {
  const dir = join(env.home, "archive"), out = join(dir, "cold-bundles"), cold = join(dir, "cold");
  const files = seed(dir);
  const manifestPath = bundleFiles(dir, legacyJobCopies(dir), out, 1);
  writeFileSync(join(dir, copy(3)), "changed after bundling");
  const { moved, kept } = retireBundled(dir, manifestPath, cold);
  expect(kept).toEqual([copy(3)]);
  expect(moved).toHaveLength(39);
  expect(readFileSync(join(dir, copy(3)), "utf8")).toBe("changed after bundling");
  for (const name of moved) expect(readFileSync(join(cold, name)).equals(files.get(name)!)).toBe(true);
  expect(legacyJobCopies(dir)).toEqual([copy(3)]);
  expect(existsSync(join(dir, "jobs-content-abc.json"))).toBe(true);
  expect(readdirSync(cold)).toHaveLength(39);
});

it("AB-230: splits a large group into bundles of bounded size, each restoring its originals byte-exact", () => {
  const dir = join(env.home, "archive"), out = join(dir, "cold-bundles");
  const files = seed(dir);
  const each = files.get(copy(0))!.length;
  const manifests = bundleFilesBounded(dir, legacyJobCopies(dir), out, 1, each * 10);
  expect(manifests).toHaveLength(4);
  const restored = new Map<string, Buffer>();
  for (const manifest of manifests) {
    expect(readBundleManifest(manifest).entries.reduce((n, e) => n + e.bytes, 0)).toBeLessThanOrEqual(each * 10);
    for (const [name, bytes] of extractBundle(manifest)) restored.set(name, bytes);
  }
  expect(restored.size).toBe(40);
  for (const [name, bytes] of files) expect(restored.get(name)!.equals(bytes)).toBe(true);
});
