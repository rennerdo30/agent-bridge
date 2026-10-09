import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

function outsideRepository(path) {
  let existing = resolve(path);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  for (let parent = realpathSync.native(existing); ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git"))) throw new Error("Test fixtures must be outside every repository");
    if (dirname(parent) === parent) return;
  }
}

// A fresh physical directory outside every source checkout, shared by all workers.
export function testFixtureRoot() {
  // macOS's per-user $TMPDIR (/private/var/folders/xx/.../T) alone uses half of the 103-byte socket path
  // limit, so fixture homes there would all take the hashed short-socket fallback. Use /tmp instead.
  const temporary = process.env.AGENT_BRIDGE_TEST_TEMP_ROOT ?? (process.platform === "darwin" ? "/tmp" : tmpdir());
  outsideRepository(temporary);
  mkdirSync(temporary, { recursive: true });
  const root = process.env.AGENT_BRIDGE_TEST_ROOT ?? realpathSync.native(mkdtempSync(join(temporary, "ab-tests-")));
  outsideRepository(root);
  mkdirSync(root, { recursive: true });
  process.env.AGENT_BRIDGE_TEST_ROOT = root;
  try { writeFileSync(join(root, "package.json"), '{"private":true,"type":"commonjs"}\n', { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return root;
}
