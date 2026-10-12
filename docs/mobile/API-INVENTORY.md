# AB-271 Package 1: mobile API inventory and threat model

Source baseline: published **0.30.10**, commit `5fb90d3a34abf58b4f3f17eae17b8a15b0cc4231`. Evidence below refers to that revision, not a running installation. Prepared 2026-10-11 by source inspection only.

V1 is one React Native/Expo application for Android and iOS: session/job overview and live status/steps, dashboard chats, owner questions and answers, and native push for questions. Sending to a session is optional and independently granted. Permission approvals, decisions/pinning, settings, job control and network administration are later scope.

The supervisor's working transport assumption is **private HTTPS, no internet relay in v1**. The owner still decides Tailscale/private VPN versus LAN, certificate provisioning, distribution, and ownership of push credentials. These are proposed contracts, not implemented or approved deployment settings. A future relay must preserve the same DTOs and authorization checks.

## Existing local security boundary

All HTTP routes below inherit the local UI gate (**L**): `src/cli/ui.ts:62-67`, `280-293`, `675`. The UI binds `127.0.0.1`; Host must be `127.0.0.1` or `localhost` after port stripping. `/?t=<home-dashboard-key>` exchanges a shared key for `ab_ui`, an HttpOnly, SameSite=Strict cookie with a one-year Max-Age. Request-time key reload permits global invalidation. There is no per-device grant/revocation or mobile pairing here. The HTTP cookie has no Secure attribute because this endpoint uses loopback HTTP. `src/cli/dashboard-key.ts:7-35` creates a protected 24-byte random key stored as hex, not a credential hash; `src/core/token.ts:53` provides timing-safe comparison.

Write guard **W** adds `x-agent-bridge: 1`; this is a browser cross-site request guard, not a secret. Only the dedicated chat write adds explicit JSON Content-Type, Sec-Fetch-Site and Origin checks. Its Origin is compared to the incoming Host-derived HTTP origin; this is not a provisioned exact HTTPS origin policy for a gateway. These protections must not be copied as mobile authentication.

Broker access **B** uses local IPC with protocol plus the separate home token: `src/cli/ui.ts:95-108`, `227-232`; `src/core/broker.ts:325-328`, `684`, `1268-1270`. Only hello/auth/ping are allowed before authentication (`src/core/broker.ts:110-111`). Owner answers specifically require an authenticated connection without an agent peer (`src/core/broker.ts:182-187`). A connected model cannot answer as the owner.

Keep these boundaries unchanged. A separate gateway must authenticate mobile devices and authorize approved typed operations before invoking a fixed local service adapter. It must never relay arbitrary HTTP paths, broker op names, filesystem paths or user-selected upstream URLs. Local dashboard keys, broker tokens and approval relay capabilities stay on the PC.

## Reusable v1 source operations

Reuse means projecting these services behind a new narrow gateway, not exposing their original routes on the network. Every route has L authentication unless otherwise noted; service functions themselves depend on their caller for authentication.

