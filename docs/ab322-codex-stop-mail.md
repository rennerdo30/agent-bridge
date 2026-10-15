# AB-322: Codex Stop-hook mail

Research checked on 2026-10-15 against official documentation and the official
`openai/codex` source at `rust-v0.162.0`.

## Supported continuation

The [official Stop-hook documentation](https://developers.openai.com/codex/hooks#stop)
specifies `decision: "block"` with a nonempty `reason` to continue a turn. The
reason becomes the continuation prompt. Command hooks can alternatively exit 2
with the reason on stderr; this also blocks. Neither path offers a replacement
completion label.

The pinned source confirms this:

- [Stop output schema](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/hooks/src/schema.rs):
  `StopCommandOutputWire` has universal output plus `decision` and `reason`.
  Universal fields are `continue`, `stopReason`, `suppressOutput`, and
  `systemMessage`; there is no continuation label field.
- [Stop parser](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/hooks/src/events/stop.rs):
  `parse_completed` makes a block decision with a reason (or exit 2 with stderr)
  `HookRunStatus::Blocked`, and uses that reason for continuation fragments.
  `continue: false` stops instead and takes precedence over block decisions.
- [TUI rendering](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/tui/src/history_cell/hook_cell.rs):
  `HookRunStatus::Blocked` maps to the fixed text `Blocked by hook`.
  `statusMessage` describes a running hook, not a replacement completion label.
- [Background hook documentation](https://developers.openai.com/codex/hooks#run-hooks-in-the-background):
  async informational output cannot control the triggering operation, and
  completion does not start a new turn. It cannot replace Stop wake delivery.

No supported nonblocking Stop continuation or completion-label override was
found. Agent Bridge therefore prefixes Codex Stop continuation reasons with
`agent-bridge: new mail`. Existing message wrappers, instructions, wake admission,
ownership, cancellation, hop limits, note filtering, and receipts stay intact.
Other hosts and other hook events keep their existing text.

## Duplicate finishing notes: separate follow-up

Part B is split out by supervisor decision and waits for PRs #17 and #29.
`BridgeMessage` currently supplies job identity and content, but no durable
job-run generation or content hash. `Jobs.post` and the detached runner reuse
`job-<id>` conversation identities across runs; final reports have a distinct
completion dedupe key. Hook-local body matching cannot prove the requested same
job, generation, and content-hash identity across delivery and replay.

This PR does not suppress messages or change history. The follow-up needs the
broker/node/protocol contract to carry exact event proof, preserve both history
records, and deliver the final report exactly once.
