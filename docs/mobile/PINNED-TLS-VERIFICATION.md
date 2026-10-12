# AB-271 pinned PC TLS verification

Branch `feat/ab271-pinned-tls`, requested base `00cbe6ef` (v0.30.13).
Usable implementation pushed at `403f148b` on 2026-10-12 JST. No merge or release.

## Implementation

- `tls:"pinned"` creates/reuses an owner-private P-256 identity in the bridge home.
- SHA-256 of full SPKI DER is encoded as unpadded base64url; self-signed certificates include configured IP/DNS SANs.
- Uses [`@peculiar/x509`](https://peculiarventures.github.io/x509/docs/usage/) `2.1.0`, npm's stable tag checked 2026-10-12. This avoids maintaining a custom certificate DER writer; Node X509 independently verifies generated certificates in tests.
- QR v2 contains current/optional staged-next pins; QR v1 and supplied certificates remain supported. Desktop Phones and app review show the same abbreviated PC key.
- Production retains credentials/origins/pins in SecureStore. Every pinned request uses the local iOS URLSession or Android OkHttp module; HTTP, wrong pins, redirects and absent native module fail closed without Expo fetch fallback.
- Immutable key/state files and retired-key archives remain retained. No removal or data-retention-guard changes.

## Unsigned iOS 27 build and native TLS proof

Local device commands ran as `desktop-pc\renne`; SSH ran as `rennerdo30`.
Tools: Xcode 27.0 (`27A266a`), iOS simulator runtime 27.0 (`24A434`).
Space-free copy: `/Users/rennerdo30/dkbuild/ab271-pinned-20261012-2153`.
Bundle ID `dev.rennerdo30.agentbridge` exists only in that copy.
Simulator: `AB271-PINNED-20261012-2153`, iPhone 18 Pro Max,
`B9C42D0A-8988-4F74-93FE-D8F3B5BDC975`.

The isolated synthetic gateway listened at `https://192.168.1.232:18443`, using
its generated self-signed PC key. A second server at port 18444 used a different
key. Test-only fixture routes generated a fresh 120-second QR and confirmed the
actual desktop-admin comparison code/grants. No real broker data or credentials
were used. A build-copy startup harness invoked the actual `parseQr`,
`MobileClient.beginPairing`, `pollPairing`, gateway transport and app client.
The simulator camera and human QR/code-review interaction were not exercised.

Prebuild, CocoaPods, native module compilation and unsigned Release build passed:

```sh
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
npm ci --no-audit --no-fund # apps/mobile in the build copy
CI=1 npx --no-install expo prebuild --platform ios --no-install
cd ios && pod install && cd ..
xcodebuild -workspace ios/agentbridge.xcworkspace -scheme agentbridge \
  -configuration Release -sdk iphonesimulator \
  -destination id=B9C42D0A-8988-4F74-93FE-D8F3B5BDC975 \
  -derivedDataPath ../../DerivedData \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

An initial Metro export failed because the new helper used an explicit `.js`
import for TypeScript. Corrected to the existing app extensionless convention;
root/app typechecks, exports and native build then passed.

**Unsigned Keychain limitation:** the real Expo SecureStore save failed with
`A required entitlement is not present`, and the production client correctly
returned pairing-unconfirmed without accepting a device. The exact
[unsigned SecureStore receipt](verification/ab271-pinned-ios27-unsigned-securestore.json)
is retained. No signing or keychain unlocking was attempted. The supervisor
explicitly approved a memory credential adapter only in the disposable simulator
copy to complete transport acceptance. That adapter/harness is not committed,
and no runtime bypass flag was added. Actual SecureStore persistence must be
verified on the owner's signed physical iPhone via devkit.

With that approved copy-only adapter:

| Check | Result |
| --- | --- |
| Parse fresh QR v2 and pair with gateway | Passed |
| Authenticated snapshot through actual client | Passed |
| Actual app client initialization/read | Passed |
| Pins follow credential save/rotation in memory seam | Passed |
| Wrong server key | Rejected before HTTP; wrong-key server requests **0** |
| Plain HTTP | Rejected |
| Redirect | Rejected; redirect target requests **0** |
| Empty pins | Rejected |
| Authenticated snapshot requests received by gateway | **2** |

[Machine-readable native result](verification/ab271-pinned-ios27-result.json).
[Rendered paired Overview screenshot](verification/ab271-pinned-ios27.png),
SHA-256 `3ced72009e011634e4a3ee373234d0ca7e47125aff110c8ab760f4ca4805fe21`.
Logs, fixture identities/registry, build copy and simulator are retained; no cleanup.

The standalone Swift harness compiled the production SPKI parser and passed
correct/next/wrong pins, canonical pin validation and all **416** truncated
certificate cases. Android's production policy/OkHttp factory passed **8** real
JVM TLS tests, including self-signed/mismatched-hostname success, wrong-key
rejection before HTTP, staged-next key, expired-certificate key-only acceptance,
redirect refusal, HTTP refusal and PUT/UTF-8 body transport. An Android native app
build/device test was not performed.

## Source and bundle checks

Commands from the Windows worktree:

```powershell
npm run typecheck
npm --prefix apps/mobile run typecheck
node node_modules/vitest/vitest.mjs run test/mobile-identity.test.ts test/mobile-pinning.test.ts test/mobile-activation.test.ts test/mobile-config.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run test/mobile-client.test.ts test/mobile-pinning.test.ts test/data-retention.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config apps/mobile/vitest.config.ts
node node_modules/vitest/vitest.mjs run --config apps/mobile/modules/pinned-transport/vitest.config.ts
npm --prefix apps/mobile run check:compatibility
npm --prefix apps/mobile run bundle
npm run build
npm run test:all
```

Typechecks, plugin builds, Expo compatibility and Android/iOS Hermes exports pass.
Focused identity/config/activation/pinning: **49 tests**. Client/pinning/unchanged
retention guard: **32 tests**. Existing app tests: **14**. Native wrapper: **31**.
The full root suite was invoked once; its final receipt is pending at this record's
initial publication and will be updated when it finishes. No all-green claim yet.
Existing app dependency audit remains 22 inherited advisories (7 moderate,
15 high); this slice did not change the Expo app dependency set. Root install
reports zero advisories.

## Owner PC configuration

Retain the existing stable `pcId` if mobile was already configured. Opt in only
in the home config, then restart the actual broker owner normally:

```json
{
  "dashboard": true,
  "dashboardPort": 4321,
  "mobile": {
    "enabled": true,
    "pcId": "owner-stable-pc-id",
    "origins": ["https://192.168.1.235:8443"],
    "listeners": [
      {"origin":"https://192.168.1.235:8443","bindAddress":"192.168.1.235","port":8443,"tls":"pinned"}
    ]
  }
}
```

The same origin can be reached through an existing Tailscale subnet router.
No CA, public certificate or phone trust setting is needed. Physical iPhone
SecureStore/pairing/review UI, real owner data/reconnect, push and Android app
acceptance remain owner/device gates. No handoff/TODO edits were made.
