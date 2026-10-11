# AB-271 dependency advisory review

Reviewed 2026-10-11 on `agent-bridge/5d7b235e`, baseline `c7934577`.
This is dependency/source/export evidence, not signed app or physical-device acceptance.

`npm audit --json` reports vulnerable **package entries**, including inherited and cyclic
metavulnerabilities. The mobile total of 22 (15 high, 7 moderate) comes from three distinct
advisories, not 22 distinct exploitable defects. `npm audit --omit=dev` cannot establish
runtime exposure here: Expo installs build tools as production dependencies.

## Compatible remediation

- `npx --no-install expo install --fix`: dependencies already up to date. Registry and
  Expo's installed `bundledNativeModules.json` agree on Expo 57.0.27 / RN 0.86.3 /
  React 19.2.3. No mobile dependency change or override was justified.
- Root MCP SDK: 1.30.1 -> 1.32.1, a stable same-major upgrade.
- Root source-map-js: 1.2.1 -> 1.2.2, within PostCSS's existing `^1.2.1` range,
  using `npm update source-map-js`. No override needed.
- No forced audit fixes, SDK/RN major changes, hand-edited lockfiles, release or merge.
- Supervisor accepted the three mobile residuals and explicitly directed retaining
  SDK 57 / RN 0.86. Revisit **when an upstream patch ships or at the next Expo SDK**.

## Underlying advisories and exploitability

