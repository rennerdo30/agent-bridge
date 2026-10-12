# Pinned gateway transport

Local Expo module, automatically discovered under `apps/mobile/modules` by
[Expo autolinking](https://docs.expo.dev/modules/autolinking/). Requires a native
development/standalone build for pinned requests. Importing the wrapper does not
load the native module until a pinned request is made, so legacy devices can
continue to use Expo Go's ordinary transport.

```ts
import { request } from "../modules/pinned-transport";
const response = await request(url, {
  method: "GET", credentials: "omit", redirect: "error", signal,
}, device.pins);
```

The pin is SHA-256 of the leaf certificate's complete DER SubjectPublicKeyInfo,
encoded as unpadded base64url. One current pin and an optional distinct next pin
are allowed. iOS extracts SPKI directly from the certificate because a Security
framework EC public key's external representation is a raw EC point. Android
uses `X509Certificate.publicKey.encoded` (SPKI). Both deliberately authenticate
only the enrolled leaf key, ignoring chain, dates and hostname. This implements
the owner's approved AB-271 pinned-PC identity policy; the caller must obtain
the pin from the reviewed pairing payload and retain it with device credentials.

Every request requires HTTPS and a valid nonempty pin set. There is no fallback,
CA trust attempt, redirect follow, cookie persistence, cache, or connection retry.
iOS uses a per-request ephemeral URLSession and its
[redirect delegate](https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate/urlsession(_:task:willperformhttpredirection:newrequest:completionhandler:))
refuses the redirect. Android uses an explicit pin-only TrustManager with
[OkHttp's two-argument sslSocketFactory](https://github.com/square/okhttp/blob/parent-4.12.0/okhttp/src/main/kotlin/okhttp3/OkHttpClient.kt),
a pin-checking hostname verifier and disabled redirects. Each request has an
independent session/pool, so a connection authenticated under an older pin set
cannot be reused after a device or pin change.

The native bridge has synchronous request reservation/cancellation plus an
[Expo AsyncFunction](https://docs.expo.dev/modules/module-api/#asyncfunction)
request. Reservation closes the abort-before-dispatch race and caps concurrent
requests at 128. JS and native deadlines are ten seconds; abort rejects the JS
promise and cancels native work. Only GET, POST, PUT and DELETE with string bodies
are supported for the fixed gateway API. Request bodies are bounded to 32 KiB;
responses to 512 KiB including decompressed data. Native errors expose fixed
categories without certificate material, addresses, response content or headers.

Run from the repository root:

```powershell
node node_modules/vitest/vitest.mjs run --config apps/mobile/modules/pinned-transport/vitest.config.ts
./apps/mobile/modules/pinned-transport/test/run-jvm.ps1
npm --prefix apps/mobile run typecheck
```

The standalone JVM runner uses isolated `.native-tests` artifacts downloaded
from Maven Central and verifies their published checksums. It compiles the actual
production policy/factory. Its eight tests use real local TLS sockets to prove
self-signed/wrong-hostname acceptance only with the enrolled key, wrong-key
rejection before HTTP, next-key acceptance, redirect refusal without forwarding
credentials, HTTP refusal, date-independent key authentication and UTF-8 PUT
registration. The 31 wrapper tests exercise validation,
Response conversion, native absence/failure, bounded bodies, abort and deadlines.

On a Mac, compile the production SPKI reader and standalone synthetic fixture
test without signing or an app build:

```sh
swiftc ios/Pinning.swift test/native/main.swift -o .native-tests/pinning-tests
.native-tests/pinning-tests test/native/leaf.pem
```

The Swift harness checks a Node-calculated SPKI digest, current/next/wrong pins,
noncanonical/duplicate/empty pins, malformed DER and every truncated certificate.
App/native build and simulator acceptance are separate integration checks.
