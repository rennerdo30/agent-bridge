import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpus, release } from "node:os";
import { execFileSync } from "node:child_process";

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== process.env.SOURCE_HEAD) throw new Error("Hosted checkout is not SOURCE_HEAD");
const out = ".agent-bridge-test/ab325-artifact";
mkdirSync(out, { recursive: true });
cpSync("plugins", join(out, "plugins"), { recursive: true });
function files(dir, rel = "") {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap(entry => {
    const name = join(rel, entry.name);
    if (entry.isDirectory()) return files(dir, name);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unexpected artifact entry");
    const bytes = readFileSync(join(dir, name));
    return [{ path: name.replaceAll("\\", "/"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
  }).sort((a, b) => a.path.localeCompare(b.path, "en"));
}
writeFileSync(join(out, "SOURCE_HEAD"), head + "\n");
writeFileSync(join(out, "manifest.json"), JSON.stringify({ schema: 1, sourceHead: head, baseHead: process.env.BASE_HEAD,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, platform: process.platform, architecture: process.arch,
  osRelease: release(), node: process.version, versions: process.versions, vcpu: cpus().length, fixtureOnly: true, ownerDataAccessed: false,
  limits: { concurrentClients: 10, createMilliseconds: 5000, unchangedRpcMilliseconds: 10000 }, files: files(join(out, "plugins")) }, null, 2) + "\n");
