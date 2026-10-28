# Opencode tool exposure review

AB-271 follow-up, 2026-10-11. Compared branch `agent-bridge/5d7b235e` at
`a4376c87` with main `40fbf0a4`. No source exposure regression was introduced by
the mobile or dependency commits.

## Commit trace

- `git log -S 'return [...CODING_AGENTS]' -- src/mcp/server.ts` identifies
  `e39c483548dd4bb4b73ae21df9981ac58927e4e6`, “Fix Codex hook activity ownership
  and enable any-to-any delegation (AB-269, AB-270)”. It intentionally replaces
  caller filtering with all four coding CLIs, including self-delegation.
- The same commit adds `test/delegation-targets.test.ts` checks for all four caller
  inventories and configured depth rejection, and updates bundled end-to-end checks.
- `a679e53746640c04094070730fb8a29558e1e985` packages the behavior into plugin
  distributions. It is the common ancestor of this branch and main `40fbf0a4`.
  Both bundled opencode workers return all coding agents in `delegationTargets`.
- `src/mcp/targets.ts` and `src/opencode/plugin.ts` are identical between the two
  heads. Those compared versions register per-agent delegation tools in
  `src/mcp/server.ts`. The plugin consumes `mcp.listTools()`, hides
  `hook_event`, and exposes the remaining names with the `bridge_` prefix.
- Main passes because `962236f8f26a9bda13bcce941b84531a46a530d1`, “test: expect
  universal delegation in opencode native tools”, corrects the outdated test.
  This branch did not contain that correction. Its assertion prohibited every
  name containing `opencode`, contradicting the intentional AB-270 contract.

The supervisor approved applying exactly main's assertion after receiving these
findings. That test checked the then-eight per-agent delegation names
for Claude, Codex, opencode and Antigravity; AB-462 now consolidates them. It retains the hidden-hook check.
No source, delegation guard, plugin distribution, dependency or permission change
is part of this follow-up. `git diff 962236f8 -- test/opencode.test.ts` is empty.

## Verification

- Isolated `node scripts/test.mjs all test/opencode.test.ts`: 12/12 pass, 13.85 seconds.
- One `npm run test:all` rerun: 287 files pass / 1 fails; 2,138 tests pass /
  1 fails / 3 skipped (2,142 total), 2,171.38 seconds. Opencode, retention and
  takeover no longer fail. The sole failure is
  `test/split-bundles.test.ts:17`, “indexes new messages through the compiled
  split-bundle background worker”. Its line 25 polls for one search hit with a
  ten-second deadline; the failed test took 11,447 ms. It passed in the earlier
  full suite. The exact failure cause remains unconfirmed.
- One isolated split-bundles rerun: 2/2 pass, 5.66 seconds. This is an intermittent
  indexing/startup timing failure candidate, not a clean full-suite result. No
  test timeout, source or compiled worker was changed, and the full suite was
  not repeated a second time. Full failure assertion text was obscured by the
  existing PowerShell fixture stderr/CLIXML parsing issue; the named failed test
  and final counts are intact in the retained local log.
- Generated dist is not committed; release builds it from the locked dependencies.
