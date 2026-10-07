# Google agent CLIs

Verified 2026-10-07 using official documentation and local command probes.

## Which CLI is supported

**Antigravity CLI is installed as `agy`, currently version 1.3.1.** Initial
research and authenticated integration probes used 1.2.0; a subsequent
read-only version probe on the same day found 1.3.1. `where gemini` and
`where antigravity` returned no matches; `where agy` found the executable.
`npm list -g --depth=0` contained Codex and opencode only. `agy models` worked.
The bridge agent name is `antigravity`; tools are `ask_antigravity` and
`spawn_antigravity`. These run `agy`, not an assumed `antigravity` binary.

**Gemini CLI is a different product**, distributed as `@google/gemini-cli`,
command `gemini`. The npm stable registry returned 0.63.0. It is absent here,
so this release documents it without claiming tested Gemini CLI support.
Package evidence: [`@google/gemini-cli` stable metadata](https://registry.npmjs.org/@google%2Fgemini-cli/latest).

## Antigravity evidence and mapping

- [Installation and authentication](https://www.antigravity.google/docs/cli/install/):
  CLI credentials are cached; noninteractive runs require prior authentication.
  The bridge never enters credentials or reads credential contents.
- [Headless reference](https://www.antigravity.google/docs/cli/headless/):
  `-p`, `--output-format json|stream-json`, `conversation_id`, `--conversation`,
  `--continue`, `--model`, `--effort low|medium|high|xhigh|max`, `--sandbox`, and
  `--dangerously-skip-permissions` are available. Installed `agy --help` confirms
  these flags, plus `--mode plan|accept-edits` and streaming stdin.
- The same headless reference documents `init`, `step_update`, and `result`
  envelopes. Result status must be SUCCESS; process exit zero alone does not
  prove success. Token usage is cumulative across turns. Streaming stdin queues
  turns; it does not promise mid-generation steering of an interactive TUI.
- [MCP](https://antigravity.google/docs/mcp?tab=cli): stdio configuration uses
  `mcpServers`, `command`, `args`, `env`; global config is
  `~/.gemini/config/mcp_config.json`, workspace config `.agents/mcp_config.json`.
- [Plugins](https://www.antigravity.google/docs/plugins?tab=cli): `plugin.json`,
  `mcp_config.json`, `hooks.json`, skills and rules; CLI stages plugins under
  `~/.gemini/antigravity-cli/plugins`. `agy plugin install <directory>` and
  `agy plugin list` exist locally. The documented plugin manifest schema has
  no version field: bridge package metadata carries the release version.
- [Lifecycle hooks](https://antigravity.google/docs/hooks): PreInvocation can
  inject ephemeral context, PreToolUse gates tools, Stop can continue with a
  reason. Hook payloads expose conversationId, workspacePaths, modelName and
  transcriptPath. Mail is injected at the next model invocation or stopping
  boundary. There is no documented external programmatic idle-TUI send command;
  idle messages remain queued for the next turn or explicit inbox call.
- [Permissions](https://antigravity.google/docs/permissions?tab=cli): workspace
  writes may be implicitly allowed. Consequently bridge read/ask modes need a
  PreToolUse gate, not merely omission of the skip-permissions flag. `read`
  denies non-reading tools; `ask` relays them to the existing bridge approval
  channel. `edit` retains native policy. Explicit auto approval is opt-in.
  The terminal sandbox is separate from tool permissions and platform dependent.
  `bypass_permissions: true|false` is the exact bridge override for native
  bypass/native approval policy; either value replaces generic read/ask access.
- [Quotas](https://antigravity.google/docs/cli/commands/usage): `/usage` or
  `/quota` is interactive. The installed help offers no machine-readable quota
  subcommand. The bridge reports unknown account limits, with the native command
  to inspect them, and does not turn that into a model call.
- Native logs were observed under
  `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl`.
  Hook docs define this path. Native conversation SQLite databases also exist
  under `conversations`; they are left untouched. JSONL records observed have
  `step_index`, `type`, `status`, `created_at`, `content` or `tool_calls`.
  Child conversation links are read only from explicit subagent records.
- [Native subagents](https://antigravity.google/docs/subagents?tab=cli):
  `invoke_subagent` creates independent conversations; native messages can wake
  idle children internally. That does not expose an external idle bridge wake.
  Native children inherit workspace permissions and retain JSONL history.

## Gemini CLI differences (documented, not implemented here)

- [Headless](https://geminicli.com/docs/cli/headless/): `gemini -p`, JSON response
  with stats, or stream-json events named init/message/tool_use/tool_result/result.
  This is different from Antigravity's envelope protocol.
- [Sessions](https://geminicli.com/docs/cli/session-management/): `--resume <uuid>`,
  storage `~/.gemini/tmp/<project_hash>/chats/`; native retention defaults apply.
  The bridge does not modify those policies or delete native sessions.
- [Extensions](https://geminicli.com/docs/extensions/) and
  [hooks](https://geminicli.com/docs/hooks/): Gemini extensions bundle MCP,
  prompts, hooks and subagents; `gemini extensions install` is its installer.
- [MCP configuration](https://geminicli.com/docs/tools/mcp-server/): settings.json
  MCP configuration is separate from Antigravity's configuration above.
- [Configuration reference](https://geminicli.com/docs/reference/configuration/):
  user MCP settings are in `~/.gemini/settings.json`, with project overrides in
  `.gemini/settings.json`. `--model` selects the model; `--approval-mode` accepts
  default, auto_edit, yolo and experimental plan. `--sandbox` enables sandboxing;
  `GEMINI_SANDBOX` can select Docker or Podman. These are separate from agy's
  permission modes and effort flags; this integration does not infer compatibility.
- [Sandboxing](https://geminicli.com/docs/cli/sandbox/) and
  [command reference](https://geminicli.com/docs/reference/commands/): model
  selection, approval/plan modes and sandbox options must be mapped separately.
- [Quota and pricing](https://geminicli.com/docs/resources/quota-and-pricing/):
  limits depend on authentication and plan; never infer another CLI's quota.

## Live probe

The official [changelog](https://antigravity.google/docs/changelog?tab=cli)
lists CLI **1.2.14** and desktop Antigravity **2.19.1**, both dated September 30,
2026. That fetched changelog currently trails the local **agy 1.3.1** version;
the version observations are recorded separately rather than assuming they agree.
This integration does not upgrade Google's CLI or assume the desktop supplies `gemini`.

The installed 1.3.1 help retains the researched stream, resume, model, effort,
sandbox, approval and plugin flags. It also exposes `--remote-control` and
`remote-control start|status|stop`. Official [Remote Control documentation](https://antigravity.google/docs/remote-control?tab=cli)
describes live desktop/web UI access through an authenticated reverse tunnel,
including prompts and approvals. It does not document a local programmatic send
API. The bridge therefore uses native lifecycle hooks and inbox fallback rather
than starting a daemon or reverse tunnel. No remote service was started.

Authenticated installed `agy 1.2.0` completed a trivial no-tools prompt using
`gemini-3.8-flash-low`, stream-json, 30-second print timeout: SUCCESS,
`BRIDGE_SMOKE_OK`, conversation `daed32da-07dd-4755-8ff5-28ac71e7f366`.
This proves native headless authentication/output, not every bridge integration.
All automated tests mock the CLI and make no paid API calls.

After the installed CLI changed, `agy 1.3.1` also completed the no-tools
`BRIDGE_SMOKE_131_OK` prompt with SUCCESS using the same model and stream flags;
conversation `2add015b-fc6c-46c0-8e5f-3809bef43dbc`. Its bridge home was isolated
from other sessions. The earlier permission-gate smoke remains versioned below.

## Installed-plugin verification

The native CLI validates the generated manifest, skill, MCP server and hook group.
The first installed smoke revealed that plugin MCP names are prefixed: the
server is `agent-bridge_agent-bridge`. Windows 1.2.0 also mishandles quoted hook
executable paths; encoded PowerShell preserves the executable, CLI path and JSON
stdin (including spaces, apostrophes and Unicode).

Native 1.2.0 still auto-denies headless permissions after hook allow, including
per-call permissionOverrides. Restricted delegation uses the native skip switch
with the installed PreToolUse gate enforcing every tool first. Unknown tools
deny; read permits reading/coordination, while ask forwards other tool calls to
the supervisor. A live `peers` call succeeded and an attempted test-file write
was explicitly denied by this gate; the file was not created. Conversation:
`5c5b38c8-83b1-45bb-aaa3-71abfa908879`, SUCCESS, about 22.4 seconds.

The same installed-plugin gate was rechecked after the local update to **agy
1.3.1**: native `peers` succeeded, `write_to_file` was denied by the PreToolUse
hook with the native skip switch present, and the target test file remained
absent. Conversation `4dfce6f7-f928-44de-8408-6a686a56f2e4`, SUCCESS. This probe
used a separate bridge home and found no other peers. Malformed delegated hook
input also fails closed in read, ask and edit modes so handoff restrictions
cannot be waived by an unreadable gate.

The bridge's explicit manual `smoke antigravity` command also passed on 1.3.1:
answer correct, session ID present, and resumed answer correct. This runs the
actual adapter with streaming JSON stdin (rather than a separate `--print`
invocation), validating its flags, parsing and `--conversation` continuation.

Installer adds only `mcp(agent-bridge_agent-bridge/*)` to native
`~/.gemini/antigravity-cli/settings.json`, preserving all other settings and
backing up replaced content. Native edit permissions otherwise remain in force;
headless native approvals may still deny commands. Uninstall retains this MCP
rule and archives plugin files rather than deleting settings or transcripts.

Native child metadata is supported when explicit conversation IDs are present.
The verified sessions had no native children. Every native child JSONL source
is independently discoverable for durable history indexing; parent/child
dashboard linking depends on the CLI exposing those explicit IDs.
