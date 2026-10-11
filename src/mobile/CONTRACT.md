# AB-271 private mobile v1 implementation contract

Baseline `a679e53746640c04094070730fb8a29558e1e985`; design and inventory imported by authorship-preserving cherry-picks only. API-INVENTORY.md security takes precedence over DESIGN.md.

## Reconciliation and ownership

- `/mobile/v1` is a fixed typed API, never desktop `/api` forwarding. Job chat resolves to the existing run chat service.
- QR invitations have 256-bit nonces, expire after **120 seconds**, and are consumed atomically. Separate claim credentials and matching desktop confirmation precede one-time device issuance.
- Normal platform trusted HTTPS only. No self-signed bypass, TLS-validation overrides, certificate fingerprints or pinning claims. Private origin/certificate provisioning remains an owner decision.
- Owner access decision: **both LAN and Tailscale**, no public relay/port forwarding. QR carries up to eight exact HTTPS `origins` plus preferred `origin`; every address uses the same PC registry/device credentials/grants. Phone probes safe hello reads to choose a reachable provisioned address; ambiguous writes/refresh/issuance are never retried across addresses. Listener configuration is an inert list of exact private bind addresses/hostnames, origins and TLS options. Tailscale `*.ts.net` certificates may be owner-provisioned via cert/Serve; LAN requires a trusted hostname certificate or an owner-installed trusted CA. No live commands or trust-store changes are performed here.
- Rotating refresh/access/CSRF credentials are hashed server-side. Issuance responses are never persisted. Lost issuance requires desktop revocation and pairing again.
- Exact PC/project/entity/generation grants; local questions only; paired-PC reads require existing read trust. Unsupported paired-PC reads remain explicit until a trusted adapter is supplied. No remote answers, approvals, pinning, dismissal, decisions or settings.
- All mutations require UUID idempotency keys. Store-level owner-question CAS and replay records are atomic. Ambiguous operations never replay. Optional session send is disabled in this implementation.
- Content stays in client memory. SecureStore holds only gateway origin and device credentials. Background/offline/reconnecting/stale disables writes until a fresh snapshot. No write queue.
- Events are finite bounded catch-up pages with scoped opaque cursors and snapshot reset, rather than an unverified React Native SSE dependency. Foreground polling is sampled, not an audit stream.
- Push adapters/configuration only: generic opaque device-bound hints, tap re-authenticates and fetches current state. No credentials, provider configuration, delivery or physical-device acceptance.

## Exact file ownership

`src/mobile/**`: pure DTOs, isolated mobile SQLite registry/ledger, strict dispatch/authentication, fixed local service projection, authenticated loopback phone administration/page, locally vendored MIT QR encoder, provider seam and explicit provisioning helper, inert HTTPS server factory (never starts automatically).

`src/core/owner-questions.ts`: additive question version and atomic mobile answer replay/CAS API. Existing desktop/default callers retain their behavior. `src/cli/ui.ts` has only an optional authenticated `/api/mobile/*` dispatch after its existing cookie/Host gate; no archive, lease or worktree edits.

