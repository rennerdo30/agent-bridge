// Derive launcher assets using the image tooling already installed with Expo.
const { createRequire } = require('node:module');
const path = require('node:path');
const imageRequire = createRequire(require.resolve('@expo/image-utils'));
const Jimp = imageRequire('jimp-compact');
const tokens = require('../src/tokens.json');
const app = require('../app.json').expo;

async function main() {
  const brandBackground = tokens.color.light.accent; // ThemeProvider's primary brand color.
  if (app.android.adaptiveIcon.backgroundColor !== brandBackground) {
    throw new Error('Keep adaptiveIcon.backgroundColor aligned with the theme brand color.');
  }
  const assets = path.resolve(__dirname, '../assets');
  const logo = await Jimp.read(path.join(assets, 'logo.png'));
  const icon = new Jimp(1024, 1024, brandBackground);
  icon.composite(logo.clone().resize(768, 768, Jimp.RESIZE_BICUBIC), 128, 128);
  // RGB PNG, not an RGBA image whose alpha happens to be opaque.
  await icon.colorType(2).writeAsync(path.join(assets, 'icon.png'));

  const foreground = new Jimp(1024, 1024, 0x00000000);
  // Keep all artwork inside Android's central 66/108 safe-zone diameter.
  foreground.composite(logo.clone().resize(432, 432, Jimp.RESIZE_BICUBIC), 296, 296);
  await foreground.colorType(6).writeAsync(path.join(assets, 'adaptive-icon.png'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
