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

The desktop host explicitly constructs `provisionMobile` with a private registry file, stable PC ID, approved LAN/Tailscale HTTPS origins, exact existing loopback desktop origin, local read context, owner-question store and ready callback. Inject `desktopAdmin` into `startUi` options; the existing owner-authenticated dashboard then serves `/mobile/phones` with QR, matching-code confirmation, exact grants and revocation. `createMobileHttpsListeners` returns **unbound** servers with owner-provided trusted certificates/private binds; nothing listens or changes networking automatically. Optional `pollQuestionHints` is likewise inert until the owner schedules it and supplies the reviewed provider adapter/encryption key. Never expose a public relay, broker, port forward or wildcard bind.

Use trusted TLS on every approved origin. Tailscale may provision a `*.ts.net` certificate via its owner-managed cert/Serve workflow; LAN needs a hostname certificate already trusted by the phone, or a CA installed into the phone trust store by the owner. Certificate provisioning/trust installation is outside this package. No validation bypass or fingerprint pinning is implemented or claimed. Expo native fetch blocks redirects; physical Android/iOS enforcement must still be verified.

Scan the desktop QR, confirm the address list on the phone, then compare the six-digit code on both screens before desktop confirmation. QR expiry is 120 seconds. The phone never confirms its own pairing. SecureStore holds the approved address list, preferred origin and rotating device credentials; all sessions/jobs/chats/questions/drafts stay in memory. No AsyncStorage or disk content cache. Offline, reconnecting, stale and background states disable writes. Lost credential issuance/refresh requires desktop revocation and a new pairing; uncertain answers remain unconfirmed and never replay automatically.

V1 screens: Overview, Running/jobs/live steps, session/run chats, local owner-question inbox and answer confirmation, phone pairing/appearance. Optional session sending, paired-PC content in this local adapter, approvals, decisions, settings and cross-PC writes show unsupported. Read histories use bounded forward native cursors; no backward/full-history export is claimed. Push contains only a generic opaque hint and always reauthenticates/refetches on tap.

Known dependency risk: npm audit still lists 22 inherited/transitive advisories (15 high, 7 moderate) after compatible non-forced remediation. Forced fixes propose incompatible SDK/RN downgrades and were not applied. Distribution remains pending reviewer/owner acceptance of dependency risk and actual phone/TLS/storage/push/background evidence.