| Existing endpoint | Source evidence and data | Existing authorization / mobile use |
| --- | --- | --- |
| `GET /api/state` | `src/cli/ui.ts:444-464`: version, broker state/health, classified peers, newest run page, recent bridge messages, saved job settings, paired-PC read results/errors. `src/core/dashboard-read.ts:308-325` classifies peers. | L + B for peers/remote reads; store-backed portions are local reads. Project only granted session/job summaries. Drop recent message bodies, settings, health internals, absolute directories, prompts and worktree metadata from overview. |
| `GET /api/runs?before=&limit=` | UI dispatch `src/cli/ui.ts:559-563`; handler `src/core/dashboard-read.ts:394-399`. `RunSummary` is at `29-52`; progress/ETA comes from `src/core/runfeed.ts:45-51`. | L; same service also serves authenticated paired PCs. Use bounded job/run pages with opaque gateway cursors. Do not infer missing progress as zero or done as successful/accepted. |
| `GET /api/runs/{run}?from=` | Dispatch above; `src/core/dashboard-read.ts:435-458`: bounded UTF-8 log chunk `{text,next,size}`, containment and file-signature checks; recovered run can have `hasLog:false`. | L; gateway maps an authorized job/run ID to the file-backed service. Use plain-text live steps, never accept a filesystem path. Byte offset is not an event cursor. |
| `GET /api/sessions/{name}/chat?from=` | Dispatch above; `src/core/dashboard-read.ts:377-392`: resolves local peer/session and native transcript. `src/core/transcripts/index.ts:10-22`; item/page schemas `src/core/transcripts/common.ts:20-31`. | L; no transcript-level project/device ACL exists. Gateway must authorize the resolved identity before reading. Native cursor may be `tail`, JSONL or opencode-specific; keep it opaque. |
| `GET /api/runs/{run}/chat?from=` | `src/core/dashboard-read.ts:422-433`, same UI dispatch. Resolves job/session transcript when available. | L; use for job chat. There is **no existing `GET /api/jobs/{job}/chat`** route. Missing session ID is 409; missing transcript is 404, not an empty completed chat. |
| `GET /api/sessions/{name}/subagents` and `/subagents/{child}?from=` | `src/core/dashboard-read.ts:377-392`; native-child discovery `src/core/transcripts/index.ts:25-31`, schema `common.ts:32-38`. | L; optional child-chat navigation, only when the child belongs to the granted parent. No direct mobile child-send in v1. |
| `GET /api/jobs/{job}/subagents` and `/subagents/{child}?from=` | `src/core/dashboard-read.ts:401-420`: resolves retained job/run session then native children or child transcript. | L; same parent membership check in the gateway. |
| `GET /api/conversations/{id}?after=&limit=` | `src/cli/ui.ts:327-332`; `src/core/conversations.ts:1235-1275`; query/page schema `src/core/conversation-query.ts:2-34`. Indexed retained dashboard chat is capped at 100 records and 512 KiB. | L; no route-level entity ACL. Optional source fallback for a known granted chat, not a general history browser. Returned records include raw base64, source and generation: parse/project text items; never forward raw records or source paths. |
| `GET /api/approvals` (**questions projection only**) | `src/cli/ui.ts:391-401`: combines permission approvals, open owner questions and delegated job questions; separate `questions` contains all owner-question states. Broker `ownerQuestions` refresh is attempted with retained fallback. | L + B where available; gateway must project **only `kind:"question"` from `questions`**, page/filter it, and explicitly label retained/offline state. Do not export permission or sibling job-question records. V1 introduces a distinct mobile questions resource. |
| `POST /api/questions/{uuid}` | `src/cli/ui.ts:419-431` invokes B `answerOwner`. Answer schema `src/core/owner-questions.ts:38-41` accepts exactly one option/text plus optional pin. Store checks open status/valid option transactionally at `107-116`. | L + W + B; broker rejects agent-peer callers (`src/core/broker.ts:183-187`). Reuse option/text only in v1, stripping/rejecting pin. Answer records and delivery use `src/core/owner-question-service.ts:12`, `37-89`. An answer never substitutes for a permission approval. |
| `POST /api/sessions/{name}/message` (**optional**) | `src/cli/ui.ts:565-608`; validates local connected target, limits body, optional child/parent fields; calls `deliverDashboardChat`, `src/core/dashboard-chat.ts:34-59`. | L + W + JSON + Origin/Sec-Fetch-Site. Local sessions only; paired-PC targets are view-only. Gateway grants exact session generation and body-only input. Codex can queue a native prompt; other cases retain bridge inbox mail. This can cause agent work and is a privileged write. |
| `GET /api/chat-delivery/{uuid}` (**optional send status**) | `src/cli/ui.ts:610-616`: ID must be in an in-memory dashboard receipt set; readAt means CLI hook consumption. Native-prompt path has no such receipt (`src/core/dashboard-chat.ts:42-45`). | L; gateway must independently bind operation/receipt to device and target. Receipt set disappears on UI restart. Consumption is not reply, task completion or owner acceptance. |

Paired-PC inspection is a separate existing trust plane: UI qualified-identity/host routing is `src/cli/ui.ts:235-244`, `537-557`; allowlisted read paths/schema and limits are `src/network/dashboard-protocol.ts:3-30`; authenticated paired-link handling is `src/network/remote-dashboard.ts:11-17`, `43-67`. It excludes owner questions and writes. V1 can display already-authorized paired-host summaries/chats read-only, if explicitly included in a device's PC scope; it does not inherit paired-owner authority or expose PC pairing controls. The service `/api/state` at `src/core/dashboard-read.ts:334-340` contains runs/jobs, whereas local HTTP `/api/state` also adds peers/messages: these shapes are not interchangeable.

