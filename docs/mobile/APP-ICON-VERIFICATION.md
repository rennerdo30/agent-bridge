# AB-271 launcher icon verification

Verified 2026-10-12 JST on branch `agent-bridge/5d7b235e`, base `054808fe`.
The owner separately confirmed that the preceding scene lifecycle fix launches
on the real iPhone 18 Pro Max / iOS 27.0.1.

## Assets and configuration

- `expo.icon` points to `apps/mobile/assets/icon.png`: 1024×1024 RGB PNG
  (PNG color type 2, no alpha channel), with a centered 768px copy of the logo.
- `expo.android.adaptiveIcon.foregroundImage` points to
  `apps/mobile/assets/adaptive-icon.png`: 1024×1024 RGBA PNG, with a centered
  432px logo and 296px transparent padding on each side. All artwork fits inside
  Android's central safe zone. `backgroundColor` is `#4f46e5`.
- Both use the primary brand color `tokens.color.light.accent`, imported by
  `src/theme.tsx`. The source logo is preserved byte-for-byte: SHA-256
  `e6005f9283254272e8687065046328394a26c1fa958a24d81393c35b9944e2f1`.
- Run `node scripts/generate-icons.cjs` from `apps/mobile` after `npm ci` to
  reproduce the assets using Expo's existing installed image tooling.

Configuration follows [Expo's app-icon documentation](https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/).
An independent read-only review checked configuration, dimensions, opacity,
padding, source preservation, visual appearance and byte-for-byte regeneration.

## Native verification

Used SSH alias `devkit-mac`, as `rennerdo30`, with an isolated build copy at
`/Users/rennerdo30/dkbuild/ab271-icon-20261012-0140`. No spaces or external source
links. Only the build copy sets bundle id `dev.rennerdo30.agentbridge`.

Both root and mobile `npm ci --no-audit --no-fund` completed, followed by
`CI=1 npx --no-install expo prebuild --platform ios --no-install` and `pod install`.
SSH used Homebrew's PATH and `LANG`/`LC_ALL=en_US.UTF-8`.

Generated `ios/agentbridge/Images.xcassets/AppIcon.appiconset/Contents.json`
references `App-Icon-1024x1024@1x.png` with universal iOS idiom and 1024×1024 size.
`sips` reports 1024×1024 and `hasAlpha: no` for the generated PNG.

Unsigned Xcode 27.0 Release build succeeded:

```sh
# In the build copy's apps/mobile:
xcodebuild -workspace ios/agentbridge.xcworkspace -scheme agentbridge \
  -configuration Release -sdk iphonesimulator \
  -destination id=EF0E61A5-DB90-42A8-957F-2515A4E47DE0 \
  -derivedDataPath ../../DerivedData \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

Created and booted a fresh iPhone 18 Pro Max / iOS 27.0 simulator named
`AB271-icon-20261012-0140`, UUID `8C9C5824-FE62-4C54-A920-4FA9D8D35079`.
Installed and launched the app; PID 13231 remained running after 12 seconds.
Then terminated only this test app to return to the home screen. The built
Info.plist names `AppIcon` as its primary icon, and the screenshot visibly shows
the branded icon labeled `agent-bridge` in the second row, fourth column.

Captured using `xcrun simctl io 8C9C5824-FE62-4C54-A920-4FA9D8D35079 screenshot`
and copied back with SCP:
[home-screen screenshot](verification/ab271-ios27-home-icon.png), SHA-256
`d6d82c89449febea00d28a9412b954a815aa6c3df50ad6c758d3e36bed589db0`.
Build, npm, prebuild and pod logs plus the generated AppIcon set remain in the
Mac build copy and locally under `.agent-bridge-test/ab271-icon/`.

App tests **14/14**, client tests **18/18**, and both root/app typechecks pass,
using the same four commands recorded in [scene verification](IOS-SCENE-VERIFICATION.md#regression-checks-and-remaining-acceptance).
No native iOS folder was committed, signing performed, Devkit.app touched, or
user data/foreign process removed. Physical-device icon appearance and Android
launcher rendering were not exercised in this verification.
