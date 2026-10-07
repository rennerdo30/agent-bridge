# Nested delegation

`maxDelegateDepth` defaults to 2. `AGENT_BRIDGE_MAX_DELEGATE_DEPTH` overrides the
configuration. Values from 1 through the hard ceiling 3 are accepted. The top
session is depth 0. At the default, its children may start children; depth 2
sessions cannot spawn another generation.

Delegated supervisors expose local `spawn_*`, `ask_*`, `message_subagent` and
`cancel_subagent` tools through a private coordinator. They retain their existing
parent/sibling messaging restrictions. They cannot change the root concurrency
limit or gain independent-session bridge privileges. Nested remote delegation is
outside this contract.

The top session's `max_subagents` budget includes all executing background and
blocking jobs across generations. Cross-process leases count detached runners,
release on completion, cancellation or process death, and renew during long runs.
An initial call at capacity is refused; a continuation can wait for a slot. If a
root budget of 1 already holds the parent, that parent cannot start a child until
the top supervisor raises the budget.

Results and live answers go to the job that started the child. Its hooks, `inbox`
and `wait_for_message` deliver its private child messages. A supervisor's Stop
hook waits for children or asks it to cancel them before ending.

Approvals first go to the direct parent. If the decision requires the owner, that
parent calls `decide(approval_id=<request>, decision="escalate")`. This forwards the
same AB-81 pending request up the parent links; it does not allow or deny it.
Blocking nested `ask_*` calls escalate automatically because the direct parent
cannot answer while blocked. The top supervisor can answer with `decide(approval_id=<request>, decision="allow" or "deny")`; the dashboard answers
the same callback. First answer wins. Timeouts, cancellation and completion deny
and remove unresolved waits. Plain messages remain instructions, even during an approval wait.

New run metadata and `/api/state.runs[]` add these fields:

| Field | Value |
| --- | --- |
| `metadataVersion` | `2`, the additive ancestry contract version |
| `bridgeVersion` | Running bridge package version, for provenance |
| `parentJob` | Optional direct spawner's job name; absent for root children |
| `rootSession` | Stable top-session identity, shared across descendants and follow-ups |

Job records add the same ancestry fields and `rootName`, the root supervisor's
peer name used for pending approval ownership. Pending approval JSON adds optional
`parentJob` and `rootSession`; its existing `owner` identifies the root supervisor.
Older records remain readable with these fields absent. Existing JSON-store
versioning, backups and unknown-field preservation remain in use. No dashboard
page changes are included.

AB-88's `codex-job-b3a1549f` started at 09:37:41 UTC on 2026-10-06; the AB-67 fix
commit `0fa227c` landed at 09:39:10 UTC. The saved Codex stream has a substantive
report at 10:17:45 and a sibling acknowledgement at 10:17:59, both marked
`final_answer` in the same turn. AB-67's completed-answer aggregation retains both
in order. A regression covers these message IDs and report/ack content. The old
run metadata records storage version 1 but no bridge binary version, so its exact
loaded build cannot be established from that metadata alone. Saved logs were read
only; no historical answer or metadata was rewritten.
