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

`src/mobile/{contract,store,gateway,adapter,desktop,push,https}.ts`: pure DTOs, isolated mobile SQLite registry/ledger, strict dispatch/authentication, fixed local service projection, authenticated loopback phone administration, provider seam, inert HTTPS server factory (never starts automatically).

`src/core/owner-questions.ts`: additive question version and atomic mobile answer replay/CAS API. Existing desktop/default callers retain their behavior; no archive, lease or worktree edits.

`apps/mobile/**`: independently writable Expo package, Android+iOS UI, secure credential adapter, typed client/state machine, QR scanner and notification seams, copied design tokens, app-only lockfile and checks. Official Expo SDK matrix checked 2026-10-11: SDK 57 / React Native 0.86 / React 19.2.3; installation uses Expo compatibility checks in this package only (https://docs.expo.dev/versions/latest/).

`test/mobile-*.test.ts`: isolated fixture databases and mocked source/provider tests; no live DB/history/secrets/devices/listeners.

Designer documents remain unchanged. This contract is updated with implemented routes, bounds and validation evidence before delivery. No release, merge, updater, network/listener activation or distribution work.
