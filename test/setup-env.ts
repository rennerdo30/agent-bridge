import { vi } from "vitest";
import { join } from "node:path";
import { realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { testFixtureRoot } from "../scripts/test-fixture-root.mjs";
// Census of in-process SQLite handles for cleanup diagnostics, opt-in (AB-255).
import { trackOpenDatabases } from "./open-db-tracker.js";
if (process.env.AB_TRACK_DB === "1") trackOpenDatabases();
const fixtureRoot = testFixtureRoot();
process.env.AGENT_BRIDGE_HOME = join(fixtureRoot, "default-home");
delete process.env.AGENT_BRIDGE_PIPE;
// Cover every generated checkout fixture, including ones outside the temporary subfolder.
process.env.GIT_CEILING_DIRECTORIES = fixtureRoot;

// macOS exposes its temporary root through /var -> /private/var. Fixtures use
// the physical directory so immutable plugin tests retain strict link rejection.
{
  const fixtureTemp = join(fixtureRoot, "temp");
  mkdirSync(fixtureTemp, { recursive: true });
  process.env.TEMP = fixtureTemp;
  process.env.TMP = fixtureTemp;
  process.env.TMPDIR = fixtureTemp;
  // Empty fixtures must not discover the containing source checkout as their repository.
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
const INHERITED_LINK_ENV = ["AGENT_BRIDGE_PARENT_URL", "AGENT_BRIDGE_PARENT_TOKEN", "AGENT_BRIDGE_PARENT_NAME", "AGENT_BRIDGE_DELEGATE_DEPTH", "AGENT_BRIDGE_JOB_ID", "AGENT_BRIDGE_PARENT_JOB", "AGENT_BRIDGE_ROOT_SESSION", "AGENT_BRIDGE_ROOT_NAME", "AGENT_BRIDGE_MAX_DELEGATE_DEPTH"];

for (const name of [...INHERITED_LINK_ENV, "AGENT_BRIDGE_INTERNAL"]) delete process.env[name];

// Background indexing in tests must never inspect or mirror the owner's real CLI stores.
const transcriptRoot=join(fixtureRoot,"empty-cli-stores");
process.env.CLAUDE_CONFIG_DIR=join(transcriptRoot,"claude");
process.env.CODEX_HOME=join(transcriptRoot,"codex");
process.env.XDG_DATA_HOME=join(transcriptRoot,"data");
process.env.ANTIGRAVITY_CLI_HOME=join(transcriptRoot,"antigravity");