Do not reuse generic `POST /api/send` (`src/cli/ui.ts:618-627`) for the phone: it accepts arbitrary addressing and adds only L + W before B/node send. It is too broad for optional send-to-one-session. `SendArgs` already has messageId/dedupe recovery (`src/core/protocol.ts:153-166`), but the HTTP wrappers do not accept a mobile idempotency key. Do not reuse dashboard heartbeat (`src/cli/ui.ts:403-408`) as push delivery: it drives browser/desktop alert arbitration (`src/core/owner-question-service.ts:28-31`, `121-135`), not APNs/FCM.

## Proposed gateway v1 operations

Prefix `/mobile/v1`; JSON over trusted private HTTPS. Unknown routes, fields, duplicate query parameters and content types are rejected. New operations below do not exist at this baseline. Local-only administration is a distinct, authenticated PC surface, inaccessible through the mobile listener.

| Operation | Input / output | Required capability |
| --- | --- | --- |
| `POST /pairing/claims` | QR nonce, platform, bounded device display name -> pending claim ID, one-time claim credential, comparison code, expiry | Expiring QR claim only; no device permissions yet |
| `GET /pairing/claims/{claimId}` | Claim bearer credential -> pending/denied/expired; after PC confirmation, one-time device session issuance | Possession of this claim, not QR nonce alone |
| `POST /auth/refresh` | Current refresh credential + CSRF token -> rotated access/refresh credentials and expiries | Active paired device/session |
| `GET /me` | Device/session IDs, granted PC/project/session scopes, capabilities, expiry, push readiness | Active paired device |
| `DELETE /me/session` | Revoke own credentials/subscription -> 204 | Active paired device |
| `GET /snapshot` | Bounded summaries, open questions, capabilities, collection page cursors, sampled state -> `Snapshot` | `overview.read`, questions filtered by grant |
| `GET /sessions?cursor=&limit=` and `/jobs?cursor=&limit=` | Authorized paged summaries; maximum 100, default 20 | `overview.read` |
| `GET /chats/{chatId}?cursor=&limit=` | Parent-resolved native/indexed chat -> `ChatPage` | `chat.read` for exact parent scope |
| `GET /jobs/{jobId}/steps?cursor=&limit=` | Plain-text bounded log-step page with source generation/reset state | `overview.read` for exact job scope |
| `GET /questions?status=&cursor=&limit=` and `/questions/{id}` | Owner-question list/detail, including answered/cancelled/superseded states | `questions.read` |
| `POST /questions/{id}/answer` | `{expectedVersion, option}` XOR `{expectedVersion, text}` -> question + answer delivery state | `questions.answer` for question project; no pin/decision/approval fields |
| `GET /events?after=` | Authorized resumable foreground event stream; cursor also usable for finite catch-up pages if the RN stream adapter needs them | Same entity read grants as snapshot |
| `PUT /me/push` | `{expoPushToken, platform, projectId, environment}` -> registration status (no token echo) | Active own device + notification opt-in |
| `DELETE /me/push` | Remove own subscription -> 204 | Active own device |
| `GET /notifications/{opaqueId}` | Resolve a push hint to current authorized resource, or gone/revoked | Active own device + current resource grants |
| `POST /sessions/{sessionId}/messages` (**optional**) | `{expectedGeneration, body}` -> `WriteOperation` | `session.send` explicitly granted on PC for this local session |
| `GET /operations/{operationId}` (**optional send**) | Durable operation status, no claim of task completion | Originating device, or explicit PC owner administration |

PC-only administration creates/cancels pairing invitations, confirms/denies claims after comparison, lists paired devices, selects grants and revokes them. It uses authenticated local owner access with exact configured local origin and CSRF protection; a native agent peer is not an owner. No mobile endpoint can approve its own pairing, mint an invitation, grant capabilities, enumerate other devices, manage network settings or revoke another device.

### DTOs and scope

All times are Unix milliseconds; IDs are opaque gateway identifiers, never paths or concatenated `host/name`. A stable PC ID plus resource kind/native identity/generation resolves names safely. Null/missing information stays unknown. Grant changes invalidate cursors and remove newly forbidden entities from cached views.

