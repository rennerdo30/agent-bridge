# agent-bridge mobile (AB-271)

Expo SDK 57, React Native 0.86.3, React 19.2.3; one Android/iOS codebase. Private LAN **and** Tailscale HTTPS only. See [typed gateway contract](../../src/mobile/CONTRACT.md) and [inventory](../../docs/mobile/API-INVENTORY.md).

From this package only:

```powershell
npm ci --cache .npm-cache --no-audit --no-fund
npm run typecheck
npm run check:compatibility
npm run bundle
```

Do not install at repository root or into a linked dependency directory. Expo exports to ignored `dist`; this is a JS/Hermes export, not a signed APK/IPA or device acceptance. Native builds/EAS app identities, signing, provider credentials and distribution remain owner decisions. Expo remote Android push requires a signed development/production build, not Expo Go ([official setup](https://docs.expo.dev/push-notifications/push-notifications-setup/)). Compatibility follows the [official SDK matrix](https://docs.expo.dev/versions/latest/), verified 2026-10-11.

Owner-facing startup is disabled by default and configured only in the top-level home `mobile` section; see [owner setup](../../docs/mobile/SETUP.md). Existing interactive MCP broker/dashboard hooks or a fresh owning `agent-bridge ui` explicitly validate owner-private cert/key/Expo material files, initialize the existing lazy owner-question service, prepare the host, and bind only provisioned private listeners. Phones navigation appears only after readiness. No project/agent/env activation, inline keys, foreign dashboard adoption, automatic rebind, broker protocol expansion or cross-PC write authority. Optional shutdown remains bounded/nonfatal; provisioning changes require an owner-managed restart. Low-level `prepareMobileDesktopHost` still remains unbound and borrows an existing service; see [host integration](../../src/mobile/HOST.md). This package's validation used only synthetic material, mock private HTTPS listeners/provider and isolated fixture desktop endpoints; no real credentials or owner network changes.

Use trusted TLS on every approved origin. Tailscale may provision a `*.ts.net` certificate via its owner-managed cert/Serve workflow; LAN needs a hostname certificate already trusted by the phone, or a CA installed into the phone trust store by the owner. Certificate provisioning/trust installation is outside this package. No validation bypass or fingerprint pinning is implemented or claimed. Expo native fetch blocks redirects; physical Android/iOS enforcement must still be verified.

Scan the desktop QR, confirm the address list on the phone, then compare the six-digit code on both screens before desktop confirmation. QR expiry is 120 seconds. The phone never confirms its own pairing. SecureStore holds the approved address list, preferred origin and rotating device credentials; all sessions/jobs/chats/questions/drafts stay in memory. No AsyncStorage or disk content cache. Offline, reconnecting, stale and background states disable writes. After reconnecting or rotating credentials, fetch a fresh authoritative snapshot before answering. Its write proof lasts at most 15 seconds; events/detail polling does not extend it. Unrelated session/job activity does not invalidate an unchanged question within that window; changed question terms require review again. Lost initial credential issuance or refresh response requires checking/revoking the phone on the desktop and a new pairing: there is no credential recovery retry or address failover. Refresh credentials expire absolutely 30 days after initial issuance; rotation does not extend that deadline. Uncertain answers remain unconfirmed and never replay automatically.

V1 screens: Overview, Running/jobs/live steps, session/run chats, local owner-question inbox and answer confirmation, phone pairing/appearance. Optional session sending, paired-PC content in this local adapter, approvals, decisions, settings and cross-PC writes show unsupported. Read histories use bounded forward native cursors; no backward/full-history export is claimed. Push contains only a generic opaque hint and always reauthenticates/refetches on tap.

Known dependency risk: npm audit lists 22 vulnerable package entries (15 high, 7 moderate), traced to three build-only advisories: braces, node-forge and uuid through xcode. The supervisor accepted these residuals on SDK 57 / RN 0.86; the vulnerable leaves are absent from both production Hermes exports. See [dependency security review](SECURITY.md) for each path, exploitability, evidence and upstream-patch/next-SDK revisit triggers. Actual phone/TLS/storage/push/background evidence remains pending.

## Design fidelity and review

The app uses the design tokens for typography, themes, status colors, radii and touch targets, with four roots: Overview, Running, Questions and Settings. Root views remain mounted to preserve scroll positions. Detail screens, chat bubbles/tool folds, full context/options and a keyboard-safe answer bar use the existing private DTOs and unchanged client operations. Confirmation captures PC identity, epoch, question id/version and the exact literal answer; callbacks recheck current authority and CAS terms. Drafts stay in memory, unchanged terms survive unrelated activity, and removed/revoked/changed terms invalidate them. A single-flight latch survives back navigation. Ambiguous writes remain unconfirmed until a deliberate read-only check and new review; nothing auto-resubmits. UI expiry redraws consult actual QR/client authority, never the design's conflicting timing tokens.

Design reconciliation stays within the approved contract:

| Design feature | This app |
| --- | --- |
| QR 5 minutes / fingerprint | Actual 120-second QR; desktop code confirmation; normal trusted TLS; no fingerprint or pinning claim |
| Project/role/owner/model metadata | Opaque local grouping; unavailable metadata is omitted; loaded counts are labeled |
| Native children / linked subagents | Unsupported; no inferred entity links or ownership |
| Older transcript navigation | Existing forward bounded pages only; no backward/history-completeness claim |
| Dismiss / pin / session composer / remote settings | Unsupported; closed history is read-only |
| Notification test / delivery claim | Existing explicit registration/tap helper; actual OS permission is separate from delivery and acceptance |
| Clipboard, haptics, native stack gestures | Selectable native text and lightweight navigation; no added modules or native configuration |
| Preferences / drafts / content | Memory only; credentials and approved origins remain the only SecureStore data |

English copy lives in `src/strings.ts`; the logo PNG is a local raster adaptation of the existing SVG geometry. All dependencies, native configuration, client/auth code and provider helpers remain unchanged.

Run the app-owned model/navigation/answer-state tests from the repository root using the existing read-only Vitest installation:

```powershell
node node_modules/vitest/vitest.mjs run --config apps/mobile/vitest.config.ts
node node_modules/vitest/vitest.mjs run test/mobile-client.test.ts --maxWorkers=1
```

The first command also generates the stable offline reference at [`.visual-review/contact-sheet.html`](.visual-review/contact-sheet.html) and [`.visual-review/manifest.json`](.visual-review/manifest.json): 24 states × light/dark × 375×812/412×915 × font 1.0/1.5 = **192 frames**. All content/addresses are synthetic. Markup is independent HTML driven by shared tokens/model fixtures, **not a React Native renderer or device capture**. Files are ignored and retained locally; tests regenerate them without any services, stores, credentials or network. Browser automation rejects `file:` URLs here, so no browser screenshot or rendered-browser inspection is claimed. The preserved PNG is the logo asset, not a contact-sheet screenshot.

Presentation/model tests and Android/iOS Hermes exports do not prove native visual fidelity, camera/torch/keyboard/scroll behavior, screen readers, OS storage/TLS, push delivery or signed distribution. Actual Android/iOS captures and full app review remain required before merge/release. No live activation took place for this package.
