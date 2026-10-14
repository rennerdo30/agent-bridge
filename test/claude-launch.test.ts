import { expect, it } from "vitest";
import { cmdlineIsClaude, cmdlineIsPrintMode } from "../src/core/procinfo.js";

it.each([
  ['"D:/Tools/claude.exe" --permission-mode plan', true, false],
  ['node "D:/Tools/node_modules/@anthropic-ai/claude-code/cli.js" --permission-mode plan', true, false],
  ['node "D:/Tools/node_modules/@anthropic-ai/claude-code/cli.js" -p "task"', true, true],
  ['node "D:/Tools/node_modules/@anthropic-ai/claude-code/cli.js" --print', true, true],
  ['node D:/agent-bridge/dist/cli.mjs mcp claude', false, false],
  ['node D:/agent-bridge/dist/cli.mjs "D:/Tools/node_modules/@anthropic-ai/claude-code/cli.js"', false, false],
  ['node D:/other-tool.js "claude -p"', false, true],
  ['powershell -Command "claude"', false, false],
] as const)("classifies launch %s", (line, claude, print) => {
  expect(cmdlineIsClaude(line)).toBe(claude);
  expect(cmdlineIsPrintMode(line)).toBe(print);
});
