# Programmatic mobile host integration

This entry is implemented for a reviewed in-process caller, with owner-facing activation still pending a separate package. Nothing in CLI main, MCP or config parsing invokes it. Preparation does not bind HTTPS, read certificate/key/provider files, discover environment configuration or schedule polling.

```ts
import { prepareMobileDesktopHost, type MobileHostConfig } from "./host.js";
import { DashboardController } from "../cli/dashboard.js";

// Inputs belong to the existing broker-owning process and explicit owner configuration.
// node must already own its broker and that broker's existing OwnerQuestionService.
// config contains registryFile, stable pcId, approved HTTPS origins, exact desktopOrigin,
// optional private listener configs with supplied trusted TLS material, and optional push.
async function prepare(node: import("./host.js").MobileHostNode,
  config: MobileHostConfig, desktop: { home: string; pipe: string; port: number;
    log: import("../core/logger.js").Logger }) {
  const host = await prepareMobileDesktopHost(node, config);
  const dashboard = new DashboardController({ ...desktop, mobileAdmin: host.desktopAdmin });
  try {
    const info = await dashboard.ensure(); // Explicit existing loopback desktop UI only.
    return { host, dashboard, info };
  } catch (error) {
    await dashboard.close(); await host.close(); throw error;
  }
}
```

This snippet documents caller integration and is not invoked by this package. The desktop port must match `config.desktopOrigin` exactly; there is no fallback or adoption of another process's dashboard. If an uninjected dashboard already exists, the caller must resolve ownership through the next reviewed startup package. A missing existing question service is unsupported: mobile never creates or owns it.

The existing broker service is lazy: its private `ownerQuestions()` initializes it on ordinary owner-question use, while broker startup initializes it only if the owner-question store file already exists. A fresh broker without that file/service therefore cannot use this borrowed-only entry yet. Explicit opt-in service initialization belongs to the next reviewed activation scope, not an implicit side effect of preparation.

The prepared host uses the broker's local read projection, real question store, completion callback and receipt-enriched `service.list()`. The existing work tick recovers a persisted answer after completion callback failure. Gateway push registration/tap and explicit hint polling share the same configured provider object. Provider submission still means only submission state; native receipt/delivery/acceptance is unproven.

Every HTTPS listener remains unbound. A future reviewed owner caller must provision approved LAN/Tailscale origins, trusted TLS material and private bind addresses before explicit activation. LAN CA trust installation belongs to the owner; no validation bypass or pinning is implemented. Provider scheduling/material, configuration discovery and certificate loading are also caller responsibilities, not hidden defaults. This package reads no owner credentials and performs no activation.

On broker/node ownership loss, readiness fails and mobile disposal disables operations, attempts retirement of every owned listener, drains admitted gateway handlers and in-flight hints, then closes its registry. Node loss and broker close share one cached disposal promise; the broker registration remains until mobile close completes. On successful disposal the broker closes its unchanged question service afterward. The successor must explicitly prepare with the same durable PC registry and reviewed origins. The phone reconnects, authenticates PC/device identity and fetches a new authoritative snapshot; no ambiguous credential issuance, rotation or answer is retried automatically.

All listener-close results settle before mobile close and unregister, even if one listener throws. Failures are collected and returned as an `AggregateError` with a fixed message after that cleanup. A listener whose close failed may remain bound but its dispatcher is disabled; successful unbinding of that failed listener is not claimed. Broker close invoked through that rejecting disposer does not reach its borrowed-service/store close. Repeated host close returns the same rejected promise, without automatic retry. Node loss contains the rejection; activation must expose safe failure state in its separately reviewed lifecycle.

Gateway close tracks admitted handler promises and waits at most five seconds after deactivation; new requests immediately return content-free 503. Late responses also become 503, including an already-committed answer: durable intent remains recorded and its transport outcome is unconfirmed. Timeout emits only a new request ID and the fixed `gateway_shutdown_timeout` category, then rejects; mobile still retires its registry and unregisters. Existing local source guards prevent resumed reads from accessing the retired question service/registry. The timeout is a bounded wait, not cancellation of underlying read operations or an assurance that an arbitrary supplied adapter settled. Hint polling is separately awaited; the concrete Expo adapter has its own ten-second transport deadline, while custom provider deadline enforcement remains caller-owned. No new timeout or schedule is added to the borrowed question service.

`test/mobile-wiring.test.ts` proves real synthetic service/store recovery and fixture desktop HTTP authentication, plus configured push through an in-process fake provider/client transport. Its HTTPS lifecycle and broker endpoint ownership are simulated. Real process handover, trusted TLS on both platforms, secure device storage, actual provider delivery and distribution await owner/device acceptance.