```ts
type Capability = 'overview.read' | 'chat.read' | 'questions.read'
  | 'questions.answer' | 'session.send'; // last is optional
type Version = string; // opaque equality/precondition token, not a sortable clock
type Cursor = string;  // opaque; bound to scope, kind and source generation
type DeviceSessionIssued = {
  deviceId: string; sessionId: string; pcId: string;
  accessToken: string; refreshToken: string; csrfToken: string;
  accessExpiresAt: number; refreshExpiresAt: number;
  capabilities: Capability[];
  scopes: { pcId: string; projectIds: string[]; sessionIds: string[] }[];
}; // one-time TLS response; never an event, push, log or persisted response cache
type Session = {
  id: string; pcId: string; generation: string; name: string; agent: string;
  projectId: string | null; activity: 'busy' | 'idle' | 'unknown';
  connection: 'connected' | 'offline' | 'unavailable';
  parentId: string | null; chatId: string | null;
  sendSupported: boolean; sampledAt: number; version: Version;
};
type Job = {
  id: string; pcId: string; parentId: string | null; title: string;
  status: 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled' | 'unknown';
  progress: { percent: number | null; note: string | null; at: number | null;
    etaAt: number | null; etaReportedAt: number | null };
  chatId: string | null; hasSteps: boolean; archived: boolean;
  recovered: boolean; sampledAt: number; version: Version;
};
type ChatItem = {
  id: string; kind: 'user' | 'assistant' | 'tool' | 'subagent'; at: number;
  text?: string; tool?: string; summary?: string; childId?: string;
  version: Version; truncated: boolean;
};
type ChatPage = { items: ChatItem[]; next: Cursor | null;
  generation: string; reset: boolean; sampledAt: number; viewCursor: Cursor };
type StepPage = { items: { id: string; text: string; at: number | null }[];
  next: Cursor | null; generation: string; reset: boolean;
  sampledAt: number; viewCursor: Cursor };
type OwnerQuestion = {
  id: string; kind: 'question'; pcId: string; projectId: string;
  title: string; context: string; topic: string;
  options: { id: string; label: string; consequence: string; recommended: boolean }[];
  links: { kind: 'issue' | 'file' | 'commit' | 'artifact' | 'diff'; display: string }[];
  blocking: boolean; blocks: string; meanwhile: string;
  destructive: boolean; authorization: boolean; urgency: 'normal' | 'urgent';
  declaredDefault: { option: string; deadline: number } | null;
  status: 'open' | 'answered' | 'cancelled' | 'superseded';
  askedAt: number; version: Version;
  answer: { text: string; option?: string; at: number;
    source: 'owner' | 'declared-default'; authorLabel: string } | null;
  deliveries: { recipientLabel: string; state: string; consumedAt: number | null }[];
  dismissal: { reason: string; at: number; replacementId?: string } | null;
};
type WriteOperation = { id: string; state: 'pending' | 'queued' | 'consumed'
  | 'not-supported' | 'unconfirmed' | 'failed'; transport: 'native-prompt' | 'bridge';
  targetId: string; createdAt: number; updatedAt: number; code?: string };
type Snapshot = { apiVersion: 1; pcId: string; epoch: string; cursor: Cursor;
  sampledAt: number; stale: boolean; capabilities: Capability[];
  sessions: Session[]; jobs: Job[]; questions: OwnerQuestion[];
  pages: { sessions: Cursor | null; jobs: Cursor | null; questions: Cursor | null };
  sourceState: 'ready' | 'offline' | 'slow' | 'unavailable' };
```

Question schemas/semantics derive from `src/core/owner-questions.ts:14-51`, `107-124`. Preserve blocking/destructive/authorization and declared-default terms on the answer screen. Authorization questions and blocking destructive questions cannot default (`33-34`, `113`). Answering records owner intent; delivery/wake/consumption are separate. A delivery failure does not undo or license resubmitting a recorded answer. V1 rejects pinning even though the local schema accepts it. Display links as inert text or explicitly approved HTTPS links; no automatic local-file opens or URL fetches.

