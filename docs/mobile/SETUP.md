# Private phone access (owner setup)

Source and synthetic tests are implemented. Android/iOS device, trusted TLS, push delivery, signing and distribution acceptance remain pending. This guide describes **owner actions**, not commands agents run. This branch is unmerged; install only after release-owner review. Mobile is absent/disabled by default and requires a restart of the owning broker process. Do not stop another session's process to enable it.

## Choose addresses and trusted certificates

Use LAN and/or your existing private Tailscale network. No public relay, Funnel, port forwarding, wildcard bind or public broker. Choose a stable PC ID and exact HTTPS origins including nondefault ports. All origins share one `mobile.db` device registry in the bridge home. Retain that PC ID, registry and push encryption key across restarts; changing PC ID requires a separately reviewed recovery, not deleting the registry.

For Tailscale, the owner enables HTTPS certificates and obtains the certificate/key for the exact `machine.tailnet.ts.net` name with `tailscale cert`, using the [official HTTPS certificate guide](https://tailscale.com/docs/how-to/set-up-https-certificates). This application binds the private Tailscale address directly; it does not configure Serve, a VPN, DNS, renewal, firewall or routing. The owner renews certificates and restarts the host before expiry. A certificate for the DNS name does not validate a raw 100.x IP origin.

For LAN, provision a certificate whose exact DNS name (or IP SAN) matches the origin and whose chain the phone normally trusts. For a private CA, the owner installs the CA through the platform trust settings and verifies trust in the installed native app; Android app policy may require additional reviewed native work. No app certificate-validation bypass or fingerprint pinning exists. Use a trusted certificate/hostname if platform CA installation alone is insufficient. The host validates leaf validity dates, exact hostname/IP and private-key match; the phone still must validate the trusted chain. Supply an unencrypted PEM key and certificate chain; passphrase keys are unsupported.

Put certificate, key and push files in an owner-private physical directory. Absolute regular-file paths only: no symlink/junction anywhere in the path. Unix files must belong to the process uid with no group/other permissions (for example owner-only mode 0600). Windows uses a bounded PowerShell ACL inspection: owner SID must equal the caller SID; readable Allow entries may name only that user, SYSTEM or Administrators. Missing/unreadable ACL information fails closed. This is a conservative best-effort ACL check, not a full effective-access/group-membership evaluator or protection against a concurrent administrator changing ACLs/reparse points. Owner must restrict directory access and inheritance as well. Material reads are bounded to 64 KiB plus one overflow byte and reject file identity/size/mtime changes. Neither paths, contents nor sizes are included in activation diagnostics.

## Opt in in the home config

Edit only the top-level `mobile` section in `~/.agent-bridge/config.json`. Project config, per-agent sections and environment variables cannot enable or override mobile. Placeholder example (replace every placeholder before enabling):

```json
{
  "dashboard": true,
  "dashboardPort": 4321,
  "mobile": {
    "enabled": true,
    "pcId": "owner-stable-pc-id",
    "origins": ["https://pc.example.lan:8443", "https://pc.tailnet.ts.net:8444"],
    "listeners": [
      {"origin":"https://pc.example.lan:8443","bindAddress":"192.168.1.20","port":8443,"certFile":"C:\\OwnerPrivate\\lan.crt","keyFile":"C:\\OwnerPrivate\\lan.key"},
      {"origin":"https://pc.tailnet.ts.net:8444","bindAddress":"100.64.1.20","port":8444,"certFile":"C:\\OwnerPrivate\\tail.crt","keyFile":"C:\\OwnerPrivate\\tail.key"}
    ],
    "push": {"provider":"expo","materialRef":"C:\\OwnerPrivate\\push.json","projectId":"11111111-1111-4111-8111-111111111111","environment":"production"}
  }
}
```

Unix uses absolute Unix paths. Listener port must equal the origin's port (443 when omitted), and each approved origin has exactly one listener. Private literal binds are safest; hostname binds resolve once and every returned address must be private (LAN, Tailscale CGNAT, loopback or IPv6 ULA). The checked literal is bound without a second DNS lookup. Link-local/scoped and public addresses are unsupported. All material is checked before deliberate existing-service initialization, preparation and listener startup. No material/config changes hot-apply: restart through the owner's normal process lifecycle. Set `enabled:false` before that restart to disable mobile.

The interactive MCP broker owner prepares the gateway through its existing dashboard startup hook; short headless/delegated/non-owning sessions do not gain hosting authority. A fresh standalone `agent-bridge ui` may become broker owner and prepare it through the existing ui command. Another already-running uninjected dashboard or broker is not adopted/stopped/upgraded: configure the actual owner and restart it yourself. The dashboard's **Phones** entry appears only after a prepared host is ready. Normal default dashboard HTML/routes remain unchanged when mobile is disabled.

## Push material and native credentials

The shipped provider is Expo enhanced-security push, not a direct APNs/FCM client. The owner sets the real Expo project ID/app identifiers and obtains an Expo access token, enables enhanced push security, and stores this private JSON file at `materialRef`:

```json
{"accessToken":"REPLACE_WITH_OWNER_EXPO_TOKEN","encryptionKey":"REPLACE_WITH_BASE64_OF_32_RANDOM_BYTES"}
```

Generate and retain a separate random 32-byte encryption key for this registry. There are no inline config tokens or environment credential loaders. Material is read only at activation and held in memory; the encryption key protects stored push subscriptions and must stay stable across restarts. No credential is sent in a dashboard DTO or diagnostic.

For Android, the owner creates the Firebase project/FCM v1 credential and supplies it to the chosen Expo/EAS app build setup. For iOS, create the APNs key/entitlements in the owner's Apple Developer account and configure the matching Expo/EAS app. Follow [Expo's platform credential/setup steps](https://docs.expo.dev/push-notifications/push-notifications-setup/) and [enhanced-security sending instructions](https://docs.expo.dev/push-notifications/sending-notifications/). These native APNs/FCM credentials belong to the provider/build setup; **do not** put them in this gateway's Expo material JSON. No EAS credentials, build, signed binary, provider call or physical-device setup is performed in this package. App project/environment must match gateway registration. Omit `push` for an explicit unsupported state.

## Pair, answer and recover

Open the authenticated desktop dashboard → Phones → create QR. Review the address list on the phone, scan within 120 seconds, compare the six-digit code on both screens, select exact local grants and confirm on the desktop. QR is single-use. Phone never grants itself authority. Revoke a device on Phones to invalidate it across all origins. Owner questions are local only; approvals/decisions/settings/session sending/paired-PC writes remain unsupported.

Phone stores credentials and approved/preferred origins in SecureStore; session/job/chat/question/draft content stays in memory. Writes require a fresh authoritative snapshot less than 15 seconds old after reconnect/rotation. Lost issuance/refresh responses require desktop revocation and a new pairing. Refresh expires absolutely 30 days from issuance; rotation does not extend it. An ambiguous answer remains unconfirmed; do not blindly repeat it. Push is a generic opaque hint; tap reauthenticates and refetches. Provider submission/receipt never proves device delivery or owner acceptance.

Failure diagnostics show only a request ID and fixed category (`config_invalid`, `material_unavailable`, `tls_invalid`, `bind_invalid`, `source_unavailable`, `restart_required`). Correct provisioning offline and restart normally; no automatic bind retry. Failed close can leave an inactive optional listener until process restart: dispatcher stays disabled. Optional mobile rejection/hang cannot block core shutdown beyond its independent five-second bound. Broker handover retires hosting, the phone reconnects, and the successor prepares only under its own explicit opt-in. Device/provider/native-TLS acceptance and distribution remain owner decisions.
