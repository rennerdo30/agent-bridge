---
title: "Message waits (AB-76)"
---

Use `wait_for_message(mode="notify", reply_to=<sent id>)` once, then keep working or
end the turn. Notification mode returns immediately, saves a one-shot subscription,
and lets existing channel/direct/auto-wake delivery bring the matching message later.
There is no repeated agent call, subscription timer, or message poll.

## Decision

Choose option (a), durable notification waits. Retain the existing bounded blocking
mode for short synchronous calls and consumption receipts. Do not add option (b)'s
unbounded progress-driven call as a default or alternative: it cannot provide the
same session-exit and stdio-reload guarantees.

- Claude Code documents automatic MCP backgrounding as **elapsed time**, default
  120 seconds. Progress resets the separate **idle** timeout, not this elapsed-time
  policy. See [host environment variables](https://code.claude.com/docs/en/env-vars).
- MCP progress is optional and request-scoped: the client must supply a progress
  token. The TypeScript SDK also makes timeout reset a client option and permits a
  total timeout irrespective of progress. See [MCP progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)
  and [SDK request options](https://ts.sdk.modelcontextprotocol.io/v2/api/index/@modelcontextprotocol/client/).
- Therefore progress can improve status reporting but is not evidence that a host
  tolerates an indefinite call. It also cannot restore a request whose transport
  or session has exited. Notify pays one registration turn and only the useful
  arrival turn; a slow peer needs no intermediate model turns.

## Compatibility and lifecycle

| Call | Behavior |
| --- | --- |
| No mode or timeout for incoming mail | Durable notify, no expiry |
| `mode="notify"` | Durable notify; `timeout_sec` ignored |
| `mode="block"` | Synchronous call capped at 110 seconds |
| `timeout_sec` without mode | Legacy blocking behavior |
| Blocking incoming-message timeout | Same saved ID becomes a notification wait |
| `read_receipt_of` | Block only; receipt timeout finishes the check |
| `resume_id` | Saved filters and mode win; optional mode converts the wait |
| `resume_id` with `mode="cancel"` | Archive registration, leave mail unread |
| Nested child waits | Existing block-only private inbox; replies also use hooks |

Saved records predating `mode` remain blocking and retain their existing `resume_id`
behavior. A notification's ownership follows the session ID, with peer-name fallback
before the host supplies one. Replacement servers load subscriptions from the same
atomic-record store; no live MCP call or per-subscription listener needs recovery.
Repeated identical notification registrations reuse their existing ID.
An active channel owns already queued matches too, so the tool does not return and
acknowledge a second copy while a channel notification is in flight.

Only matching filters grant extra wake eligibility. This does not enable global
auto-wake or alter unrelated delivery. The Claude channel and rewake endpoint,
Codex queue, and opencode notification/Stop path keep their existing host behavior.
An armed wait lets a turn end without the fallback listen window. Quiet status
messages, notes and the hop limit still do not wake agents; explicit inbox or active
hooks may consume such mail. Reading retained status notes does not complete a notify
wait for the eventual reply. A host without wake support receives it on its next turn.

Registration never acknowledges arriving mail. Wake hand-out leaves it unread and
the subscription armed until delivery confirmation. Lost wake-ups can retry the
same message. Normal consumption through a tool, hook or channel records the durable
read receipt before archiving matching notification registrations. Cancellation also
archives the record and does not touch mail. This change adds no deletion, truncation
or queue-retention policy. Offline sessions retain mail in existing durable storage;
they cannot be woken while the host is absent. Existing storage retention settings
still apply, and subscription durability is not a promise to launch a closed host.

## Verification

Injected short timers cover the blocking-timeout conversion and Codex queue races.
Regression tests cover exact filters, legacy records, session ownership, cancellation,
offline/reload recovery, lost wake retry, receipt compatibility and quiet/hop guards.
The bundled stdio server is also closed and replaced with notification waits armed.
Live Claude `/reload-plugins`, channel/mod behavior and two physical paired PCs remain
separate host acceptance checks.
