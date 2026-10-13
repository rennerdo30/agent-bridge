import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { readJsonSnapshot } from "../src/core/file-cache.js";
import { nullLogger } from "../src/core/logger.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// AB-263: the admission read used by RemoteJobs.receive (loadConfig, a direct
// file read with no cache) must observe a same-size policy rewrite even when
// the mtime tick does not advance. Same for the shared JSON snapshot cache.
it("observes a same-size policy rewrite made within one mtime tick", () => {
  const home = mkdtempSync(join(tmpdir(), "ab263-"));
  homes.push(home);
  const file = join(home, "config.json");
  const policy = (allowPeers: string[]) => JSON.stringify({
    network: {
      enabled: true, name: "mac",
      remoteJobs: { enabled: true, allowRoots: ["/repo"], agents: ["claude"], allowPeers },
    },
  });
  const denied = policy(["another-pc"]);
  // Trailing JSON whitespace is insignificant: pad the shorter payload so the
  // rewrite keeps the exact byte size (stricter than the CI pair, whose two
  // writes differed by 3 bytes).
  const allowed = policy(["windows"]).padEnd(denied.length, "\n");
  expect(allowed.length).toBe(denied.length);
  expect(JSON.parse(allowed)).toEqual(JSON.parse(policy(["windows"])));

  writeFileSync(file, denied);
  const read = () => loadConfig(home, "other", nullLogger, {}).network.remoteJobs;
  expect(read().allowPeers).toEqual(["another-pc"]);
  expect((readJsonSnapshot(file).value as { network: { remoteJobs: { allowPeers: string[] } } }).network.remoteJobs.allowPeers).toEqual(["another-pc"]);

  // Rewrite in place, then force the mtime back so a size+mtime signature
  // cannot tell the two writes apart.
  const before = statSync(file);
  writeFileSync(file, allowed);
  utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000);
  const after = statSync(file);
  expect(after.size).toBe(before.size);
  // The filesystem rounds sub-tick precision, so exact float equality is not
  // portable; the two writes land within one coarse mtime tick of each other.
  expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThan(10);

  expect(read().allowPeers).toEqual(["windows"]);
  expect((readJsonSnapshot(file).value as { network: { remoteJobs: { allowPeers: string[] } } }).network.remoteJobs.allowPeers).toEqual(["windows"]);
});