`apps/mobile/**`: independently writable Expo package, Android+iOS UI, secure credential adapter, typed client/state machine, QR scanner and notification seams, copied design tokens, app-only lockfile and checks. Official Expo SDK matrix checked 2026-10-11: SDK 57 / React Native 0.86 / React 19.2.3; installation uses Expo compatibility checks in this package only (https://docs.expo.dev/versions/latest/).

`test/mobile-*.test.ts`: isolated fixture databases and mocked source/provider tests; no live DB/history/secrets/devices/listeners.

Designer documents remain unchanged. This contract is updated with implemented routes, bounds and validation evidence before delivery. No release, merge, updater, network/listener activation or distribution work.

SecureStore retains the approved HTTPS origin list and selected preferred origin alongside device credentials; content remains memory-only. Every API request uses Expo native `fetch` with `redirect:error`, `credentials:omit` and cache-control no-store. Installed Expo source enforces redirects before follow: Android `NativeRequest.kt` sets `followRedirects(false)` and rejects redirect responses; iOS `NativeResponse.swift` redirection delegate refuses the redirect and raises in error mode. Client checks response URL too. Mock transport tests verify policy/identity/failover; physical native enforcement testing is still pending, and no pinning is claimed.

## Implemented operations and limits

Authenticated device API is exactly `/mobile/v1/{me,snapshot,sessions,jobs,questions,chats/<id>,jobs/<id>/steps,questions/<id>,questions/<id>/answer,events,me/session,me/push,notifications/<opaqueId>}`. Public hello returns only static capabilities; pairing claims and refresh have their own restricted credentials. Unknown fields/query keys/duplicate query keys, body on GET, arbitrary upstream paths and forbidden feature routes fail closed. Job chat uses `/api/runs/<run>/chat` internally. Native session IDs are pinned after exact generation resolution; jobs are generation-checked before and after the fixed service read.

Desktop owner page `/mobile/phones` and `/api/mobile/{phones,invitations,claims/<id>,devices/<id>}` are opt-in through `UiOptions.mobileAdmin`, after the existing desktop cookie/Host owner gate. Writes require the exact provisioned loopback origin and random admin CSRF token plus UUID idempotency key; there is no mobile pairing-approval route. QR SVG is generated locally without third-party requests. Desktop grants are initially unselected. Project grants cover local owner questions; sessions and jobs require explicit opaque entity IDs bound to native identity/generation. Paired-PC reads and all cross-PC writes return unsupported in this local adapter.

QR: 256-bit nonce, 120-second expiry, atomic one claimant, separate hashed claim credential, code confirmation, one-time issuance. Invitation records retain the approved HTTPS address list and PC ID. Registry is bound to a stable PC ID. Device access lifetime 5 minutes; rotating refresh lifetime 30 days; server stores hashes, and credential response replays contain issued status only. Repeat refresh with a different key revokes the device on retired credential reuse. Idempotency ordinary replay tombstones last at least 24 hours (not erased/implicitly reused). Owner answers and their exact replay records commit together in question-store schema v2 via the existing backup-first migration path. Replay records are retained; answer CAS covers terms and outcome, excluding asynchronous delivery metadata. Gateway event revisions separately include delivery metadata.

Read pages default 20/max 100; request body max 32 KiB; serialized HTTPS responses max 512 KiB; answer max 8,000 characters; chat text max 16,000 with truncation flag. Native read cursor remains inside device/revision/kind/entity-bound opaque gateway cursors; no native path/cursor is accepted from phone input. Native pages are buffered and drained in bounded slices without dropping items. Cursors are bounded to 10,000 in memory/24 hours; unknown, evicted, changed scope/view/epoch/generation returns 410. Event catch-up emits at most one content-free `snapshot.required` invalidation; this deliberate minimal reconciliation replaces incremental upsert/remove streaming in v1. The client refetches authoritative snapshots, replacing removals and revised rows. Source sampling is not a full lifecycle audit.

Rates per minute: hello 30/IP, QR claims 10/IP, claim polls 60/IP, refresh 30/IP, reads 120/device, writes 30/device. Pending invitations max 10. Inert servers cap 32 connections and 10-second header/request timeout; upstream read/write response deadlines are 5 seconds. Shared in-flight sampling avoids duplicate source scans. Expired rate/cursor entries are memory bounded; auth/replay/question data are never cleaned up by this package.

Foreground polls use bounded exponential backoff/jitter; background aborts fetches. Writes require foreground, ready connection, unexpired access, a <=15-second authoritative snapshot and local question-project answer grant. Question intents require expectedVersion and snapshot proof; any changed terms closes confirmation/reset drafts. Ambiguous writes never replay; ambiguous refresh/issuance requires PC revocation/new pairing. Revocation/grant/view reset clears client content and affected cursors. Chat/step pagination is forward native paging; backward/load-older support is not claimed.

Push remains unconfigured by default. `provisionMobile().pollQuestionHints()` is an explicit owner-scheduled seam with one in-flight poll; no timer/listener starts automatically. It projects local open questions only, checks current source/grant/device state, encrypts subscriptions with owner-supplied AES-GCM key, coalesces question/device hints and reserves before provider dispatch. The concrete `ExpoPushProvider` adapter uses fixed official HTTPS URLs, enhanced-security token injection, redirect rejection, <=4 KiB generic hints, 100 submissions/second process budget and ticket/receipt states; it never reads credentials itself. Invalid-device submission responses remove subscriptions. Hint TTL 300 seconds, opaque ID bound to device/current grant; native tap reauthenticates and refetches. Scheduling retry-later work, polling/persisting provider receipts and signed build identity must be provided by reviewed owner configuration before live activation. No APNs/FCM/Expo credentials or actual push requests were used. Provider contract verified against https://docs.expo.dev/push-notifications/sending-notifications/.

## Evidence and remaining acceptance

Focused gateway/client/adapter/provider and existing owner-question tests: **63 passed**. Tests include consumed/expired QR, desktop code/origin/CSRF, hashed rotation and replay, per-device revocation across LAN/Tailscale origins/ports, exact grants and scoped cursor/epoch resets, no credentialed redirects, authenticated PC/device/session identity before accepting snapshots, one refresh in flight, no ambiguous write/refresh/issuance failover, reconnect/background freshness gates, recycled native identities, store-level concurrent CAS, durable reopen replay and transaction rollback after injected ledger insertion failure, replay delivery metadata preservation, bounded/drained chat pages without native-cursor exposure, and fixed generic Expo submit/receipt/rate-limit seams. Root `tsc --noEmit`, app typecheck and Expo compatibility pass. SDK 57.0.27 with RN **0.86.3** and React 19.2.3 (Expo compatibility-selected patch); Android+iOS Hermes export passes. These are source/mock/fixture and bundle checks, not native/device/security acceptance.

Exact validation commands (checkout root unless stated):

```text
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run test/mobile-push.test.ts test/mobile-adapter.test.ts test/mobile-client.test.ts test/mobile-gateway.test.ts test/owner-questions.test.ts --maxWorkers=1
git diff --check
apps/mobile: npm run typecheck
apps/mobile: npm run check:compatibility
apps/mobile: npm run bundle
```

Final export SHA256: Android `CBD0332005FA92F98705ED9C381050D12932B0DCFE50E0D820F70DFB66067650`, iOS `5FB63213C91732004F5A3CD7010C1A5FD945D575F759B5F8249A5E0107C96BC2`. Ignored artifacts are under `apps/mobile/dist/_expo/static/js/{android,ios}`; they are not signed binaries and were not installed/launched. Metro transformation/file-map caches are explicitly inside app `.expo`; app config uses the official Expo build-properties plugin to set Android `usesCleartextTraffic:false` and iOS ATS disallows arbitrary loads. Generated manifests/native behavior still await actual native build/device checks.

App-only npm audit reports 22 transitive/inherited advisories (15 high, 7 moderate) after compatible non-forced fix; known chains include Metro/braces, Expo/node-forge and xcode/uuid. npm proposes incompatible old SDK/RN downgrades for forced fixes; none were applied. Record remains an owner/reviewer dependency risk before distribution, alongside LAN/Tailscale certificate/trust provisioning, native redirect/TLS/Keychain/Keystore/device/background acceptance, APNs/FCM/Expo provider credentials, EAS identities, push delivery and distribution. No secret/live database/history/device reads, live listeners/VPN/firewall changes, public relay, release, merge, updater or cleanup occurred. Root dependencies were read-only via a retained node_modules junction; all app installs were inside the writable app package.
