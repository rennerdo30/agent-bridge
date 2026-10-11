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

The prepared host uses the broker's local read projection, real question store, completion callback and receipt-enriched `service.list()`. The existing work tick recovers a persisted answer after completion callback failure. Gateway push registration/tap and explicit hint polling share the same configured provider object. Provider submission still means only submission state; native receipt/delivery/acceptance is unproven.

Every HTTPS listener remains unbound. A future reviewed owner caller must provision approved LAN/Tailscale origins, trusted TLS material and private bind addresses before explicit activation. LAN CA trust installation belongs to the owner; no validation bypass or pinning is implemented. Provider scheduling/material, configuration discovery and certificate loading are also caller responsibilities, not hidden defaults. This package reads no owner credentials and performs no activation.

On broker/node ownership loss, readiness fails and mobile disposal disables operations, retires owned listeners and drains in-flight hints before closing its registry. The broker retains ownership of its unchanged question service and closes it afterward. The successor must explicitly prepare with the same durable PC registry and reviewed origins. The phone reconnects, authenticates PC/device identity and fetches a new authoritative snapshot; no ambiguous credential issuance, rotation or answer is retried automatically.

`test/mobile-wiring.test.ts` proves real synthetic service/store recovery and fixture desktop HTTP authentication, plus configured push through an in-process fake provider/client transport. Its HTTPS lifecycle and broker endpoint ownership are simulated. Real process handover, trusted TLS on both platforms, secure device storage, actual provider delivery and distribution await owner/device acceptance.
