# AB-316 native tool boundary evidence

Checked on Windows, 2026-10-15, with installed `opencode v2.0.29`.
Starting base after `git fetch origin`: `a185c5787dbbab50698c06cf7c1f098a14c78a25`;
the delegated worktree HEAD equalled `origin/main` before implementation.

## Baseline reachability

All probes used generated Git repositories, isolated HOME/XDG directories, a
loopback deterministic OpenAI-compatible provider, and a recording native plugin.
No external model, credentials, existing user session, or live cleanup was used.
The provider emitted `execute` calls which explicitly attempted all four tools
via `tools.opencode[name](input)`. The native inventory included:

- `opencode_worktree_create`
- `opencode_worktree_remove` (`force: true` attempted)
- `opencode_session_move`
- `opencode_session_rename`

These tools were in the Code Mode catalog, rather than the top-level model tool
list. The read tool map hid create/move/rename; remove remained callable because
its native permission action is `edit`.

| Access/config | Create | Move | Rename | Forced remove |
| --- | --- | --- | --- | --- |
| Existing read delegate config | Unknown tool | Unknown tool | Unknown tool | Reached native executor; edit approval rejected |
| Existing ask served delegate | Created worktree | Moved current session | Renamed current session | Reached native executor; relay rejected edit approval |

The ask reproduction also used the unchanged `opencode-served.ts` from the base
commit, loaded in an isolated harness with the common process helpers. Its only
approval callback was for removal's native `edit` action. The other three tools
completed without approval. The subsequent model step failed because the move
destination lacked the probe model configuration; the recorded successful native
tool completions and created directory are the reachability evidence, not a claim
that the overall baseline job succeeded.

The native contract independently documents the missing permission actions:
[tools](https://dev.opencode.ai/v2/docs/tools#sessions).
Plugin execution hooks and permission assertions are supplied by the installed
native plugin API, not by a new Bridge broker or wire protocol.

## Fixed boundary

For OpenCode 2.0.27 and later, delegated runs use a private server and a generated
per-run native plugin. Before sending a prompt, Bridge waits for that exact plugin
ID to become active, failing closed if activation fails. The plugin hooks native
execution, including calls nested in Code Mode.

- Read denies create, move, and rename. Its existing edit/bash asks and complete
  tool allowlist remain in place, with all asks rejected by the delegated client.
- Ask requests an explicit decision for every create, move, or rename call. The
  complete input, including a target session if supplied, is the approval resource.
  Native configured allows and saved grants cannot replace that per-call decision.
  Bridge sends `once`, never a saved approval or MCP-server grant.
- Native `worktree_remove` is intentionally unavailable in **all delegated
  modes**, including edit. The supervisor explicitly accepted this conservative
  policy. Worktree cleanup remains with Bridge's ownership and retention checks.
- Editable creation and session tools keep working. Interactive sessions receive
  no injected plugin or configuration. V1 and 2.0.26 keep their existing path.

## Fail-closed follow-up (review P1s)

- Version output is parsed as exactly one SemVer line, prerelease and build
  metadata included. Any suffixed 2.x build (for example `2.0.29-dev+abc123`)
  takes the native-gate path. Unparsable output, several versions, or a major
  version above 2 is unknown: every delegated opencode mode is refused before
  opencode starts. V2 is never selected without the enforcing plugin.
- The gate classifies tool identities. Anything that looks native but is not on
  the known list is denied in read mode and needs a per-call approval in ask
  mode. Removal-like worktree tools are denied in every delegated mode.
  Execute hooks without a string tool identity are refused in every mode. An ask
  call without a session ID or with unserializable input is refused too.
- Plugin setup fails without the permission/tool hook API, or without
  `permission.assert` in ask mode. The plugin writes a contract report: contract
  version, access, registered hooks and native inventory. Before prompting,
  Bridge requires that report. In read/ask mode the inventory must contain all
  four proven identities; otherwise the native API is treated as unknown.

## Validation and limits

`npm run typecheck` passed. Only `test/opencode-native-tools.test.ts` was selected:
18 tests passed, including all four installed-native cases (none skipped).
The native cases are opt-in with `AB316_OPENCODE_BIN` pointing to the installed
CLI executable, then:

```sh
node scripts/test.mjs all test/opencode-native-tools.test.ts
```

The focused file covers direct hook enforcement, serializing the runtime plugin,
activation failure before prompting, pre-native V1/2.0.26 command/config fixtures,
and four real native Code Mode cases: read, ask-denied, ask-approved, and edit.
The ask cases each request four approvals (including two renames), even over a
configured native allow. Read and ask-denied create nothing. Ask-approved and edit
can create/move/rename. Every mode rejects forced removal of a separate, dirty,
unpushed generated Git worktree, preserving its file and registration. Started
CLI PIDs are recorded and checked stopped. Native fixtures and `evidence.json`
are retained under the test fixture root; the test never manually reaps them.

Not verified: native macOS/Linux, actual V1/2.0.26 executables, other native 2.x
versions, owner interactive UI acceptance, or live worktree cleanup. The older
versions have command/config fixture coverage. No CI rerun or release is part of
this change. Production bundles are rebuilt once, in a separate final commit.
