import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeEnv, type TestEnv } from "./helpers.js";

// The first read of the watched path returns what a concurrent in-place writer exposes for a moment.
const partial = vi.hoisted(() => ({ path: "", content: null as string | null }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      if (partial.content !== null && String(args[0]) === partial.path) {
        const content = partial.content;
        partial.content = null;
        return content;
      }
      return (fs.readFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.readFileSync,
  };
});

import { readJsonStore } from "../src/core/json-store.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { partial.content = null; await env.cleanup(); });

// CI 2026-10-10: a remote broker read config.json while a test rewrote it in place; the empty read moved the
// config aside as corrupt and remote jobs looked disabled.
it.each(["", '{"network":{"remoteJobs":'])("does not move a store aside that was mid-write (%j)", (seen) => {
  const path = join(env.home, "config.json");
  writeFileSync(path, JSON.stringify({ network: { remoteJobs: { enabled: true } } }));
  partial.path = path; partial.content = seen;
  expect(readJsonStore(path)).toEqual({ network: { remoteJobs: { enabled: true } } });
  expect(existsSync(path)).toBe(true);
  expect(readdirSync(env.home).filter((f) => f.includes(".corrupt-"))).toEqual([]);
});

it("still preserves a store that stays corrupt", () => {
  const path = join(env.home, "config.json");
  writeFileSync(path, "{not json");
  expect(readJsonStore(path)).toBeNull();
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(env.home).filter((f) => f.startsWith("config.json.corrupt-"))).toHaveLength(1);
});
