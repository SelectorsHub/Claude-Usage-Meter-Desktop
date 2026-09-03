'use strict';

/**
 * Draw usage numbers directly into the tray icon.
 *
 * Windows has no text API for the notification area — an app gets a small
 * square image and a tooltip, and that is the whole contract. So to put numbers
 * "outside" on Windows the way macOS puts them in the menu bar, the numbers
 * have to BE the icon.
 *
 * Everything here is done by hand into a raw BGRA buffer and handed to
 * nativeImage.createFromBitmap. No canvas (unavailable in the main process), no
 * image library (would add a native dependency to the installer), no
 * pre-generated PNGs for all 101 values in four colours.
 *
 * The hard constraint: the notification area renders at 16 logical pixels
 * whatever the DPI. Two digits is the practical maximum — three turns to mush.
 * That is why each meter gets its own icon rather than one icon trying to say
 * "S42 W18 F7".
 */

// 5x7 bitmap digits. Wider than a 3x5 font and legible when scaled to fill a
// 32px icon, which is what a 16pt slot asks for on a 2x display.
const GLYPHS = {
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

const COLOURS = {
  normal: [0xd9, 0x77, 0x57],
  warn: [0xe8, 0x98, 0x30],
  danger: [0xe2, 0x4c, 0x3e],
  stale: [0x8c, 0x8c, 0x94],
};

class Bitmap {
  constructor(size) {
    this.size = size;
    // BGRA, which is what createFromBitmap expects.
    this.data = Buffer.alloc(size * size * 4, 0);
  }

  set(x, y, [r, g, b], a = 255) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    // Source-over onto whatever is already there, so anti-aliased edges from
    // the rounded rect do not get punched out by the glyphs.
    const sa = a / 255;
    const da = this.data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    const mix = (src, dst) => Math.round((src * sa + dst * da * (1 - sa)) / oa);
    this.data[i] = mix(b, this.data[i]);
    this.data[i + 1] = mix(g, this.data[i + 1]);
    this.data[i + 2] = mix(r, this.data[i + 2]);
    this.data[i + 3] = Math.round(oa * 255);
  }

  /** Rounded rectangle with a cheap 3x3 supersample on the corners only. */
  roundedRect(x0, y0, x1, y1, radius, rgb, alpha = 255) {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        let hits = 0;
        for (let sy = 0; sy < 3; sy++) {
          for (let sx = 0; sx < 3; sx++) {
            const px = x + (sx + 0.5) / 3;
            const py = y + (sy + 0.5) / 3;
            if (px < x0 || px > x1 || py < y0 || py > y1) continue;
            const cx = Math.min(Math.max(px, x0 + radius), x1 - radius);
            const cy = Math.min(Math.max(py, y0 + radius), y1 - radius);
            const dx = px - cx;
            const dy = py - cy;
            if (dx * dx + dy * dy <= radius * radius + 0.01) hits++;
          }
        }
        if (hits) this.set(x, y, rgb, Math.round((alpha * hits) / 9));
      }
    }
  }

  glyph(char, x, y, scale, rgb) {
    const rows = GLYPHS[char];
    if (!rows) return;
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (rows[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            this.set(x + gx * scale + sx, y + gy * scale + sy, rgb);
          }
        }
      }
    }
  }
}

/** 100+ has three digits and will not fit; "!!" is unmistakable at this size. */
function digitsFor(pct) {
  const n = Math.max(0, Math.min(999, Math.round(pct)));
  return n >= 100 ? '!!' : String(n);
}

/**
 * A filled badge with white numerals.
 *
 * Filled rather than outlined on purpose: the Windows taskbar can be light or
 * dark and the user can change it at any time, so an icon that relies on the
 * background for contrast will be invisible for half of them. A solid block of
 * colour with white digits reads on both.
 */
function renderBadge(pct, severity = 'normal', size = 32) {
  const bmp = new Bitmap(size);
  const rgb = COLOURS[severity] || COLOURS.normal;
  const white = [0xff, 0xff, 0xff];

  bmp.roundedRect(0.5, 0.5, size - 0.5, size - 0.5, size * 0.28, rgb);

  const text = digitsFor(pct);
  // Scale to the available width, not a fixed fraction of height — otherwise a
  // single digit sits marooned in the middle of the badge.
  const budget = size * 0.74;
  const perGlyph = budget / text.length;
  const scale = Math.max(1, Math.min(
    Math.floor(perGlyph / (GLYPH_W + 0.6)),
    Math.floor((size * 0.72) / GLYPH_H),
  ));
  const glyphW = GLYPH_W * scale;
  const gap = Math.max(1, Math.round(scale * 0.6));
  const totalW = text.length * glyphW + (text.length - 1) * gap;
  let x = Math.round((size - totalW) / 2);
  const y = Math.round((size - GLYPH_H * scale) / 2);

  for (const char of text) {
    bmp.glyph(char, x, y, scale, white);
    x += glyphW + gap;
  }
  return { buffer: bmp.data, width: size, height: size };
}

module.exports = { renderBadge, digitsFor, COLOURS, Bitmap };
