# 0.30.4 version audit

Audit date: 2026-10-09. Conservative eligibility cutoff: 2026-09-25 00:00 UTC.
Primary npm registry metadata was queried directly. No direct dependency has a newer eligible stable release.

| Dependency | Retained pin | Decision |
|---|---|---|
| @modelcontextprotocol/sdk | 1.30.1 | September 23; 1.31.0 September 28 and 1.32.1 October 5 excluded |
| zod | 4.6.5 | September 13; newest stable |
| @types/node | 26.6.3 | Existing September 25 pin retained; 26.6.4 October 1 excluded |
| esbuild | 0.28.2 | August 8; newest stable |
| typescript | 7.0.2 | July 8; newest stable |
| vitest | 5.0.2 | Existing September 25 pin retained; 5.0.3 September 30 excluded |

The cutoff applies to upgrades; existing pins are not downgraded. Node 22/24 compatibility remains.

## Actions evidence and major changes

- [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), July 20, pinned `3d3c42e5aac5ba805825da76410c181273ba90b1`.
- [setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0), July 14, pinned `820762786026740c76f36085b0efc47a31fe5020`.
- [configure-pages v6.0.0](https://github.com/actions/configure-pages/releases/tag/v6.0.0), March 25, pinned `45bfe0192ca1faeb007ade9deae92b16b8254a0d`.
- [upload-pages-artifact v5.0.0](https://github.com/actions/upload-pages-artifact/releases/tag/v5.0.0), April 10, pinned `fc324d3547104276b827a68afc52ff2a11cc49c9`.
- [deploy-pages v5.0.1](https://github.com/actions/deploy-pages/releases/tag/v5.0.1), September 1, pinned `368f82528645a54fb793d4d04e342629a3f51346`.

CI checkout/setup-node move from v4. Hosted runners support the current action runtime. Checkout's unsafe-event restrictions concern pull_request_target/workflow_run; this workflow uses push/pull_request. Setup-node no longer injects a dummy authentication token; this workflow has no registry-url or token-fallback dependency. The major change evidence was posted on AB-168 before editing. Docs already used these majors; patch pins are now immutable.

## Retained advisories

`npm audit` reports two high advisories. Under the owner's strict age limit, neither available fix is eligible:

- [SDK OAuth advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h): fixed in 1.31.0 on September 28.
- [source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q): fixed in 1.2.2 on September 30.

No automatic audit fix or age exception was applied. Full-suite evidence and all-platform CI are separate gates; this audit does not assert installed acceptance.