Chat item IDs need a gateway mapping because native `TranscriptItem.id` is optional and SQLite previews may change (`src/core/transcripts/common.ts:28-31`). Preserve native opaque offsets internally; expose a generation-bound cursor and replace an existing item on revision. Set size/line/text limits and truncation explicitly; native previews are deliberately lossy, not a complete export.

### Pairing and device authentication

1. Authenticated PC owner requests an invitation. Generate at least 256 random bits; store only a domain-separated hash of its nonce with PC ID, expiry (proposed two minutes), unused state and invitation ID. QR contains only API version, configured trusted HTTPS origin, PC/invitation IDs, nonce and expiry. No broker/dashboard/device credentials, push token or project contents.
2. Claim over valid TLS atomically changes unused -> claimed. Expired/replayed claims fail; at most one claimant. Return a separate random claim credential (hash stored), claim ID and comparison code bound to the invitation/claim. Device name is untrusted and is not proof of identity. Both phone and PC display the comparison code; the PC owner verifies it and explicitly confirms capability/entity grants. A photographed QR can deny pairing by claiming first but cannot silently become an approved device.
3. PC confirmation changes pending -> approved, only while invitation/claim is valid. Phone uses its claim credential to retrieve its own result; knowing the QR nonce or claim ID is insufficient. Denial, expiry and cancellation are terminal. No automatic approval/default. Credential issuance is one-time, expires quickly, and its response is no-store/redacted; loss of issuance response requires cancelling/revoking the orphan and a new pairing, never reopening the consumed nonce.
4. Issue independent per-device/session high-entropy opaque credentials: access (proposed 15 minutes) and rotating refresh (proposed 30-day absolute lifetime), each stored server-side as a domain-separated SHA-256 hash with device/session ID, token generation, grants, expiry, revocation and last-use metadata. Uniform 256-bit credentials allow fast hashes; use constant-time comparison. No reversible/plaintext credential storage. Generate a separate session-bound random CSRF token, hash it on the gateway; native refresh material belongs in OS secure storage, access token in memory. These lifetimes are proposal defaults, not owner decisions.
5. Check current device/session revocation and grants on every request, stream subscription, event delivery and push dispatch. Refresh rotates credentials; replay outside recovery of the same idempotent refresh revokes the session family. PC revocation stops streams, refresh, future pushes and writes immediately; the app clears protected caches on 401/403 or revocation. Already sent generic push notifications cannot be recalled.

Private network membership is reachability, not authentication. Accept HTTPS only, normal certificate validation, no insecure trust fallback or arbitrary redirects. LAN certificate trust/provisioning must be settled before pairing can ship. The QR's origin is compared against a configured/owner-verified origin; scanning an arbitrary QR must not make the app trust its certificate or transmit an existing credential there. Switching PCs/origins selects a separate stored pairing, never reuses credentials.

### Origin, CSRF, write replay and errors

The gateway validates an exact configured authority and present Origin (scheme, host and port), not an origin derived from Host/X-Forwarded-Host. Reject `Origin:null`, unexpected origins and cross-site Fetch Metadata. Native requests may omit Origin only on the bearer-only API with no Cookie authentication; require Authorization and the session's CSRF token on every authenticated write. Browser/admin cookie writes always require the exact provisioned origin plus synchronizer CSRF token. Do not offer wildcard CORS, mixed cookie/bearer fallback or URL token authentication. Pair claims use single-use nonce and restricted claim credential instead of a device CSRF token; PC invitation/confirmation use the local owner CSRF policy.

All mutating operations, including pairing claim, refresh, subscription removal and revocation, require `Idempotency-Key` (random UUID), strict JSON where there is a body, bounded bytes and per-principal rate limits. Proposed limits: 32 KiB request bodies, message text <= 16,000 characters, answer text <= existing 8,000, read pages <= 100/512 KiB, lower limits for pairing attempts. Client-controlled IDs never select a backend path or another peer by name alone.

The gateway reserves a durable operation before dispatch, keyed by principal + method + normalized route + key and canonical request hash. Same key/body returns the recorded operation/result; different body -> 409. Retain ordinary replay records at least 24 hours and return an expiry timestamp. Credential issuance is an explicit exception: never persist a plaintext or reversibly encrypted access/refresh credential in a response cache. A repeat of the same successful issuance/refresh key returns its durable issued status without credentials and does not mint another session or rotate again. If the phone lost that one-time response, require PC revocation and a new pairing; this fail-closed recovery tradeoff needs implementation review. A missing expired idempotency entry is not authorization to repeat a stale answer/send.

