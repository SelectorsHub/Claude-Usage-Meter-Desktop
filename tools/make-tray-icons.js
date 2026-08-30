'use strict';

/**
 * Regenerate every tray icon from assets/logo.svg.
 *
 *   npm install --save-dev sharp
 *   npm run icons
 *
 * The committed icons in assets/tray/ are already built — you only need this
 * after changing the logo.
 *
 * Three decisions are baked in here, each learned by rendering and looking:
 *
 *  1. The sun disc and Claude burst are DROPPED for the tray. In a macOS
 *     template image the white burst has to be knocked out of the disc, which
 *     leaves a sliver that disappears below ~48px. At 16 and 32 they contribute
 *     nothing but mud, so the tray glyph is the gauge and needle alone.
 *
 *  2. The artwork is trimmed to its bounding box and rescaled to fill. The
 *     256 canvas is sized around the disc; without it, a third of the box is
 *     empty and the gauge renders a third smaller than it could.
 *
 *  3. Windows recolours the GAUGE rather than adding a status badge. A badge
 *     large enough to see at 16px covers the logo entirely.
 */

const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch (err) {
  console.error('Missing dependency. Run:  npm install --save-dev sharp');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'tray');

// Geometry lifted from assets/logo.svg. Keep in sync if the logo changes.
const GRAY_ARC = 'M 76.345,91.094 A 168.960,168.960 0 0 1 209.920,25.600';
const CORAL_ARC = 'M 46.325,236.800 A 168.960,168.960 0 0 1 76.345,91.094';
const NEEDLE = '201.871,163.230 93.548,104.419 177.572,194.600';
const STROKE = 52;

const STATES = {
  normal: '#d97757',
  warn: '#e89830',
  danger: '#e24c3e',
  stale: '#8c8c94',
};

const SIZES = [{ px: 16, suffix: '' }, { px: 32, suffix: '@2x' }];

function gaugeSvg(fill, track, trackOpacity) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
       <path d="${GRAY_ARC}" stroke="${track}" stroke-opacity="${trackOpacity}"
             stroke-width="${STROKE}" fill="none"/>
       <path d="${CORAL_ARC}" stroke="${fill}" stroke-width="${STROKE}" fill="none"/>
       <polygon points="${NEEDLE}" fill="${fill}"/>
     </svg>`,
  );
}

async function write(svg, px, file) {
  // Render large, trim to the artwork, then fit into the icon box with a hair
  // of padding so antialiasing doesn't clip against the edge.
  const trimmed = await sharp(svg, { density: 900 })
    .resize(px * 8, px * 8)
    .trim()
    .toBuffer();

  const inner = Math.round(px * 0.92);
  const fitted = await sharp(trimmed)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  await sharp({
    create: { width: px, height: px, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: fitted, gravity: 'center' }])
    .png()
    .toFile(path.join(OUT, file));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const { px, suffix } of SIZES) {
    // macOS template: black plus alpha. The OS recolours it for light mode,
    // dark mode and the highlighted state, so colour here would be discarded.
    // The track keeps partial alpha so filled vs unfilled survives that.
    await write(gaugeSvg('#000000', '#000000', 0.38), px, `trayTemplate${suffix}.png`);
    for (const [name, colour] of Object.entries(STATES)) {
      await write(gaugeSvg(colour, '#aaaaaf', 1), px, `${name}${suffix}.png`);
    }
  }
  console.log(`Wrote ${SIZES.length * (Object.keys(STATES).length + 1)} icons to assets/tray/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
