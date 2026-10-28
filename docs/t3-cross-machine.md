# Cross-PC T3 messaging acceptance (AB-458)

## Scope and observed defects

Base: `70820a0fd090bd12f8245e9cf7e51db13a78eef0` (`main`). This package changes paired-PC message routing, with no remote task protocol, installed update, provider launch or live other-PC traffic.

On the base, `src/network/link.ts` stripped `PeerInfo.frontend` from peer advertisements. Send frames identified the destination only by its name. A stale advertised name could therefore reach another T3 thread or an ordinary native session without comparing the destination's attested binding. A focused loopback fixture reproduced missing frontend metadata and accepted stale thread/scope/provider/native/missing destinations.

Checking the exact name at network ingress alone was insufficient: `Broker.receiveRemote` also resolves retained aliases. A separate failing fixture showed that an unfenced alias reached a hosted target. The broker now checks the fence again after resolving that alias.

## Implemented routing contract

1. Each local T3 MCP session already attests its frontend to its local T3 host. The network advertises only the validated non-secret binding: `kind`, endpoint scope digest, `threadId`, and `providerInstanceId`. Provider-native `sessionId` remains separate.
2. An optional hello feature, `t3ThreadRouting: true`, negotiates destination fencing. It does not consume a slot in the existing bounded extension capability arrays. Older readers strip the unknown hello field; new senders refuse a T3 send when the destination host does not advertise support. Native-to-native legacy messages remain supported.
3. A negotiated send includes `destination: {peerId, frontend?}` from the paired host's advertisement. Hosted senders require an advertised destination. Immediately before dispatch, the sender refreshes its own peer advertisement so a session reload cannot race the receiver's sender authorization.
4. The receiver compares the destination's exact name, registration ID, and complete frontend binding synchronously before broker storage or emission. Hosted-to-native swaps, missing registrations, changed frontend bindings, and missing fences are rejected. The broker repeats the check after retained-alias resolution. A caller refreshes peers and explicitly selects the intended thread after rejection; the transport does not silently retarget/retry.
5. Normal TLS-PSK pairing and advertised-sender authentication remain authoritative. Neither the sender's nor the destination's T3 endpoint URL or authorization grant travels over the paired-PC link. The binding is a routing fence, not a bearer credential.
6. The destination's existing local `T3Waker` submits a pointer to unread Bridge mail through its locally scoped `T3Host.send`. It targets the attested destination thread, never a provider-native session ID. A wrong-thread receipt is an unknown outcome. Refused/unknown wakes leave mail unread and do not fall back to native CLI wake or automatically replay an admitted operation.
7. Message IDs retain the existing broker content checks and dedupe rules. Reconnect replay recovers the stored receipt without emitting duplicate mail. The persisted local wake journal suppresses duplicate wakes across waker reloads, including refused/unknown outcomes. Inbox consumption remains separate from storage and wake acceptance.

The fixture exercises a live registered destination at ingress. It does not claim new durable per-message frontend ownership across arbitrary later registration/name reuse; registration/backlog recovery remains the existing broker contract and needs a separate audit if that stronger lifetime guarantee is required.

## Reproducible focused evidence

Run only this file from the supplied checkout, using its existing dependencies:

```powershell
node node_modules/vitest/vitest.mjs run test/t3-cross-machine.test.ts --pool=threads --maxWorkers=1 --configLoader=native --testTimeout=10000 --hookTimeout=10000
```

Use an outer 60-second deadline and record the exact runner PID and commit before launching. `threads` uses one in-process worker; the fixture blocks subprocess launch APIs. On Windows, ACL query responses and process creation identity are mocked, so no ACL utility or PowerShell identity probe is launched. These mocks do not certify real ACL enforcement.

`test/t3-cross-machine.test.ts` uses two distinct generated host identities in private fixture directories, authenticated TLS loopback links on ephemeral ports with discovery disabled, the production network parser/routing, real in-memory message storage, the production broker receive/dedupe method with fixture connections, a mocked T3 MCP transport, and real persisted wake journals. It covers:

- Both hosts' frontend advertisements, while provider-native session IDs are deliberately identical.
- Stale thread, scope, provider, registration ID, missing destination, and hosted-to-native replacement rejection before inbox callbacks.
- Legacy unfenced sends, retained-alias bypass rejection, unsupported routing negotiation and native-to-native compatibility.
- Remote sender to the exact destination T3 thread, isolation from another thread on that host, accepted/refused/wrong-receipt wakes, unchanged unread mail, and no native subprocess fallback.
- Reconnect replay, sender reload after hello, message dedupe, and persisted wake dedupe.

## Live acceptance prerequisites (not performed)

- Owner-authorized operation on two reachable PCs with paired/authenticated Bridge hosts containing this change. Record each machine's Bridge and T3 versions and the negotiated feature; an old broker cannot certify exact T3 routing.
- Each destination T3 thread must have its own deliberately injected, locally authorized MCP host transport and matching attested frontend. No token copying, config scraping, or cross-host transport credentials.
- Record sender/destination machine identity, destination frontend/thread, Bridge message ID, stored receipt, local T3 request ID and returned thread/run receipt. Verify that only the named destination thread wakes; then separately read its inbox to prove consumption.
- Exercise stale binding rejection and reconnect on those authorized hosts. Verify idle/busy delivery, refusal behavior, actual MCP waker selection, and restart/backlog behavior separately. The loopback fixture does not prove other-PC reachability, OS permissions, installed transport injection or real provider execution.
