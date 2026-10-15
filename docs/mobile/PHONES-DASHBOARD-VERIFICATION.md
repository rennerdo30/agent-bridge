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

Fresh capture passed at exact source `5e28e4646bff15f4fc60d34dbbcefba4a4138a1b`, checkout tree `6d4b5254359d07ec914a228b62ac3e7742f491e6`, in [hosted run 38599917949](https://github.com/rennerdo30/agent-bridge/actions/runs/38599917949). It passed 57 scoped integration and 11 script/pinned-TLS tests (68 tests, seven files), then captured all 16 PNGs with no console/page/unexpected-request errors.

- Artifact: `11912737777`, name `phones-dashboard-5e28e4646bff15f4fc60d34dbbcefba4a4138a1b`, archive digest `sha256:5ed73ca69f2fa4457fb34cd70ba7ea83f4a088ba35edbf6e21936238980a50d6`.
- Rendered HTML SHA256: `3ce63dd5edb94e605865d8111477774137fca7cf6fae0142ea11b2d178d5614f`; fixture SHA256: `aacce84ae67636986b17c4d445aa0134f131ef1218f17bd556d7590f4a5e0f07`.
- Playwright/core `1.64.1`, Chromium `156.0.8078.4`, Node `v24.21.0`, esbuild `0.28.2`; UTC/en-US, fixed time `1800000000000`, scale1, reduced motion, disabled screenshot animations.
- [Original hosted manifest](verification/phones-dashboard-rebased-manifest.json) is copied byte-for-byte, SHA256 `c6183de86b6b02b1ffa86e28eb6b21c8422a9f8072f2ccdfc6080ce03deb70c5`. Its original artifact filenames map to committed names by replacing only `phones-dashboard-` with `phones-dashboard-rebased-`.
- All 16 downloaded PNGs and the fixture/HTML files matched their manifest hashes; all 16 new committed PNG copies matched again. Sampled visual inspection covered list, QR, default/projects/Advanced, narrow Advanced, Network and side-by-side states. Claude's independent screenshot review remains required.

Fresh light/dark image pairs (the first link of each pair is light):

| State | Light | Dark |
| --- | --- | --- |
| Phones list | [light](verification/phones-dashboard-rebased-phones-light.png) | [dark](verification/phones-dashboard-rebased-phones-dark.png) |
| QR | [light](verification/phones-dashboard-rebased-qr-light.png) | [dark](verification/phones-dashboard-rebased-qr-dark.png) |
| Default whole PC | [light](verification/phones-dashboard-rebased-claim-default-light.png) | [dark](verification/phones-dashboard-rebased-claim-default-dark.png) |
| Selected projects | [light](verification/phones-dashboard-rebased-claim-projects-light.png) | [dark](verification/phones-dashboard-rebased-claim-projects-dark.png) |
| Advanced sessions | [light](verification/phones-dashboard-rebased-claim-advanced-light.png) | [dark](verification/phones-dashboard-rebased-claim-advanced-dark.png) |
| Narrow Advanced | [light](verification/phones-dashboard-rebased-claim-advanced-mobile-light.png) | [dark](verification/phones-dashboard-rebased-claim-advanced-mobile-dark.png) |
| Network | [light](verification/phones-dashboard-rebased-network-light.png) | [dark](verification/phones-dashboard-rebased-network-dark.png) |
| Side-by-side | [light](verification/phones-dashboard-rebased-side-by-side-light.png) | [dark](verification/phones-dashboard-rebased-side-by-side-dark.png) |

Earlier failed capture runs `38599185836`/`38599605496` are retained. The first synthetic state omitted required `messages`; the second helper targeted an input covered by its existing toggle track. Commits `55d87c0201b0677a26e90ee17afd84573225fe0e` and `5e28e4646bff15f4fc60d34dbbcefba4a4138a1b` correct the fixture and use the visible label with a checked=true assertion. No product redesign, forced click or assertion/deadline changes. Partial diagnostic artifact `11913122304` is failed evidence, not accepted screenshots.

Root approved a separate capture commit: `.github/workflows/phones-dashboard-capture.yml`, `scripts/capture-phones-dashboard.mjs`, and a dev-only exact Playwright dependency/lock addition. The existing CI workflow stays unchanged. Hosted Ubuntu capture renders actual source with deterministic intercepted synthetic endpoints; no owner bridge or application server runs. Unexpected requests, console/page errors and assertion failures refuse a positive capture claim.

Playwright `1.64.1` and `playwright-core` `1.64.1` were verified against [Playwright npm metadata](https://registry.npmjs.org/playwright/1.64.1) and [core npm metadata](https://registry.npmjs.org/playwright-core/1.64.1). Both require Node >=20; the hosted job uses Node24 and the [official CI browser-install workflow](https://playwright.dev/docs/ci). Only these two dev dependency records are added; no installed owner tooling changes.

The artifact manifest must name source head, actual checkout commit/tree, source/rendered HTML/fixture hashes, browser/dependency versions, time/theme/viewport parameters, each PNG hash, and synthetic-only limits. Fresh light/dark Phones list, claim default/projects, Advanced, Network and side-by-side images must come from that exact hosted artifact. Old PNGs must not be relabelled. Any later committed PNG must match hosted bytes and preserve the manifest/run/artifact receipt.

**Current verification:** source audit, `git diff --check`, 68 focused hosted tests and the hosted capture above. The later evidence-only commit preserves every captured executable source blob and adds PNGs/provenance; it does not pretend the capture ran from that later tree. No local tests, typecheck, build, JS imports, browser, application server, native/device/provider or live bridge probes were run.

**Pending:** full exact-head hosted CI/typecheck/build; separately scoped generated packaging; independent Sol source/security review; Claude screenshot/final review; physical phone pairing, signed SecureStore, TLS/lifecycle/reconnect/revocation and owner runtime acceptance. No ready/merge/release is authorized by this package.
