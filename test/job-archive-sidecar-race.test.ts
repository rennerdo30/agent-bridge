import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeEnv, type TestEnv } from "./helpers.js";

const race = vi.hoisted(() => ({ fakeShmOnce: false, throwShmOnce: false, linkPath: "" }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const realExists = fs.existsSync.bind(fs);
  const realLstat = fs.lstatSync.bind(fs);
  return {
    ...fs,
    existsSync: ((p: unknown) => {
      if (race.fakeShmOnce && typeof p === "string" && (p.endsWith("-shm") || p.endsWith("-wal"))) {
        race.fakeShmOnce = false;
        race.throwShmOnce = true;
        return true;
      }
      return realExists(p as string);
    }) as typeof fs.existsSync,
    lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
      const p = String(args[0]);
      if (race.throwShmOnce && (p.endsWith("-shm") || p.endsWith("-wal"))) {
        race.throwShmOnce = false;
        const err = new Error(`ENOENT: no such file or directory, lstat '${p}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      if (race.linkPath !== "" && p === race.linkPath) {
        return { isSymbolicLink: () => true } as never;
      }
      return (realLstat as (...a: unknown[]) => unknown)(...args) as never;
    }) as typeof fs.lstatSync,
  };
});

import { jobArchivePath, openJobArchive, physicalArchivePath } from "../src/core/job-archive-index.js";

let env: TestEnv, path: string;
beforeEach(() => { env = makeEnv(); path = join(env.home, "jobs.json"); });
afterEach(async () => { race.fakeShmOnce = false; race.throwShmOnce = false; race.linkPath = ""; await env.cleanup(); });

it("treats a SQLite sidecar that vanishes between existsSync and lstat as missing", () => {
  const shm = `${jobArchivePath(path)}-shm`;
  race.fakeShmOnce = true;
  expect(() => physicalArchivePath(shm)).not.toThrow();
  race.fakeShmOnce = true;
  expect(() => openJobArchive(path)).not.toThrow();
  expect(openJobArchive(path)).toBeUndefined();
});

it("still refuses a symbolic link", () => {
  const target = join(env.home, "real.db");
  writeFileSync(target, "x");
  const link = join(env.home, "linked.db");
  // A real entry must exist so the existence check reaches the lstat link
  // refusal; the stub reports it as a symbolic link / junction.
  writeFileSync(link, "x");
  race.linkPath = link;
  try {
    expect(() => physicalArchivePath(link)).toThrow("job archive path must be physical; data kept unchanged");
  } finally {
    race.linkPath = "";
  }
});