Never turn a native-prompt timeout into bridge fallback or automatically resend an uncertain write: `src/core/dashboard-chat.ts:21-25`, `42-45` already avoids this. Broker sends can use a stable mapped messageId when an adapter supports it, but native prompt queuing has no durable idempotency guarantee. A crash between native dispatch and outcome recording leaves `unconfirmed`; keep the reservation and let the owner inspect chat. V1 may leave optional send disabled until durable status/recovery is adequate.

Answers carry expectedVersion covering the question's terms/status; send carries expectedGeneration so a renamed/reused peer cannot receive stale intent. Re-check scopes and current open/connected state before dispatch. A stale/answered/cancelled question or changed session -> 409 with current state, never implicit retry. Existing broker answers check open status transactionally but do **not** accept expectedVersion: gateway preflight alone is not atomic with PC edits/default processing. This is a contract gap to resolve or explicitly weaken before implementation; do not claim source-level compare-and-set exists.

Errors are `{code,message,requestId,retryable,currentVersion?}`; no stacks, raw upstream error text, paths or secrets. Use 400 invalid, 401 absent/expired/revoked credential, 403 scope/origin/CSRF, 404 unknown or unauthorized entity (avoid enumeration), 409 state/replay/version conflict, 410 obsolete cursor/push hint, 413 bounds, 429 with Retry-After, 503 upstream unavailable. No write is dispatched from stale cached source data. Retained read fallback is visibly stale and cannot enable answer/send.

### Foreground events and reconnect

Existing UI uses polling (`src/cli/ui-page.ts:1959-1981`, `3142`); native page/log cursors are separate from synchronization. There is no mobile event stream or whole-dashboard snapshot cursor in the inspected routes. Local question storage has a question_events revision table (`src/core/owner-questions.ts:56`, `77-79`), but that is not an exposed scoped event API.

Create a single serialized materialized gateway view per PC/grant revision, sampled from allowlisted sources. Publish changes only after this view commits. Snapshot and cursor come from the same committed view so subscribe-after-cursor cannot lose a sampled update. Snapshot indicates sampling/staleness; it is not a transactionally exact simultaneous view of every native store. Polling can miss transient source transitions: do not promise a full lifecycle/audit stream.

Event envelope: `{apiVersion:1, epoch, cursor, type, resource:{kind,id}, version, at, data}`. Types: `session.upsert`, `session.remove`, `job.upsert`, `job.remove`, `steps.available`, `chat.changed`, `question.upsert`, `question.remove`, `operation.updated` (optional send), `snapshot.required`, `authorization.changed`. Summary/question upserts use the DTOs above; chat/step availability carries no full content and triggers an authorized page fetch. Do not emit permission/decision/settings events in v1. Include removals and revised chat items, not just append messages. Authorization-change signals tell the client to discard its prior view and refetch; never deliver newly forbidden data.

Foreground uses authenticated streaming with header auth (e.g. SSE over an RN streaming adapter); credentials never appear in stream URLs. Reuse the cursor as SSE id/Last-Event-ID or `after`, validating agreement if both are supplied. Heartbeat proposed 15 seconds; bounded buffer and slow-consumer disconnect. Replay is at-least-once and ordered within epoch: dedupe by cursor, apply changes in delivery order, persist cursor only after successful application. Versions are opaque equality tokens, never compared lexicographically. Page responses also carry a gateway view cursor; reconcile any events since that cursor before applying a delayed page over a newer view. Proposed replay ring: 10,000 events or 24 hours, whichever bound is reached first; source tokens remain separate.

On network loss use capped exponential backoff with jitter, then reconnect with last committed cursor; on OS foreground always re-authenticate/check state. Unknown/expired cursor, restart epoch, grant change, source reset/truncation or buffer overflow -> explicit snapshot.required/410, clear affected cursors and obtain a new snapshot. Gateway restart may create a fresh epoch instead of guaranteeing replay persistence. Reads/events are filtered for the current device before serialization. Background suspension ends foreground liveness; push is a hint and never replaces snapshot reconciliation.

