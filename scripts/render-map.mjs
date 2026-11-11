// Renders a top-down picture of the generated island to a PNG file.
// Usage: node scripts/render-map.mjs [output.png] [pixelsPerMetre]
// Handy for checking map changes without starting the game.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { getWorld, distToRoads, FIELDS } from '../shared/world.js';
import { WORLD_SIZE, WORLD_HALF } from '../shared/constants.js';

const out = process.argv[2] || 'docs/map.png';
const ppm = Number(process.argv[3] || 2);
const W = WORLD_SIZE * ppm;
const world = getWorld();
const px = Buffer.alloc(W * W * 3);

function set(i, r, g, b) {
  px[i * 3] = r;
  px[i * 3 + 1] = g;
  px[i * 3 + 2] = b;
}
const mix = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

for (let j = 0; j < W; j++) {
  for (let i = 0; i < W; i++) {
    const x = (i + 0.5) / ppm - WORLD_HALF;
    const z = (j + 0.5) / ppm - WORLD_HALF;
    const h = world.heightAt(x, z);
    let r;
    let g;
    let b;
    if (h < 0) {
      const d = Math.min(1, -h / 3);
      r = mix(96, 28, d); g = mix(190, 104, d); b = mix(200, 160, d);
    } else if (h < 0.9) {
      r = 226; g = 208; b = 160;
    } else {
      const t = Math.min(1, (h - 0.9) / 18);
      r = mix(120, 96, t); g = mix(176, 132, t); b = mix(84, 78, t);
      if (x > FIELDS.x0 && x < FIELDS.x1 && z > FIELDS.z0 && z < FIELDS.z1) { r = 150; g = 205; b = 90; }
    }
    // Simple hill shading from the local slope.
    const s = 1 + Math.max(-0.35, Math.min(0.35, (world.heightAt(x - 1, z - 1) - world.heightAt(x + 1, z + 1)) * 0.12));
    if (h >= 0) { r *= s; g *= s; b *= s; }
    if (h > 0.2 && distToRoads(x, z) < 2.4) { r = 150; g = 142; b = 130; }
    set(j * W + i, Math.min(255, r), Math.min(255, g), Math.min(255, b));
  }
}

const COLORS = {
  trunk: [40, 110, 50], rock: [120, 120, 116], bush: [50, 120, 60], crate: [150, 110, 60], hay: [220, 190, 80],
  stairs: [90, 90, 90], floor: null, roofstep: null, wall: [60, 50, 45], compound: [70, 66, 50],
};
for (const b of world.boxes) {
  let c = COLORS[b.k];
  if (c === null) continue;
  if (!c) c = [(b.c >> 16) & 255, (b.c >> 8) & 255, b.c & 255];
  const grow = b.k === 'trunk' ? 1.2 : 0;
  const i0 = Math.max(0, Math.floor((b.x0 - grow + WORLD_HALF) * ppm));
  const i1 = Math.min(W - 1, Math.ceil((b.x1 + grow + WORLD_HALF) * ppm));
  const j0 = Math.max(0, Math.floor((b.z0 - grow + WORLD_HALF) * ppm));
  const j1 = Math.min(W - 1, Math.ceil((b.z1 + grow + WORLD_HALF) * ppm));
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) set(j * W + i, c[0], c[1], c[2]);
}
if (process.argv.includes('--loot')) {
  for (const s of world.lootSpawns) {
    const i = Math.floor((s.x + WORLD_HALF) * ppm);
    const j = Math.floor((s.z + WORLD_HALF) * ppm);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) set((j + dj) * W + i + di, 255, 240, 0);
  }
}

// Minimal PNG encoder (truecolour, no alpha).
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
const raw = Buffer.alloc((W * 3 + 1) * W);
for (let j = 0; j < W; j++) px.copy(raw, j * (W * 3 + 1) + 1, j * W * 3, (j + 1) * W * 3);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(W, 4);
ihdr[8] = 8;
ihdr[9] = 2;
fs.mkdirSync(new URL('.', new URL(out, 'file://' + process.cwd() + '/')).pathname, { recursive: true });
fs.writeFileSync(out, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`wrote ${out} (${W}x${W})`);
