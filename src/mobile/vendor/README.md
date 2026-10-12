qrcode.js is the minified ESM distribution of qrcode-generator **2.0.4**, Copyright Kazuhiko Arase, MIT.
Upstream: https://github.com/kazuhikoarase/qrcode-generator. LICENSE.qrcode.txt preserves the upstream license.
Installed solely in apps/mobile; vendored here so the desktop gateway requires no shared/root installation.
Input SHA256: EA91D7118A5395289170DA848B7C6758B996163BFBCCF312591AB65A4911B7C0.
Regenerate with the existing read-only esbuild CLI:

`node node_modules/esbuild/bin/esbuild apps/mobile/node_modules/qrcode-generator/dist/qrcode.mjs --bundle --minify --format=esm --platform=neutral --outfile=src/mobile/vendor/qrcode.js`

Only desktop QR encoding uses this file; the mobile camera uses Expo. The QR contains no desktop/device credentials or private content.
