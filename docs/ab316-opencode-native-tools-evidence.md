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

## Fail-closed follow-up (review P1s and P2s)

- Version output is parsed as exactly one SemVer line, prerelease and build
  metadata included. Terminal color codes, banner lines and repeated identical
  version lines are tolerated. Unparsable output and several different
  versions are unknown. Every delegated opencode mode is refused before
  opencode starts. V2 is never selected without the enforcing plugin.
- **Accepted limit (supervisor decision):** the native gate is only proven for
  2.0.27 and later 2.0.x releases. Its hooks were observed firing on 2.0.29,
  including suffixed builds such as `2.0.29-dev+abc123`. Everything else that
  may carry native tools is unknown: 2.1 and later, 3.x and later, suffixed
  builds below 2.0.27, and 2.0.27 prereleases. Delegated jobs for those versions
  are refused with a message that agent-bridge needs an update for that opencode
  version. There is no runtime canary. Supporting a new range means repeating
  the native probes below and widening the range in `parseOpencodeVersion`.
- The gate classifies tool identities by exact id and fails closed (review
  follow-up). Only explicitly known identities keep their known treatment:
  `opencode_worktree_remove` is denied in every delegated mode, edit included;
  create, move and rename follow the per-mode rules above; `opencode_worktree_list`
  and `opencode_models` read only and pass. The built-ins of the proven 2.0.29
  inventory, the Code Mode `execute` wrapper and the Bridge routes allowed in
  read-only runs stay under opencode's own permission rules. Every other id needs
  a per-call gate approval (`native.opencode.<tool>`) in read, ask and edit
  alike: later native tools, renamed removals such as `opencode_worktree_rm` or
  `remove_checkout`, unrelated MCP tools such as `worktree_status`, and
  `opencode_list_mcp_resources`/`opencode_read_mcp_resource`, which forward to
  configured MCP servers whose side effects the gate cannot see. Without
  `permission.assert` such a call is refused. No substring rule grants or
  denies anything. Execute hooks without a string tool identity are refused in
  every mode. An approval call without a session ID or with unserializable
  input is refused too.
- Plugin setup fails without the permission/tool hook API, or without
  `permission.assert` in ask mode. The generated `index.js` embeds a random
  per-job nonce. The plugin writes a contract report: contract version, access,
  registered hooks, native inventory and that nonce. Before prompting, Bridge
  requires a report with the matching nonce. In every mode, edit included, the
  inventory must contain all four proven identities. Otherwise the native API is
  treated as unknown. Extra inventory ids are accepted but never trusted as
  safe: they classify as unknown, so each call is gated. The report proves the hooks were registered. That they
  fire is proven only by the native probes for the accepted range above.
- `src/core/history-answer.ts` runs opencode without this gate. It relies on
  `permission: { "*": "deny" }` and `tools: { "*": false }`, so no tool,
  native or otherwise, is available to it.

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
CLI PIDs are recorded and checked stopped. A fifth opt-in native case runs a
read-mode job under the gate. Its top-level `read`, `grep` and `glob` calls all
return the fixture file's content. Native fixtures and `evidence.json`
are retained under the test fixture root; the test never manually reaps them.

Not verified: native macOS/Linux, actual V1/2.0.26 executables, other native 2.x
versions, owner interactive UI acceptance, or live worktree cleanup. The older
versions have command/config fixture coverage. No CI rerun or release is part of
this change. Production bundles are rebuilt once, in a separate final commit.
