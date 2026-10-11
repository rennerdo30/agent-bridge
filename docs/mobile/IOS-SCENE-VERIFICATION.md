# AB-271 iOS scene lifecycle verification

Verified 2026-10-12 JST on `devkit-mac`, starting from branch
`agent-bridge/5d7b235e`, base `0e9a136a953a086e8d7a7a930243f535171f109d`,
with the `apps/mobile/app.json` scene option added.

## Supported fix

Expo SDK 57 defaults to the application lifecycle. The iOS 27 SDK requires the
scene lifecycle, which explains the reported main-thread UIKit breakpoint.
Enable `ios.enableSceneSupport: true` in the existing `expo-build-properties`
plugin entry. The installed/locked versions already support it:

- Expo 57.0.27: scene runtime backported in 57.0.23
  ([changelog](https://github.com/expo/expo/blob/sdk-57/packages/expo/CHANGELOG.md),
  [PR #50191](https://github.com/expo/expo/pull/50191)).
- Build properties 57.0.22: option added in 57.0.19, plugin composition fixed in
  57.0.20 ([changelog](https://github.com/expo/expo/blob/sdk-57/packages/expo-build-properties/CHANGELOG.md),
  [PR #50205](https://github.com/expo/expo/pull/50205)).
- React Native 0.86.3: retained unchanged; Expo supplies the scene integration.
  Reviewed the [RN release/changelog](https://github.com/react/react-native/releases/tag/v0.86.3),
  Expo's [SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/sdk/build-properties/#pluginconfigtypeios),
  [migration guide](https://github.com/expo/fyi/blob/main/ios-scene-lifecycle.md),
  and [earlier incomplete scene migration report #47570](https://github.com/expo/expo/issues/47570).

Fresh prebuild produced `AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider`
with factory initialization but no legacy `startReactNative` call in launch.
Generated and built Info.plist both contain `UIApplicationSceneManifest`,
`UIApplicationSupportsMultipleScenes = false`, and the application scene
configuration with `UISceneDelegateClassName = EXExpoAppSceneDelegate`.
SDK 57 uses Expo's built-in scene delegate, without a generated SceneDelegate.swift.
No dependency update, custom config plugin, or committed native folder is required.

## Mac build and runtime evidence

Build copy: `/Users/rennerdo30/dkbuild/ab271-20261012-0113`, extracted from a Git
archive plus the changed app.json. Only this disposable copy sets
`ios.bundleIdentifier = dev.rennerdo30.agentbridge`.

Tools: Xcode 27.0 (27A266a), Node 26.9.0, npm 11.19.1, CocoaPods 1.17.0.
SSH ran as `rennerdo30`; local command context was `desktop-pc\renne`.

Executed with `PATH=/opt/homebrew/bin:/usr/local/bin:$PATH`, `LANG=en_US.UTF-8`,
and `LC_ALL=en_US.UTF-8`:

```sh
# From the isolated build copy:
npm ci --no-audit --no-fund
cd apps/mobile
npm ci --no-audit --no-fund
# Set the test bundle identifier in this copy only.
CI=1 npx --no-install expo prebuild --platform ios --no-install
cd ios
pod install
cd ..
xcodebuild -workspace ios/agentbridge.xcworkspace -scheme agentbridge \
  -configuration Release -sdk iphonesimulator \
  -destination id=EF0E61A5-DB90-42A8-957F-2515A4E47DE0 \
  -derivedDataPath ../../DerivedData \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

Both clean npm installs completed. Prebuild succeeded. Pod install succeeded
(95 Podfile dependencies, 94 installed pods). The initial pod attempt failed
because SSH had no UTF-8 locale; rerunning with the locale above resolved it.
Xcode reported `BUILD SUCCEEDED`; built SDK is `iphonesimulator27.0` and the
Release app contains `main.jsbundle`, so Metro is unnecessary.

Created and booted a new isolated simulator named `AB271-20261012-0113`:
iPhone 18 Pro Max, iOS 27.0 (24A434), UUID
`EF0E61A5-DB90-42A8-957F-2515A4E47DE0`. Installed the Release app using
`xcrun simctl install`, then launched with `xcrun simctl launch`.

PID 131 stayed alive through every one-second sample to elapsed **16 seconds**;
a subsequent check still showed the same app/PID at elapsed 44 seconds.
The screenshot shows the rendered pairing screen. No new `agentbridge*` crash
report appeared in the observation window, and collected app logs contain no
NoSceneLifecycle/EXC_BREAKPOINT/fatal termination marker. UIKit logs show a
UIWindowScene and React Native evaluates the bundled JavaScript. Existing
background-fetch/remote-notification mode warnings remain outside this launch fix.

Captured with `xcrun simctl io booted screenshot` and copied back via SCP:

- [Simulator screenshot](verification/ab271-ios27-scene.png), SHA-256
  `8f83093d75826126135832910f86af6cedfe7cd7ae0b36264d828c332b42424a`.
- [Runtime observations and artifact hashes](verification/ab271-ios27-runtime.txt).
- Full build/prebuild/npm/pod logs, generated delegates/plists and app logs are
  retained in the Mac build copy and locally in `.agent-bridge-test/ab271-ios/`.

Devkit.app was untouched. No signing, keychain access, provisioning, foreign
process termination, or cleanup was performed. The build copy and private
simulator are retained.

## Regression checks and remaining acceptance

Executed in the Windows worktree:

```powershell
node node_modules/vitest/vitest.mjs run --config apps/mobile/vitest.config.ts
node node_modules/vitest/vitest.mjs run test/mobile-client.test.ts --maxWorkers=1
npm run typecheck
npm --prefix apps/mobile run typecheck
```

App tests **14/14**, client tests **18/18**, root and app typechecks pass.
This proves unsigned iOS 27 simulator launch and visible UI with scene adoption.
The physical iPhone 18 Pro Max / iOS 27.0.1 must still be rebuilt and checked by
the owner; physical-device, pairing/TLS, push, background and deep-link acceptance
are not established by this simulator launch check.
