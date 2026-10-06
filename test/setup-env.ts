import { DELEGATE_DEPTH_ENV } from "../src/core/delegate.js";
import { PARENT_NAME_ENV, PARENT_TOKEN_ENV, PARENT_URL_ENV } from "../src/core/parent-link.js";

/**
 * When the suite runs inside an agent-bridge subagent, these point at that subagent's real parent session:
 * fake subagents started by the tests would then message it ("ping from opencode"). Tests start clean.
 */
for (const name of [PARENT_URL_ENV, PARENT_TOKEN_ENV, PARENT_NAME_ENV, DELEGATE_DEPTH_ENV]) delete process.env[name];
