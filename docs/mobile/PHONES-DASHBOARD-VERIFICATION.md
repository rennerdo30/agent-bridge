# Phones dashboard PR10 evidence

This is a source wiring package for the finished, approved Opus dashboard UI. It is not a release or real-device acceptance receipt.

## Source and history

- Existing branch: `ui/phones-in-dashboard`, draft [PR10](https://github.com/rennerdo30/agent-bridge/pull/10).
- Finished UI parent: `532bbd702040c76dd93e9cbe79da190bc49e3925`.
- Released main, verified against the remote before integration: `0761d56fe4c36e505550f9b889841fdf8e82c80a` (0.30.15).
- Normal merge: `b47b79332402e30cfda1f08ae18c40eb2306e373`, with those two parents in that order. No rebase or history replacement.
- Merge had no conflicts. Released jobs/server/dashboard transport and generated plugin trees were inherited unchanged from released main. Existing Phones additions remain in history.

## Authored fence

The wiring commit changes only `src/cli/ui-page.ts`, `test/mobile-grant-scopes.test.ts`, `test/mobile-adapter.test.ts`, `test/mobile-phones-dashboard.test.ts`, and this document. Audit found existing desktop validation sufficient for the added hostile-input regressions; `src/mobile/desktop.ts` needs no new change.

The existing controls, styles, labels, layout and default whole-PC grant remain. The script prunes removed server IDs, refuses expired/busy claim actions, guards concurrent invitation/revoke writes, and describes transport failures as unknown outcomes. It does not retry mutations automatically.

Regressions exercise the actual Phones script through synthetic DOM/HTTP seams; authoritative backend scopes, answer opt-in/CAS, project isolation, revocation during an awaited snapshot, opaque IDs and folder privacy use separate gateway/adapter fixtures. Old assertions and deadlines are retained. Project selection sends opaque backend IDs, never desktop folders. Legacy grants still name exact sessions/jobs and owner-question projects; all/project scopes include future entities.

## Baseline attribution

No baseline hash, assertion or normalizer is changed by this package.

- `test/fixtures/mobile-wiring-baseline.json` remains blob `aa032502b24179798c282ffd3e6df3fe1e381029` from both supplied parents. Its historical AB280 and AB281/revert attribution remains intact.
- `test/fixtures/mobile-activation-baseline.json` remains blob `0dff5a3689dfbba27c279e7bbb9f1662f855517b` from both supplied parents.
- Released main introduces no changes to pinned `src/core/broker.ts`, `src/core/node.ts`, `src/cli/dashboard.ts` or `src/cli/ui.ts` between `7adb4817` and `0761d56f`. No pin refresh follows this merge.
- Finished UI commit `532bbd702040c76dd93e9cbe79da190bc49e3925` adds the Phones CSS/HTML/script and changes `mobileDashboardPage` inside the existing opt-in block stripped by the unchanged `mobile-owner-startup` pin assertion. The complete default `UI_PAGE` remains outside that block and unchanged.
- This package changes only Phones script content inside that same opt-in block. It neither changes the released default dashboard source nor removes anything else from pin coverage.

If hosted CI reports a different pin, stop and attribute the exact source commit before proposing any update; never weaken the normalizer or assertion.

## Screenshot provenance and remaining gates

The committed `verification/phones-dashboard-*.png` images inherited from `532bbd70` remain historical evidence. They are **not fresh evidence for the merged or corrected source**. The retained old CI run [38352669826](https://github.com/rennerdo30/agent-bridge/actions/runs/38352669826) has no artifacts; its six test lanes passed, while its Ubuntu24 committed-bundle check failed. That is not current-head acceptance.

Root approved a separate capture commit: `.github/workflows/phones-dashboard-capture.yml`, `scripts/capture-phones-dashboard.mjs`, and a dev-only exact Playwright dependency/lock addition. The existing CI workflow stays unchanged. Hosted Ubuntu capture renders actual source with deterministic intercepted synthetic endpoints; no owner bridge or application server runs. Unexpected requests, console/page errors and assertion failures refuse a positive capture claim.

Playwright `1.64.1` and `playwright-core` `1.64.1` were verified against [Playwright npm metadata](https://registry.npmjs.org/playwright/1.64.1) and [core npm metadata](https://registry.npmjs.org/playwright-core/1.64.1). Both require Node >=20; the hosted job uses Node24 and the [official CI browser-install workflow](https://playwright.dev/docs/ci). Only these two dev dependency records are added; no installed owner tooling changes.

The artifact manifest must name source head, actual checkout commit/tree, source/rendered HTML/fixture hashes, browser/dependency versions, time/theme/viewport parameters, each PNG hash, and synthetic-only limits. Fresh light/dark Phones list, claim default/projects, Advanced, Network and side-by-side images must come from that exact hosted artifact. Old PNGs must not be relabelled. Any later committed PNG must match hosted bytes and preserve the manifest/run/artifact receipt.

**Current verification:** source audit and `git diff --check` only. No local tests, typecheck, build, JS imports, browser, application server, native/device/provider or live bridge probes were run.

**Pending:** fresh exact-head hosted tests/typecheck/build, capture and downloaded artifact inspection; separately scoped generated packaging; independent Sol source/security review; Claude screenshot/final review; physical phone pairing, signed SecureStore, TLS/lifecycle/reconnect/revocation and owner runtime acceptance. No ready/merge/release is authorized by this package.
