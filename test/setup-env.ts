import { vi } from "vitest";
import { join } from "node:path";
import { realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// macOS exposes its temporary root through /var -> /private/var. Fixtures use
// the physical directory so immutable plugin tests retain strict link rejection.
if (process.platform !== "win32") process.env.TMPDIR = realpathSync(tmpdir());
else {
  const fixtureTemp = join(process.cwd(), ".agent-bridge-test", "temp");
  mkdirSync(fixtureTemp, { recursive: true });
  process.env.TEMP = fixtureTemp;
  process.env.TMP = fixtureTemp;
  // Empty fixtures must not discover the containing source checkout as their repository.
  process.env.GIT_CEILING_DIRECTORIES = fixtureTemp;
}

// Unit and integration tests inspect commands, never display desktop notifications on the developer's PC.
vi.mock("../src/core/notifications.js", async (original) => ({
  ...await original<typeof import("../src/core/notifications.js")>(),
  notifyJobEvent: vi.fn(),
  notifyOwnerQuestion: vi.fn(),
}));

/**
 * When the suite runs inside an agent-bridge subagent, these point at that subagent's real parent session:
 * fake subagents started by the tests would then message it ("ping from opencode"). Tests start clean.
 * Spelled out here on purpose: importing src/ from a setup file would load modules before tests mock them.
 * Keep in sync with PARENT_*_ENV (src/core/parent-link.ts) and DELEGATE_DEPTH_ENV (src/core/delegate.ts).
 */
const INHERITED_LINK_ENV = ["AGENT_BRIDGE_PARENT_URL", "AGENT_BRIDGE_PARENT_TOKEN", "AGENT_BRIDGE_PARENT_NAME", "AGENT_BRIDGE_DELEGATE_DEPTH", "AGENT_BRIDGE_PARENT_JOB", "AGENT_BRIDGE_ROOT_SESSION", "AGENT_BRIDGE_ROOT_NAME", "AGENT_BRIDGE_MAX_DELEGATE_DEPTH"];

for (const name of [...INHERITED_LINK_ENV, "AGENT_BRIDGE_INTERNAL"]) delete process.env[name];

// Background indexing in tests must never inspect or mirror the owner's real CLI stores.
const transcriptRoot=join(import.meta.dirname,"../.agent-bridge-test/empty-cli-stores");
process.env.CLAUDE_CONFIG_DIR=join(transcriptRoot,"claude");
process.env.CODEX_HOME=join(transcriptRoot,"codex");
process.env.XDG_DATA_HOME=join(transcriptRoot,"data");
process.env.ANTIGRAVITY_CLI_HOME=join(transcriptRoot,"antigravity");
