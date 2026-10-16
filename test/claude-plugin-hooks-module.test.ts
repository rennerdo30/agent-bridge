import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const hooksDir = join(import.meta.dirname, "..", "plugins", "claude", "hooks");

it("names exactly one hooks module, as Claude Code loads one per plugin and refuses a second", () => {
  // With two entries (./wake.ts, ./mail-scope.ts) Claude Code rejected the plugin's hooks.json, so no
  // agent-bridge hook ran in Claude sessions: no busy/idle, no hook mail, no native-child lifecycle.
  const hooks = JSON.parse(readFileSync(join(hooksDir, "hooks.json"), "utf8")) as { modules?: string[] };
  expect(hooks.modules).toEqual(["./index.ts"]);
});

it("the entry module registers both the wake mod and the mail-scope mod", async () => {
  const modulePath = "../plugins/claude/hooks/index.ts";
  const { register } = await import(modulePath);
  const events: string[] = [];
  register(((event: string) => { events.push(event); }) as never, {} as never);
  // wake.ts hooks session and turn events; mail-scope.ts hooks tool.call.
  expect(events).toEqual(expect.arrayContaining(["session.start", "turn.start", "turn.complete", "tool.call"]));
});
