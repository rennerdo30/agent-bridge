# Native T3 Bridge injection contract (AB-458, proposed)

Status: parent selected the gated per-server design on 2026-10-22 JST. This is a design and disabled upstream patch artifact, not native acceptance. Bridge base and supplied clean worktree HEAD were `70820a0fd090bd12f8245e9cf7e51db13a78eef0`. No production Bridge changes are proposed initially.

## Recommendation

T3 should deliberately project the current app-thread transport into the environment of one trusted, explicitly registered **local stdio Bridge MCP server**. Bridge can then use its existing transport detection and reduced profile. Do not export transport into the Codex app-server environment, provider-instance environment, shell environment policy, Claude query environment, global environment, or unrelated MCP servers. Do not discover transport by reading native configuration, credentials, databases, logs, process arguments, or session stores.

Keep the integration default-off. The artifact's `CODEX_NATIVE_BRIDGE_MCP_ENABLED = false` is deliberately not a user setting. An enablement change requires independent evidence for both native-child isolation and non-persistence on the exact supported Codex build. A trusted server-registration mechanism and merge/launch tests are also prerequisites. If either principal gate fails, use the proxy contract below; do not weaken the gates.

## Source evidence

All T3 references below use [upstream commit 968dd51704441138559a3fe9c348719f2b11e0c6](https://github.com/pingdotgg/t3code/tree/968dd51704441138559a3fe9c348719f2b11e0c6). The supplied four snapshots and additionally fetched session type/package manifest match that commit's Git blob IDs; the local artifact contains `provenance.json`.

- [CodexAdapterV2.ts:1332-1364](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1332): `codexThreadRuntimeParams` overrides only `mcp_servers.t3-code`, with inline `url` and `http_headers.Authorization`. It preserves launch-argument MCP servers. Call sites cover start (6614), resume (6651), rollback reload (7391), and fork using the target app thread (7443). This is the appropriate thread-scoped projection boundary.
- [ClaudeAdapterV2.ts:902-957](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L902): MCP registration uses the stdin control channel to avoid headers in argv and the environment inherited by shell commands. `claudeMcpQueryOverrides` at 1474-1505 supplies the HTTP configuration. Preserve that boundary; this package does not implement Claude injection.
- [McpProviderSessions.ts:93-123](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/packages/provider-core/src/server/McpProviderSessions.ts#L93): T3 owns the in-memory session map, keyed by app thread. [mcpSession.ts:3-19](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/packages/provider-core/src/server/mcpSession.ts#L3) carries environment, thread, provider instance, credential session, endpoint and header. Bridge must receive this projection from T3, not reconstruct it.
- [ProviderSessionManager.ts:435-510](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L435): preparation is serialized per thread, reserves credentials against racing release, reuses a valid matching credential, otherwise revokes/reissues, and conditionally clears only the matching credential. Plain detach intentionally need not revoke (2446-2451). Do not replace this with unconditional rotation or thread-wide cleanup by an obsolete runtime.
- [McpSessionRegistry.ts:98-191](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/apps/server/src/mcp/McpSessionRegistry.ts#L98): issuance binds environment/thread/provider instance and generates a credential-specific `providerSessionId` and request namespace. The default liveness window is 24 hours (67). Both `resolve` and `touch` update `lastAliveAt` in the implementation (142-171); this does not prove an absolute maximum lifetime. A nearby comment and the orchestration document describe different behavior. Revocation exists by credential session, thread and registry shutdown.
- [McpHttpServer.ts:157-189](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/apps/server/src/mcp/McpHttpServer.ts#L157): requests authenticate through the registry. Rejected provider tokens receive 401 without an OAuth upgrade path. Revocation must apply to every subsequent Bridge call.
- [orchestrator-mcp-server.md:63-78](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/docs/orchestration-v2/orchestrator-mcp-server.md#L63) still describes CLI overrides plus `T3_MCP_BEARER_TOKEN`. It is stale relative to the pinned Codex adapter. Do not use it as a runtime injection recipe.

[Official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) documents stdio server `env` separately from HTTP server headers. This supports the proposed destination, but does not prove thread-override persistence, deep merge, process reuse or native-child behavior in a particular Codex binary.

## Proposed injection boundary

1. A trusted T3 integration registration identifies the exact Bridge stdio server ID and its approved local executable/arguments. Default: absent. Do not infer identity from a process title, tool inventory, executable basename, or a configurable server name alone. Do not enumerate native configuration to find credentials. The disabled patch introduces only an optional server ID on the existing in-memory session record; **no producer or registration UI is implemented**.
2. Verify that the registered server is local stdio, belongs to this app thread/provider instance, and is not a shared broker, detached runner, remote executor or unrelated MCP server. An owner-approved explicit registration is required; supplying a string ID is not itself identity verification.
3. After the existing session manager prepares the current credential, the adapter emits only these runtime config leaves, using that same session record:

   ```text
   mcp_servers.<registered-id>.env.T3_ACP_MCP_ENDPOINT
   mcp_servers.<registered-id>.env.T3_ACP_MCP_AUTHORIZATION
   ```

   The authorization value is a runtime projection, never a literal checked into source or a command argument. Do not introduce a new credential parser, refresh file, bearer-token environment export, or native-config readback. The exact Codex build must prove that these leaves merge without replacing command, args, unrelated env or tool permissions.
4. Preserve existing host/profile selectors, including explicit `off`/`native`, and every Bridge ownership/depth guard. Bridge's current `t3TransportFromEnv` negotiates the capability and current-thread binding before registration; malformed/partial/refused transport fails closed. Native IDs are not T3 IDs. Keep main-thread lineage admission in `src/mcp/codex-lineage.ts` and `src/mcp/server.ts`; transport injection grants no child attestation.
5. Redact both injected transport keys in T3 protocol diagnostics, including dotted keys. The artifact adds endpoint redaction and extends the existing logger fixture; authorization already matches the existing sensitive-key rule. Never print or query real runtime config to verify redaction.

## Children, rotation and revocation

Bridge already strips host/profile selectors and all case variants of `T3_ACP_MCP_*` at ordinary child, job and daemon environment boundaries (`src/core/job-environment.ts`, `delegate.ts:467`, `daemon-launcher.ts:53`). Explicit extra env is cleaned too. Retain these rules. This cleanup does not prove that Codex strips inherited **MCP configuration** from its own native children.

T3-owned child threads must prepare their own session record before projection; they must never copy the parent's header. Fork uses the target app-thread record. Native provider children, including fresh, history-forked, resumed and nested children, must not receive usable parent transport in a newly started MCP process or cloned config. Shared MCP access still requires the existing native-caller guard; do not substitute a shared MCP session ID for caller identity.

On detach/reattach, retain a valid matching credential under the existing reservation protocol. On replacement, policy/provider change, expiry or explicit revocation, stop old Bridge transport and replace/restart the exact owned MCP process with the new deliberate projection before its next operation. The existing Bridge `T3Host` holds a fixed config; it has no automatic native-config refresh channel. Runtime overrides alone do not prove a running stdio process was refreshed. Never fall back to ordinary native routing after a host refusal.

An obsolete runtime must not revoke a replacement runtime's credential. Follow `mcpCredentialId`, not a thread-wide teardown shortcut. Bridge's frontend digest is based on endpoint/thread/provider, not the credential generation; it is not revocation proof. Registry request namespaces change on reissuance, so do not replay an uncertain write into a new namespace on the assumption that the same client request ID deduplicates across generations. Preserve Bridge wake-journal unknown/submitted receipts and reconcile them before any explicit retry. Do not erase or regenerate those records on restart.

## Enablement gates and current verdict

**Child isolation: not satisfied.** A bounded source audit inspected official Codex tag `rust-v0.156.0`, peeled commit `fe74a774532af67b5a4a3dec03ce9469e17f89af`; this is a source comparator, not a claim about the installed binary. [child_config.rs:104-157](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/core/src/agent/child_config.rs#L104) builds spawn and resume configs from the effective parent config and clones it at 132-133. That helper contains no MCP scrub. `prepare_agent_spawn_config` serves V1 and V2. Thus server-specific env does not establish child isolation; later runtime restrictions were not exhaustively proven. Require an upstream child-config exclusion/attested launch boundary and regression tests, or select the proxy fallback.

**Non-persistence: unproven.** At the same Codex comparator pin, [thread_processor.rs:1339-1341](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/app-server/src/request_processors/thread_processor.rs#L1339) loads request config through `ConfigManager`. [config_manager.rs:355-395](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/app-server/src/config_manager.rs#L355) merges request values into config-builder overrides; the inspected method does not write them. [persisted_resume_settings.rs:8-12](https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/app-server/src/request_processors/persisted_resume_settings.rs#L8) contains approval settings, not MCP env. These observations do not exclude persistence or disclosure elsewhere: config layers/readbacks, rollouts, thread storage, traces, crash reports, replay recorders or other diagnostics. Do not call these gates passed.

Reproducible non-secret gate checks for the follow-on package:

- Use synthetic canary transport in isolated temporary storage and fake child/MCP spawners. Exercise start, resume, rollback reload, target-thread fork, provider/policy replacement and concurrent release. Assert the exact stdio launch env and no canary in provider/shell/unrelated-server env, argv, durable outputs or responses. Cover dotted/nested override merge and mixed-case env collisions on Windows; abort rather than retain an ambiguous transport.
- For native V1/V2 fresh/history-fork/resume/nested children, inspect fixture configs and mocked spawn inputs. Assert absence of parent transport, including inherited `mcp_servers` maps and dotted overrides, not merely the process environment. A child with deliberate T3 registration must use its own credential. Prove shared MCP calls with child/unknown metadata still fail existing Bridge admission.
- Use fake registry time and mocked HTTP/spawn boundaries to prove reuse, expiry, touch, explicit revoke, replacement and stale-release races. Assert an old credential cannot authenticate, a running stale Bridge process cannot continue, and an uncertain operation is not automatically retried across credential namespaces.
- Audit every persistence/diagnostic sink in the **exact supported Codex revision**, then search only fresh synthetic output files for canaries. Do not scan existing owner stores, credential files or runtime configuration. Any real app-server acceptance belongs to a separately authorized upstream/CI environment, never an unapproved local provider launch.

## Exact patch artifact and smallest follow-on package

Local artifact directory: `E:/AgentData/reports/ab458-native-contract-20261022-t32af0942b`.

`t3-native-bridge-gated.patch` SHA-256: `E02C37A288D221A54B53CC2D381CE12C672917BC054A9A5A9F543A46C410210C`. It applies to the pinned T3 source and contains exactly:

- `packages/provider-core/src/server/mcpSession.ts`: optional trusted registration ID, absent by default.
- `packages/provider-core/src/server/nativeBridgeMcp.ts`: pure, default-off projection into two named-server env leaves, bounded validation and sanitized refusal.
- `packages/provider-core/src/server/nativeBridgeMcp.test.ts`: seven projection fixtures.
- `packages/provider-core/package.json`: the helper's explicit package export.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: shared runtime projection call with a hard-disabled switch, plus endpoint-key redaction.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts`: logger fixture for the scoped transport keys.

The smallest next implementation package starts with these six files, then adds the trusted registration producer at `apps/server/src/orchestration-v2/ProviderSessionManager.ts` with its focused test file. The parent must choose the existing app-owned registration/settings boundary; no credentials or native config are to be imported. Preserve reservations, matching-credential cleanup and target-thread lookup. Correct the stale injection/lifetime text in `docs/orchestration-v2/orchestrator-mcp-server.md`. Add registry/lifecycle fixtures in `apps/server/src/mcp/McpSessionRegistry.test.ts` and `ProviderSessionManager.test.ts` only where meaningful new behavior requires them.

Native-child fixes, if required in Codex, start at `codex-rs/core/src/agent/child_config.rs` and the V1/V2 spawn/resume tests; account for `Config.mcp_servers` and retained config layers. Persistence findings determine any additional Codex files; this audit does not guess an exhaustive patch fence. Keep upstream code changes in an isolated upstream checkout, never installed T3. No Bridge production change is needed merely to consume the deliberate two-field projection. If an app-owned refresh/epoch protocol is needed, that is a separate parent-approved contract change.

## Verification receipt

`verify-artifact.ps1` regenerates the patch from pinned snapshots and runs only seven pure projection checks. It uses existing Node, one test worker, 15-second process deadlines, records every child PID and closes only its own timed-out processes. It makes no network, provider or Bridge calls. Run from PowerShell:

```powershell
& 'E:/AgentData/reports/ab458-native-contract-20261022-t32af0942b/verify-artifact.ps1'
```

`verification-v3.log` starts with the Bridge base and T3 pin. Preparation PID 79108 exited 0; its `git diff --no-index` PID 68836 exited 1 (expected differences), and `git apply --check` PID 48752 exited 0. Projection PID 26088 passed 7/7, exit 0. Deliberately replacing the enabled path with an empty result made PID 56488 fail 4/7, exit 1 as expected. Every child deadline was 15 seconds. The earlier receipt is retained separately; v3 is the final artifact receipt. Public source fetches used 20-second request timeouts and no provider process.

Not run: upstream TypeScript/package build, upstream logger test, Codex child-isolation/persistence tests, native T3 smoke, installed update, cross-PC delivery and full suites. The seven projection fixtures prove the artifact helper's output/refusals, not Codex merge semantics, launch inheritance, credential rotation or either enablement gate. Parent review and hosted CI remain required before integration.

## Proxy fallback contract (design only)

If Codex cannot provide ephemeral, child-isolated stdio injection, T3 should own the Bridge connection/process and a scoped proxy. Keep the orchestration credential in the app-owned session service; the provider receives no new Bridge credential or credential lookup handle. Authenticate and bind every proxy invocation to the current environment/app-thread/provider/credential generation, preserve native caller metadata and existing Bridge ownership/depth admission, expose only the approved tool surface, bound requests, redact diagnostics, and revoke/close only that session's owned resources. T3 children require new scopes; native children cannot borrow a parent's authenticated Bridge route without existing caller attestation. Reuse the session manager lifecycle and retain uncertain-write receipts across rotation. This is an upstream design fallback, not permission to launch a daemon or implement a new shared MCP bypass.