1. **braces — [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)**,
   high, 3.0.3. Path: app -> expo -> @expo/metro -> metro-file-map -> micromatch -> braces
   (also reachable through RN's community CLI). Deeply nested brace patterns can crash
   a Node process. Metro's watcher matches local configured globs; mobile API/chat/QR data
   does not enter it. Absent from both Hermes source maps. **Accepted build-only risk**:
   untrusted build configuration/globs could still trigger the defect. Latest published
   version remains 3.0.3; there is no patched version to override compatibly. Revisit on
   upstream patch or next Expo SDK.
2. **node-forge — [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)**,
   high, 1.4.0. Paths: app -> expo -> @expo/cli -> node-forge and
   app -> expo -> @expo/cli -> @expo/code-signing-certificates -> node-forge.
   Malformed RSA signature encoding may bypass verification with low-exponent keys.
   Expo's tooling verifies signing certificates/signatures; the shipped app uses native
   TLS and expo-crypto, not forge. No expo-updates or custom update signing is configured.
   Absent from both Hermes source maps. **Accepted build-only risk**: future untrusted
   certificate/signature input to Expo tooling needs renewed review. Latest published
   version remains 1.4.0; no patched version exists. Revisit on upstream patch or next SDK.
3. **uuid — [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)**,
   moderate, 7.0.3. Path: app -> expo -> @expo/config-plugins -> xcode -> uuid.
   Advisory concerns supplied output buffers in v3/v5/v6; xcode's `pbxProject.js` calls
   only `uuid.v4()` without an output buffer. Absent from both Hermes source maps.
   **Accepted build-only, unused-API risk**. Patched >=11.1.1 is outside xcode's `^7.0.3`;
   overriding across majors is prohibited and unnecessary for this usage. Revisit on
   upstream xcode/Expo patch, any change to UUID callers, or the next Expo SDK.
4. **Root MCP SDK — [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)**,
   high. Root -> @modelcontextprotocol/sdk. Server/client SDK ships in desktop bridge
   code, not the phone bundle. Advisory requires the SDK OAuth client to trust an
   MCP-selected authorization server. Our source imports stdio transports and does not
   use that OAuth flow. **Fixed** nevertheless by SDK 1.32.1 (patched >=1.31.0).
5. **Root source-map-js — [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)**,
   high. Root -> vitest -> vite -> postcss -> source-map-js. Indexed source-map offsets
   may cause event-loop denial of service. Test/build dependency, not bridge/mobile
   runtime input. **Fixed** by 1.2.2 within the existing compatible range.

These exposure judgments are inferred from installed dependency paths, caller source
and production exports; they are not proof that untrusted build inputs are safe.
Continue using trusted local source/configuration and signing material. Do not expose
Metro/Expo development services publicly. No audit suppression or blanket runtime-risk
acceptance is introduced.

## Every audited package entry

Paths start at the mobile package except the final two root entries. `E` = expo,
`C` = E -> @expo/cli, `M` = E -> @expo/metro, `P` = E -> @expo/config-plugins,
`R` = react-native. The linked JSON records full versions and installed locations.
`B` = inherited braces/Metro finding; `F` = inherited forge finding;
`U` = inherited uuid/xcode finding. All accepted inherited entries have the same
build-only vulnerable code and revisit trigger as their underlying advisory above.

| Package (baseline version) | Severity | Dependency path | Runtime / dev classification | Disposition and reason |
| --- | --- | --- | --- | --- |
| @expo/cli 57.0.28 | High | C | Build/dev; only its Metro `require.js` shim ships | Accepted B/F/U; vulnerable tooling and leaves excluded |
| @expo/code-signing-certificates 0.0.6 | High | C -> @expo/code-signing-certificates | Build/dev only | Accepted F; no upstream forge patch |
| @expo/config 57.0.10 | Moderate | E -> @expo/config | Build/dev only | Accepted U; config-plugin dependency |
| @expo/config-plugins 57.0.10 | Moderate | P | Build/dev only | Accepted U; native project generation |
| @expo/inline-modules 0.1.7 | Moderate | C -> @expo/inline-modules | Build/dev only | Accepted U; config-plugin dependency |
| @expo/local-build-cache-provider 57.0.8 | Moderate | E -> @expo/local-build-cache-provider | Build/dev only | Accepted U; build configuration dependency |
| @expo/metro 56.0.2 | High | M | Build/dev only | Accepted B; no upstream braces patch |
| @expo/metro-config 57.0.13 | High | E -> @expo/metro-config | Build/dev only | Accepted B/U; bundler/config dependencies |
| @expo/prebuild-config 57.0.17 | Moderate | C -> @expo/prebuild-config | Build/dev only | Accepted U; native project configuration |
| @react-native/community-cli-plugin 0.86.3 | High | R -> @react-native/community-cli-plugin | Build/dev only | Accepted B; Metro dependency |
| @react-native/virtualized-lists 0.86.3 | High | R -> @react-native/virtualized-lists | Runtime package; vulnerable path build-only | Accepted B; cyclic RN dependency, no independent advisory |
| braces 3.0.3 | High | M -> metro-file-map -> micromatch -> braces | Build/dev only | Accepted; no patch, configured local glob inputs |
| expo 57.0.27 | High | E | Runtime package; vulnerable paths build-only | Accepted B/F/U; no vulnerable leaves exported |
| metro 0.84.5 | High | M -> metro | Build/dev only | Accepted B; inherited watcher finding |
| metro-config 0.84.5 | High | M -> metro-config | Build/dev only | Accepted B; cyclic Metro dependency |
| metro-file-map 0.84.5 | High | M -> metro-file-map | Build/dev only | Accepted B; configured local glob matching |
| metro-transform-worker 0.84.5 | High | M -> metro-transform-worker | Build/dev only | Accepted B; inherited Metro finding |
| micromatch 4.0.8 | High | M -> metro-file-map -> micromatch | Build/dev only | Accepted B; braces dependency, no patch |
| node-forge 1.4.0 | High | C -> node-forge; C -> @expo/code-signing-certificates -> node-forge | Build/dev only | Accepted; no patch; no phone forge/TLS usage |
| react-native 0.86.3 | High | R | Runtime package; vulnerable path build-only | Accepted B; CLI dependency and cyclic lists entry |
| uuid 7.0.3 | Moderate | P -> xcode -> uuid | Build/dev only | Accepted U; xcode uses v4, patched major incompatible |
| xcode 3.0.1 | Moderate | P -> xcode | Build/dev only | Accepted U; only v4 caller used |
| Root @modelcontextprotocol/sdk 1.30.1 | High | root -> @modelcontextprotocol/sdk | Desktop runtime, absent from phone | Fixed 1.32.1; OAuth path unused in bridge |
| Root source-map-js 1.2.1 | High | root -> vitest -> vite -> postcss -> source-map-js | Test/build only | Fixed 1.2.2; compatible patch |

## Evidence and verification

Raw [baseline/final audit JSON and dependency paths](../../docs/mobile/dependency-audit/)
are retained in the commit. Bundle exposure comes from `expo export --source-maps`
with Hermes bytecode enabled: Android 691 modules; iOS 678 modules. Both maps contain
zero braces, forge, uuid, xcode, Metro tooling, config-plugin or community-CLI sources.
Expo/RN/virtualized-lists do ship; @expo/cli contributes one standalone Metro module
loader shim (`build/metro-require/require.js`), which imports none of the vulnerable leaves.

Commands (root unless noted):

```powershell
npm audit --json --cache .agent-bridge-test/npm-cache
# apps/mobile:
npm audit --json --cache .npm-cache
npx --no-install expo install --fix
npm run check:compatibility
npm run typecheck
npx --no-install expo export --platform android --platform ios --source-maps --output-dir .expo/ab271-dependency-export --max-workers 2
# root:
npm run typecheck
node node_modules/vitest/vitest.mjs run --config apps/mobile/vitest.config.ts
node scripts/test.mjs all test/mobile-client.test.ts test/mobile-activation.test.ts test/mobile-adapter.test.ts test/mobile-config.test.ts test/mobile-gateway.test.ts test/mobile-push.test.ts test/mobile-owner-startup.test.ts test/mobile-wiring.test.ts test/mobile-owner-question-compatibility.test.ts
npm run test:all
```

- App tests: 14/14 across 4 files.
- Focused root mobile tests: 131/131 across 9 files (includes all 18 client tests).
- Root and app typechecks: clean.
- Android and iOS production Hermes exports: successful.
- Full root suite: 2,126 pass / 3 fail / 3 skip (287 files, 2,132 tests).
  The failures are the takeover fixture startup deadline, the existing mobile retention
  guard violation, and the existing opencode tool-name assertion at test:184.
  Three isolated takeover reruns each pass 4/4 (80.74s, 95.00s, 81.06s), so the
  supervisor's approved disposition is a load flake. No SDK regression was detected.
  Results are recorded in the linked verification JSON.
- Opencode comparison: origin/main `40fbf0a4` passes 12/12; this branch passes 11/12.
  This is a branch merge blocker, left unchanged in dependency scope.
- Baseline retention failure: isolated guard 6/7. The separate, authorized follow-up
  now retains push tombstones and ciphertext, including replacements. Final retention
  guard 7/7 and focused mobile/retention tests 148/148 (11 files), including all five
  revocation triggers and 18 client tests. The guard whitelist is unchanged. See
  [historical callers and implemented archive repair](../../docs/mobile/RETENTION-REVIEW.md).
- Design cleanup: app 14/14, client 18/18, both typechecks and both Hermes exports pass.
  A syntax comparison found all 22 formatting/import-only files unchanged; only
  strings.ts, view-model.ts and useDashboard.ts intentionally change expressions.
  Final retention changes also pass app 14/14, both typechecks and the local root build.
  The entire root suite was not repeated after these follow-ups; the opencode assertion
  remains the known branch merge blocker.
- Local root build: successful. Generated dist was restored after checking; release
  must rebuild desktop distributions from the updated lockfile.
- Root audit: 2 high -> 0. Mobile audit: 22 unchanged, 15 high / 7 moderate.
- No signed native build, TLS/device/push/lifecycle acceptance is claimed.

Root dependencies were installed privately only after supervisor authorization to unlink
this worktree's root node_modules junction. Verified ReparsePoint + Junction first, used
`[IO.Directory]::Delete(path, $false)` on the link only, and confirmed the shared target
remained present with 4,944 files before and after. No target files, other worktrees,
user data, handoff or TODO files were changed.
