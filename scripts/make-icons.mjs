// Generates the app icons (client/icon-192.png, client/icon-512.png):
// an orange zone ring on a dark tile. Run: node scripts/make-icons.mjs

import fs from 'node:fs';
import zlib from 'node:zlib';

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2;
  const mix = (a, b, t) => Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c) / size;
      // Background: dark blue-green with a soft vignette.
      let r = mix(22, 13, d * 2);
      let g = mix(46, 27, d * 2);
      let b = mix(58, 36, d * 2);
      // Outer ring, inner ring and centre dot, anti-aliased.
      const aa = 1.2 / size;
      const ring = (radius, width) => 1 - Math.min(1, Math.max(0, (Math.abs(d - radius) - width / 2) / aa));
      const k = Math.max(ring(0.33, 0.07), ring(0.17, 0.035) * 0.75, 1 - Math.min(1, Math.max(0, (d - 0.05) / aa)));
      r = mix(r, 255, k);
      g = mix(g, 155, k);
      b = mix(b, 33, k);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const file = new URL(`../client/icon-${size}.png`, import.meta.url);
  fs.writeFileSync(file, icon(size));
  console.log('wrote', file.pathname);
}