### Expo/APNs/FCM push

Native notification registration uses the Expo project ID and user consent; signed development/production builds are required for the Android remote push path, which is unavailable in Expo Go from SDK 53. Keep distribution choice separate from this API contract. See [Expo notifications API](https://docs.expo.dev/versions/latest/sdk/notifications/) and [Expo setup](https://docs.expo.dev/push-notifications/push-notifications-setup/).

iOS requires Apple/APNs credentials and matching application identity/entitlements; Android uses an FCM v1 service-account key and matching Firebase application configuration. Provider private keys belong in owner-controlled EAS/provider credential storage, not the app or repository; gateway Expo send authorization is a different secret. Credential owner, Expo/Firebase projects and distribution channels remain open. See [Expo setup](https://docs.expo.dev/push-notifications/push-notifications-setup/) and [FCM credentials](https://docs.expo.dev/push-notifications/fcm-credentials/).

The gateway needs outbound validated HTTPS to Expo; Expo forwards to APNs/FCM and phones need provider connectivity. A private gateway needs no public callback or internet-facing broker for push, but a tap still requires VPN/LAN reachability to fetch data. Enable Expo enhanced push security and keep its access token server-side. Send <= 100 notifications per request and <= 600/second/project; total payload <= 4096 bytes. Check tickets/receipts, remove DeviceNotRegistered tokens and back off transient failures. A provider receipt is not phone delivery/read; there is no delivery SLA. See [Expo sending/security/limits](https://docs.expo.dev/push-notifications/sending-notifications/).

Use a payload such as `{title:"agent-bridge", body:"Open the app to review an update", data:{v:1, notificationId:"<random opaque ID>"}}`. No question title/text, project/session/job names, paths, commands, answer options, credentials, owner identity or actionable approval/answer data. Proposed short TTL <= 300 seconds; registry mapping is device-bound, expires and is filtered on lookup. Even opaque pushes disclose app/timing/traffic metadata to providers; minimize frequency and coalesce reminders.

Question transitions/reminders enqueue only for currently paired, opted-in, authorized devices. Re-check question-open state and scope at dispatch, bind registration to the authenticated device/project/environment, replace rotated tokens, encrypt tokens at rest (they must be recoverable to send; hashing is for authentication credentials), redact logs. Logout/revocation removes the subscription. Already enqueued generic pushes may arrive late or duplicated.

Tap opens the app, authenticates, resolves notificationId and fetches the **current** question/snapshot. Answered/expired/superseded/unauthorized state shows its current result; offline shows a reconnect state with writes disabled. No notification quick-answer or permission action. Never fetch a URL supplied by a push. Foreground state and optional push reminders share dedupe keys to avoid duplicate alerts; notification failure never loses the persisted question. Physical iOS/Android push and background/reconnect validation are future acceptance work, not evidence supplied by this inventory.

## Later capability boundary: approvals, decisions and settings

No mobile permission-approval endpoint/capability is enabled or proposed as part of v1. Inventory for later: local `GET /api/approvals` at `src/cli/ui.ts:391-401`, `POST /api/approvals/{uuid}` at `433-442`, both L and write W. PendingApproval fields are `src/core/relay.ts:168-180`; private PID/port/token are separate (`182-186`) and stripped by `249-260`. `answerPendingApproval` (`266-277`) invokes a loopback bearer-protected callback; callback validation/deadline/callback acceptance are `207-216`. Outcomes answered/expired/unavailable are not ordinary job chat.

A future separate `approvals.read` / `approvals.decide` grant needs explicit PC enablement and fresh in-app owner verification; it must bind the displayed tool/command/reason, exact request revision, owning job/session and deadline to a one-shot allow/deny intent. Re-check the native pending callback/deadline immediately before answering; race with another answer/expiry returns a conflict. Unavailable is indeterminate, never automatic allow or fallback into messaging. Record authenticated device provenance locally; the current handler reports only answeredBy dashboard. Push remains content-free with tap-to-fetch, no lock-screen approval. Question answer and approval DTOs/routes must remain distinct.

Decisions are later: local read routes are `src/cli/ui.ts:374-389`; answer pin support is `src/core/owner-questions.ts:40`, with recording/publishing at `src/core/owner-question-service.ts:39-44`. Question alert settings are later (`src/cli/ui.ts:410-416`, L + W on writes). V1 rejects these routes and pin fields. Introducing them requires its own scope/auth review; pairing a device does not implicitly authorize them.

## API gaps and threats

| Gap / threat | Required boundary or unresolved work |
| --- | --- |
| Shared home dashboard key leaks whole-owner authority; broad proxy would expose DB/history/network/job administration. | Separate hashed device sessions, fixed operation allowlist and entity grants. Strip mixed `/api/approvals` and raw `/api/state`/conversation payloads. No generic broker RPC or forwarding of authority secrets. |
| QR capture/replay/race or fake device name; malicious-origin QR and LAN MITM. | Atomic short-lived nonce consumption, distinct claim credential, PC code comparison/confirmation, normal TLS validation and explicit origin provisioning. Rate-limit per invite/IP and cap pending claims; decline never grants authority. |
| Stolen phone/access or refresh token; stale device revocation; overly broad session names. | Secure storage, short access lifetime, refresh rotation/replay handling, live grant/revocation checks, exact generation-bound targets. Compromised PC OS or unlocked/rooted phone remains a trust limit; biometric prompt alone does not secure a stolen bearer token. |
| Existing exact-origin/CSRF policy is incomplete for a gateway. | Provisioned authority/Origin validation, bearer-only native path, no cookie fallback/CORS wildcard, session CSRF on writes, PC local confirmation CSRF. Custom header alone is insufficient. |
| Duplicate/stale owner answer or native send after timeout/restart. | Durable idempotency ledger and source state checks; transactional question revision guard is missing. Native queue exactly-once dispatch is missing; unconfirmed reservation must block blind retry. Generic HTTP send does not carry existing broker dedupe fields. |
| No unified per-entity DTOs, ACL-aware pagination, revisions, generation-safe cursors or event snapshot watermark. | New gateway projections/journal; all native cursor types remain separate. Deterministic IDs, update/remove events and reset handling required. Polling is sampled and may miss intermediate transitions. |
| Read-only native services can reveal prompts, command previews, raw/base64 records, absolute paths and paired-PC data. | Authorize parent/project/PC before service call, serialize only typed allowed fields, bounded plain-text rendering, inert links, log redaction. Scoped access does not guarantee source transcripts contain no secrets; user grants must acknowledge their content. |
| Mixed owner, permission and delegated-job questions can be confused. | Distinct v1 owner-question resource and typed kind; pin/allow/deny/dismiss/settings/job controls absent. Existing PC defaults can still answer declared-default questions: always fetch current state. |
| Push spoofing/token theft, provider metadata, late/duplicate/offline delivery. | Enhanced Expo push security, encrypted subscription tokens, device-scoped opaque hint, short TTL, no private text/actions, receipt processing and tap re-auth/state lookup. PC offline and gateway sleeping cannot guarantee push. |
| Expensive transcript discovery/polling/log scans or slow SSE consumers can impair the PC. | Bounded pages, shared sampling, per-device/IP rate limits, max streams/claims, no unbounded queue, backpressure/timeout, circuit-break upstream failures. Gateway runs without elevation and exposes no filesystem/process execution operation. |
| Gateway holds powerful local owner authority even when devices have narrow rights. | Gateway is a trusted deputy: narrow typed adapter and auditable device/request/target/result metadata; do not record body/token/nonce. Local privileged users/PC compromise cannot be neutralized by mobile ACLs. |
| Acceptance and deployment facts remain unverified. | Owner resolves private VPN/LAN trust and distribution/credentials; implementation later needs adversarial pairing/replay/CSRF/ACL tests, snapshot/reconnect races, crash ambiguity, revocation and iOS/Android background/push evidence. No installation/runtime/native claims here. |

## Execution record

Ran `git fetch origin` and `git switch -C agent-bridge/2ab51d9d 5fb90d3a`; verified HEAD and package version 0.30.10. Inspected repository source and official Expo documentation only. No servers, installations, builds, tests, live databases, secret files, history reads, network configuration changes, releases or cleanup. Only this inventory artifact is written; designer documents, handoff and TODO files are untouched. Source/runtime behavior and push delivery have not been executed or accepted. The final delegated report supplies the artifact commit and branch.
