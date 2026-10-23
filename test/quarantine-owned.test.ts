import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as asyncFs from "node:fs/promises";
import { quarantineTextAsync } from "../src/core/oversize.js";
import { makeEnv, type TestEnv } from "./helpers.js";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
let env: TestEnv;
afterEach(async () => { vi.restoreAllMocks(); if (env) await env.cleanup(); });
it("refuses same-length conflicting quarantine bytes and preserves the foreign evidence", async () => {
  env = makeEnv();
  const file = await quarantineTextAsync(env.home, "owned", "original");
  writeFileSync(file, "conflict");
  await expect(quarantineTextAsync(env.home, "owned", "original")).rejects.toThrow();
  expect(readFileSync(file, "utf8")).toBe("conflict");
});
it("refuses a quarantine directory junction without following or modifying its target", async () => {
  env = makeEnv();
  const foreign = join(env.home, "foreign-evidence"); mkdirSync(foreign);
  writeFileSync(join(foreign, "original.txt"), "Foreign evidence");
  symlinkSync(foreign, join(env.home, "quarantine"), "junction");
  await expect(quarantineTextAsync(env.home, "owned", "original")).rejects.toThrow();
  expect(readFileSync(join(foreign, "original.txt"), "utf8")).toBe("Foreign evidence");
});

it("reuses only the exact owned regular file without rewriting it", async () => {
  env = makeEnv(); const file = await quarantineTextAsync(env.home, "owned", "original");
  const original = statSync(file); const confirm = vi.fn();
  expect(await quarantineTextAsync(env.home, "owned", "original", confirm)).toBe(file);
  expect(statSync(file).ino).toBe(original.ino); expect(statSync(file).mtimeMs).toBe(original.mtimeMs);
  expect(confirm).toHaveBeenCalledOnce();
});
it("refuses a hard-linked evidence leaf even when bytes match", async () => {
  env = makeEnv(); const file = await quarantineTextAsync(env.home, "owned", "original");
  linkSync(file, join(env.home, "foreign-link")); const confirm = vi.fn();
  await expect(quarantineTextAsync(env.home, "owned", "original", confirm)).rejects.toThrow();
  expect(confirm).not.toHaveBeenCalled(); expect(readFileSync(file, "utf8")).toBe("original");
});
it("revalidates bytes after asynchronous publication before confirming, retaining a substituted same-size file", async () => {
  env = makeEnv(); const link = asyncFs.link, confirm = vi.fn();
  vi.spyOn(asyncFs, "link").mockImplementationOnce(async (from, to) => {
    await link(from, to); writeFileSync(to, "conflict");
  });
  await expect(quarantineTextAsync(env.home, "owned", "original", confirm)).rejects.toThrow();
  expect(confirm).not.toHaveBeenCalled();
  const file = readdirSync(join(env.home, "quarantine")).find(name => name.endsWith(".txt"))!;
  expect(readFileSync(join(env.home, "quarantine", file), "utf8")).toBe("conflict");
});
it("keeps a failed partial attempt unconfirmed and writes/verifies the original on restart", async () => {
  env = makeEnv(); const open = asyncFs.open, confirm = vi.fn();
  vi.spyOn(asyncFs, "open").mockImplementationOnce(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => { await handle.write("part"); throw new Error("controlled partial write"); });
    return handle;
  });
  await expect(quarantineTextAsync(env.home, "owned", "original", confirm)).rejects.toThrow("controlled partial write");
  expect(confirm).not.toHaveBeenCalled(); expect(readdirSync(join(env.home, "quarantine"))).toEqual([]);
  const file = await quarantineTextAsync(env.home, "owned", "original", confirm);
  expect(readFileSync(file, "utf8")).toBe("original"); expect(confirm).toHaveBeenCalledOnce();
});
it("refuses a directory replacement across publication even when its substituted bytes match", async () => {
  env = makeEnv(); const link = asyncFs.link, confirm = vi.fn();
  vi.spyOn(asyncFs, "link").mockImplementationOnce(async (from, to) => {
    await link(from, to);
    renameSync(join(env.home, "quarantine"), join(env.home, "original-retained-directory"));
    mkdirSync(join(env.home, "quarantine")); writeFileSync(to, "original", { mode: 0o600 });
  });
  await expect(quarantineTextAsync(env.home, "owned", "original", confirm)).rejects.toThrow();
  expect(confirm).not.toHaveBeenCalled();
  expect(readdirSync(join(env.home, "original-retained-directory")).some(file => file.endsWith(".txt"))).toBe(true);
  expect(readdirSync(join(env.home, "quarantine")).some(file => file.endsWith(".txt"))).toBe(true);
});
