// Procedural generation of "Aindinai Island", an original fictional map inspired
// by the landscapes of South India: a coastal harbour, a farming village with
// paddy fields, a hill station with tea terraces, woodland, a dry-land outpost
// and a junction town in the middle.
//
// The generator is deterministic: the server and every client build exactly the
// same world from the same seed, so no map data has to be sent over the network.
// Only + - * /, Math.sqrt, Math.floor and integer hashing are used (no
// trigonometry) so results are identical in every JavaScript engine.

import { mulberry32, fbm, smooth01 } from './rng.js';
import { WORLD_SIZE, WORLD_HALF, SEA_LEVEL } from './constants.js';

export const WORLD_SEED = 20261111;
export const GRID_CELL = 2; // metres between height samples
export const GRID_N = WORLD_SIZE / GRID_CELL + 1;
const BOX_CELL = 8; // spatial-hash cell size for collision boxes
const BOX_N = Math.ceil(WORLD_SIZE / BOX_CELL);

export const POIS = [
  { id: 'junction', name: 'Sangam Junction', x: 5, z: 10, r: 40, minH: 2.4 },
  { id: 'village', name: 'Marutham Village', x: -95, z: 10, r: 30, minH: 2.2 },
  { id: 'harbour', name: 'Neithal Harbour', x: 95, z: 95, r: 36, h: 2.0 },
  { id: 'heights', name: 'Kurinji Heights', x: 25, z: -95, r: 30, minH: 2 },
  { id: 'woods', name: 'Mullai Woods', x: -95, z: -75, r: 42, minH: 2.5, noPad: true },
  { id: 'outpost', name: 'Paalai Outpost', x: 110, z: -35, r: 32, minH: 2.4 },
];

export const FIELDS = { x0: -68, z0: 32, x1: -34, z1: 70, h: 1.8 };

const CREEK = [[-181, 80], [-130, 81], [-100, 80], [-70, 84], [-48, 92]];
export const BRIDGE = { x0: -103, x1: -97, z0: 63, z1: 97, top: 3.0 };

// Road centre lines. `bridge` marks the index of a segment that crosses water
// on the bridge and therefore must not raise the terrain.
export const ROADS = [
  { pts: [[5, 10], [-40, 12], [-95, 10]] },
  { pts: [[-95, 10], [-102, 40], [-100, 61], [-100, 99], [-80, 118], [-30, 127], [30, 127], [70, 115], [95, 95]], bridge: 2 },
  { pts: [[95, 95], [106, 40], [110, -35]] },
  { pts: [[110, -35], [110, -64], [85, -80], [25, -95]] },
  { pts: [[25, -95], [-30, -100], [-95, -75], [-116, -30], [-95, 10]] },
  { pts: [[5, 10], [10, -40], [25, -95]] },
  { pts: [[5, 10], [50, 55], [95, 95]] },
  { pts: [[5, 10], [60, -12], [84, -35], [110, -35]] },
];

function distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t - px;
  const cz = az + dz * t - pz;
  return Math.sqrt(cx * cx + cz * cz);
}

function distToPolyline(px, pz, pts, skipSeg = -1) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (i === skipSeg) continue;
    const d = distToSegment(px, pz, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

export function distToRoads(px, pz, includeBridge = true) {
  let best = Infinity;
  for (const road of ROADS) {
    const d = distToPolyline(px, pz, road.pts, includeBridge ? -1 : road.bridge ?? -1);
    if (d < best) best = d;
  }
  return best;
}

function distToRect(px, pz, x0, z0, x1, z1) {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dz = pz < z0 ? z0 - pz : pz > z1 ? pz - z1 : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

let cached = null;

// The world never changes for a given seed, so it is built once per process.
export function getWorld(seed = WORLD_SEED) {
  if (!cached || cached.seed !== seed) cached = generateWorld(seed);
  return cached;
}

export function generateWorld(seed = WORLD_SEED) {
  const rnd = mulberry32(seed);
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1)); // inclusive integer
  const rf = (a, b) => a + rnd() * (b - a);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  // ---------------------------------------------------------------- terrain
  function rawHeight(x, z) {
    const d = Math.sqrt(x * x + z * z);
    const coast = fbm(x / 55 + 40, z / 55 + 40, seed + 7, 3);
    const R = 148 + (coast - 0.5) * 44;
    const s = smooth01((R - d) / 30);
    const hills = fbm(x / 75, z / 75, seed + 1, 4);
    let h = -3.2 + s * (4.9 + hills * hills * 15);
    // The big hill that carries Kurinji Heights.
    const kx = x - 25;
    const kz = z + 95;
    const t = Math.max(0, 1 - (kx * kx + kz * kz) / (85 * 85));
    h += s * 15 * t * t;
    h += (fbm(x / 9, z / 9, seed + 3, 2) - 0.5) * 0.5 * s;

    // Roads sit on a low causeway so they never dip under water.
    const dr = distToRoads(x, z, false);
    if (dr < 9 && h < 1.2) h += (1.2 - h) * (1 - smooth01((dr - 3.5) / 5.5));

    // Tidal creek (backwater) cut in from the west coast.
    let dc = distToPolyline(x, z, CREEK);
    const lx = x + 44;
    const lz = z - 94;
    dc = Math.min(dc, Math.max(0, Math.sqrt(lx * lx + lz * lz) - 7));
    if (dc < 15 && h > -2.4) h += (-2.4 - h) * (1 - smooth01((dc - 5) / 10));
    return h;
  }

  const pads = [];
  for (const p of POIS) {
    p.h = p.h ?? Math.max(p.minH ?? 2, rawHeight(p.x, p.z));
    if (!p.noPad) pads.push({ x: p.x, z: p.z, r: p.r, blend: 14, h: p.h });
  }
  pads.push({ x: -100, z: 60, r: 5, blend: 7, h: BRIDGE.top - 0.08 });
  pads.push({ x: -100, z: 100, r: 5, blend: 7, h: BRIDGE.top - 0.08 });

  function finalHeight(x, z) {
    let h = rawHeight(x, z);
    for (const p of pads) {
      const dx = x - p.x;
      const dz = z - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < p.r + p.blend) h += (p.h - h) * (1 - smooth01((d - p.r) / p.blend));
    }
    // The paddy fields are levelled last so they stay perfectly flat.
    const df = distToRect(x, z, FIELDS.x0, FIELDS.z0, FIELDS.x1, FIELDS.z1);
    if (df < 8) h += (FIELDS.h - h) * (1 - smooth01(df / 8));
    return h < -3.2 ? -3.2 : h;
  }

  const heights = new Float32Array(GRID_N * GRID_N);
  let maxHeight = 0;
  for (let j = 0; j < GRID_N; j++) {
    for (let i = 0; i < GRID_N; i++) {
      const h = finalHeight(-WORLD_HALF + i * GRID_CELL, -WORLD_HALF + j * GRID_CELL);
      heights[j * GRID_N + i] = h;
      if (h > maxHeight) maxHeight = h;
    }
  }

  // Height of the terrain surface. Uses the same triangle split as the rendered
  // mesh, so what you see is exactly what you stand on.
  function heightAt(x, z) {
    let gx = (x + WORLD_HALF) / GRID_CELL;
    let gz = (z + WORLD_HALF) / GRID_CELL;
    if (gx < 0) gx = 0; else if (gx > GRID_N - 1.001) gx = GRID_N - 1.001;
    if (gz < 0) gz = 0; else if (gz > GRID_N - 1.001) gz = GRID_N - 1.001;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const k = iz * GRID_N + ix;
    const h10 = heights[k + 1];
    const h01 = heights[k + GRID_N];
    if (fx + fz <= 1) {
      const h00 = heights[k];
      return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    }
    const h11 = heights[k + GRID_N + 1];
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  // ---------------------------------------------------------------- objects
  const boxes = [];
  const decor = [];
  const lootSpawns = [];
  const footprints = [];

  function addBox(x0, y0, z0, x1, y1, z1, k, c = 0xffffff, v = 1) {
    boxes.push({ x0, y0, z0, x1, y1, z1, k, c, v });
  }
  function claim(x0, z0, x1, z1) {
    footprints.push({ x0, z0, x1, z1 });
  }
  function rectFree(x0, z0, x1, z1, gap = 0) {
    for (const f of footprints) {
      if (x0 - gap < f.x1 && x1 + gap > f.x0 && z0 - gap < f.z1 && z1 + gap > f.z0) return false;
    }
    return true;
  }
  function rectRoadDist(x0, z0, x1, z1) {
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const half = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0)) / 2;
    return distToRoads(cx, cz) - half;
  }
  function inFields(x, z, m = 0) {
    return x > FIELDS.x0 - m && x < FIELDS.x1 + m && z > FIELDS.z0 - m && z < FIELDS.z1 + m;
  }
  function addLoot(x, y, z, tier = 1) {
    lootSpawns.push({ x, y, z, tier });
  }

  // A wall running along X (or Z) with door/window openings cut into it.
  // openings: [{ a, b, lo, hi }] where a..b is the gap along the wall and
  // lo..hi its vertical extent relative to the wall base.
  function wall(alongX, from, to, t0, t1, y, h, openings, c, kind = 'wall') {
    const put = (a, b, ya, yb) => {
      if (b - a < 0.01 || yb - ya < 0.01) return;
      if (alongX) addBox(a, ya, t0, b, yb, t1, kind, c);
      else addBox(t0, ya, a, t1, yb, b, kind, c);
    };
    const ops = openings.slice().sort((p, q) => p.a - q.a);
    let cur = from;
    for (const op of ops) {
      put(cur, op.a, y - 0.6, y + h);
      if (op.lo > 0) put(op.a, op.b, y - 0.6, y + op.lo);
      if (op.hi < h) put(op.a, op.b, y + op.hi, y + h);
      cur = op.b;
    }
    put(cur, to, y - 0.6, y + h);
  }

  const DOOR_W = 1.7;
  function doorAt(c) {
    return { a: c - DOOR_W / 2, b: c + DOOR_W / 2, lo: 0, hi: 2.25 };
  }
  function windowAt(c) {
    return { a: c - 0.7, b: c + 0.7, lo: 1.05, hi: 2.1 };
  }

  // Solid staircase climbing in +x or -x (alongX) / +z or -z, made of boxes
  // that each rise less than STEP_HEIGHT so players simply walk up.
  function addStairs(alongX, start, dir, t0, t1, y, rise, c) {
    const n = Math.ceil(rise / 0.3);
    const stepH = rise / n;
    const run = 0.45;
    for (let i = 0; i < n; i++) {
      const a = start + dir * i * run;
      const b = start + dir * (i + 1) * run;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (alongX) addBox(lo, y - 0.6, t0, hi, y + (i + 1) * stepH, t1, 'stairs', c);
      else addBox(t0, y - 0.6, lo, t1, y + (i + 1) * stepH, hi, 'stairs', c);
    }
    return n * run;
  }

  function addBuilding(o) {
    const { x0, z0, w, d, y, h, wallC, roofC } = o;
    const x1 = x0 + w;
    const z1 = z0 + d;
    const T = 0.3;
    const side = o.door || 'S';
    const fy = y + 0.04;
    addBox(x0 - 0.25, y - 1.6, z0 - 0.25, x1 + 0.25, fy, z1 + 0.25, 'floor', o.floorC ?? 0x9a8f80);

    const doorX = x0 + Math.floor(w / 2) + 0.5;
    const doorZ = z0 + Math.floor(d / 2) + 0.5;
    const big = w >= 12 || d >= 12;
    const opp = { N: 'S', S: 'N', E: 'W', W: 'E' }[side];
    const sides = {
      N: { alongX: true, from: x0, to: x1, t0: z0, t1: z0 + T, door: doorX },
      S: { alongX: true, from: x0, to: x1, t0: z1 - T, t1: z1, door: doorX },
      W: { alongX: false, from: z0 + T, to: z1 - T, t0: x0, t1: x0 + T, door: doorZ },
      E: { alongX: false, from: z0 + T, to: z1 - T, t0: x1 - T, t1: x1, door: doorZ },
    };
    for (const key of ['N', 'S', 'W', 'E']) {
      const s = sides[key];
      const len = s.to - s.from;
      const ops = [];
      if (key === side || (big && key === opp)) {
        ops.push(doorAt(s.door));
        if (len >= 9) ops.push(windowAt(s.from + 2));
      } else if (len >= 5 && rnd() < 0.8) {
        ops.push(windowAt(s.from + len * rf(0.3, 0.7)));
        if (len >= 10) ops.push(windowAt(s.from + 1.8));
      }
      wall(s.alongX, s.from, s.to, s.t0, s.t1, fy, h, ops, wallC);
    }

    // Larger buildings get an interior partition with a doorway.
    if (w >= 10) {
      const xm = x0 + Math.round(w / 2);
      const dz = z0 + 1 + ri(1, Math.max(1, d - 4)) + 0.5;
      wall(false, z0 + T, z1 - T, xm - 0.12, xm + 0.12, fy, h, [doorAt(Math.min(dz, z1 - 1.6))], wallC);
    }

    const ry = fy + h;
    if (o.roof === 'gable') {
      const ov = 0.5;
      addBox(x0 - ov, ry, z0 - ov, x1 + ov, ry + 0.25, z1 + ov, 'roof', roofC);
      const alongX = w >= d;
      const hs = (alongX ? d : w) / 2 + ov;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      // Invisible stepped collider that follows the sloped roof drawn above it.
      for (let i = 1; i <= 3; i++) {
        const half = hs * (1 - i / 4);
        const ya = ry + 0.25 + (i - 1) * 0.4;
        if (alongX) addBox(x0 - ov, ya, cz - half, x1 + ov, ya + 0.4, cz + half, 'roofstep', roofC, 0);
        else addBox(cx - half, ya, z0 - ov, cx + half, ya + 0.4, z1 + ov, 'roofstep', roofC, 0);
      }
      decor.push({ t: 'gable', x0: x0 - ov, z0: z0 - ov, x1: x1 + ov, z1: z1 + ov, y: ry + 0.25, h: 1.6, ax: alongX ? 'x' : 'z', c: roofC, wc: wallC });
    } else {
      addBox(x0 - 0.15, ry, z0 - 0.15, x1 + 0.15, ry + 0.25, z1 + 0.15, 'roof', roofC);
      if (o.stairs) {
        const rise = ry + 0.25 - y;
        if (side === 'N') {
          addStairs(true, x0 + 0.4, 1, z1 + 0.15, z1 + 1.35, y, rise, 0x8f8a80);
        } else {
          addStairs(true, x0 + 0.4, 1, z0 - 1.35, z0 - 0.15, y, rise, 0x8f8a80);
        }
        addLoot(rf(x0 + 1.5, x1 - 1.5), ry + 0.25, rf(z0 + 1.5, z1 - 1.5), 2);
      }
    }

    const n = Math.min(4, 1 + Math.floor((w * d) / 34));
    const xm = x0 + Math.round(w / 2);
    for (let i = 0; i < n; i++) {
      let lx = rf(x0 + 1.2, x1 - 1.2);
      // Keep clear of the interior partition.
      if (w >= 10 && Math.abs(lx - xm) < 0.8) lx = xm + (lx < xm ? -0.9 : 0.9);
      addLoot(lx, fy, rf(z0 + 1.2, z1 - 1.2), o.tier || 1);
    }
  }

  function scatterBuildings(poi, count, sizes, style) {
    let placed = 0;
    for (let a = 0; a < 500 && placed < count; a++) {
      let [w, d] = pick(sizes);
      if (rnd() < 0.5) [w, d] = [d, w];
      let ux;
      let uz;
      do {
        ux = rnd() * 2 - 1;
        uz = rnd() * 2 - 1;
      } while (ux * ux + uz * uz > 1);
      const reach = (style.reach ?? poi.r) - 5;
      const cx = poi.x + ux * reach;
      const cz = poi.z + uz * reach;
      const x0 = Math.round(cx - w / 2);
      const z0 = Math.round(cz - d / 2);
      const far = Math.max(
        Math.abs(x0 - poi.x), Math.abs(x0 + w - poi.x), 0,
      ) ** 2 + Math.max(Math.abs(z0 - poi.z), Math.abs(z0 + d - poi.z)) ** 2;
      if (far > (poi.r - 1) * (poi.r - 1)) continue;
      const stairs = style.roof === 'flat' && rnd() < (style.stairs ?? 0);
      if (!rectFree(x0 - 0.5, z0 - 1.6, x0 + w + 0.5, z0 + d + 1.6, style.gap ?? 3)) continue;
      if (rectRoadDist(x0, z0, x0 + w, z0 + d) < 3.4) continue;
      const dx = poi.x - (x0 + w / 2);
      const dz = poi.z - (z0 + d / 2);
      const door = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'E' : 'W') : dz > 0 ? 'S' : 'N';
      claim(x0 - 0.5, z0 - 1.6, x0 + w + 0.5, z0 + d + 1.6);
      addBuilding({
        x0, z0, w, d, y: poi.h, h: style.h ?? 3.1, wallC: pick(style.walls), roofC: pick(style.roofs),
        roof: style.roof, stairs, door, tier: style.tier, floorC: style.floorC,
      });
      placed++;
    }
  }

  function addCrate(x, z, s, y = null, stack = false) {
    const gy = y ?? heightAt(x, z);
    addBox(x - s / 2, gy - 0.5, z - s / 2, x + s / 2, gy + s, z + s / 2, 'crate', 0xb08350);
    if (stack) {
      const s2 = s * 0.8;
      addBox(x - s2 / 2, gy + s, z - s2 / 2, x + s2 / 2, gy + s + s2, z + s2 / 2, 'crate', 0xa3763f);
    }
  }

  // A lookout: solid base with a staircase and a sandbagged platform on top.
  function addLookout(x, z, y, c) {
    const s = 4;
    const top = 4.2;
    claim(x - 1, z - 2, x + s + 6.5, z + s + 1);
    addBox(x, y - 0.6, z, x + s, y + top, z + s, 'tower', c);
    addStairs(true, x + s + 0.45 * Math.ceil(top / 0.3), -1, z + 0.4, z + 1.6, y, top, 0x8f8a80);
    const p = 0.9;
    addBox(x, y + top, z + s - 0.35, x + s, y + top + p, z + s, 'sandbag', 0xb9a57a);
    addBox(x, y + top, z + 1.8, x + 0.35, y + top + p, z + s, 'sandbag', 0xb9a57a);
    addBox(x, y + top, z, x + s - 1.4, y + top + p, z + 0.35, 'sandbag', 0xb9a57a);
    addLoot(x + s / 2, y + top, z + s / 2, 2);
  }

  const byId = Object.fromEntries(POIS.map((p) => [p.id, p]));

  // --- Sangam Junction: clock tower, market street, bus shelter -------------
  {
    const p = byId.junction;
    claim(p.x - 3.5, p.z - 3.5, p.x + 3.5, p.z + 3.5);
    addBox(p.x - 2, p.h - 0.6, p.z - 2, p.x + 2, p.h + 13, p.z + 2, 'tower', 0xf0e2c0);
    addBox(p.x - 2.4, p.h + 13, p.z - 2.4, p.x + 2.4, p.h + 13.5, p.z + 2.4, 'trim', 0xb5532f);
    addBox(p.x - 1.5, p.h + 13.5, p.z - 1.5, p.x + 1.5, p.h + 16, p.z + 1.5, 'tower', 0xf0e2c0);
    decor.push({ t: 'clock', x: p.x, y: p.h + 11.2, z: p.z, s: 2.02 });
    decor.push({ t: 'spire', x: p.x, y: p.h + 16, z: p.z, w: 3.6, h: 2.4, c: 0xb5532f });
    // Bus shelter.
    const sx = p.x + 9;
    const sz = p.z - 16;
    claim(sx - 1, sz - 1, sx + 9, sz + 4);
    for (const [px, pz] of [[sx, sz], [sx + 8, sz], [sx, sz + 3], [sx + 8, sz + 3]]) {
      addBox(px - 0.2, p.h - 0.6, pz - 0.2, px + 0.2, p.h + 2.7, pz + 0.2, 'pillar', 0x3b6ea5);
    }
    addBox(sx - 0.6, p.h + 2.7, sz - 0.6, sx + 8.6, p.h + 2.9, sz + 3.6, 'roof', 0x3b6ea5);
    addBox(sx + 1, p.h - 0.6, sz + 0.2, sx + 7, p.h + 0.5, sz + 0.8, 'bench', 0x8a6240);
    addLoot(sx + 4, p.h, sz + 2, 1);
    scatterBuildings(p, 11, [[8, 6], [10, 7], [7, 7], [12, 8], [6, 6]], {
      walls: [0xe8dcc0, 0xd9a05b, 0x7fb7c9, 0xe9967a, 0xc7d36f, 0xf0e6d2, 0xd7b8e0],
      roofs: [0xb8b0a0, 0xa8a297], roof: 'flat', stairs: 0.5, gap: 3.5, h: 3.2,
    });
  }

  // --- Marutham Village: tiled houses and a water tower ----------------------
  {
    const p = byId.village;
    const tx = p.x + 3;
    const tz = p.z - 9;
    claim(tx - 1, tz - 1, tx + 5, tz + 5);
    for (const [px, pz] of [[tx, tz], [tx + 3.4, tz], [tx, tz + 3.4], [tx + 3.4, tz + 3.4]]) {
      addBox(px, p.h - 0.6, pz, px + 0.6, p.h + 7, pz + 0.6, 'pillar', 0xb9b2a3);
    }
    addBox(tx - 0.4, p.h + 7, tz - 0.4, tx + 4.4, p.h + 10, tz + 4.4, 'tank', 0x5d8fb3);
    addLoot(tx + 2, p.h, tz + 2, 1);
    scatterBuildings(p, 9, [[7, 6], [8, 6], [6, 6], [9, 7]], {
      walls: [0xf2d16b, 0x6fc3b2, 0xf4a6a0, 0xbfe08a, 0xf7f1e3, 0x9ec9f0],
      roofs: [0xb5532f, 0xa84a2a, 0xc0603a], roof: 'gable', gap: 3,
    });
  }

  // --- Paddy fields: hay stacks and a pump shed ------------------------------
  {
    const f = FIELDS;
    claim(f.x0 + 2, f.z0 + 2, f.x0 + 8, f.z0 + 8);
    addBuilding({
      x0: f.x0 + 3, z0: f.z0 + 3, w: 4, d: 4, y: f.h, h: 2.8, wallC: 0xd8cdb4, roofC: 0x7a8791,
      roof: 'flat', door: 'E',
    });
    for (let i = 0; i < 7; i++) {
      const x = rf(f.x0 + 4, f.x1 - 4);
      const z = rf(f.z0 + 4, f.z1 - 4);
      if (!rectFree(x - 1.5, z - 1.5, x + 1.5, z + 1.5, 2)) continue;
      claim(x - 1.2, z - 1.2, x + 1.2, z + 1.2);
      addBox(x - 1.1, f.h - 0.5, z - 1.1, x + 1.1, f.h + 1.5, z + 1.1, 'hay', 0xd9b84a);
      if (i % 2 === 0) addLoot(x + 1.8, f.h, z, 1);
    }
  }

  // --- Neithal Harbour: warehouses, container yard, pier, lighthouse ---------
  {
    const p = byId.harbour;
    // Container yard.
    const yx = p.x + 5;
    const yz = p.z + 6;
    claim(yx - 1, yz - 1, yx + 22, yz + 20);
    const colors = [0xc0392b, 0x2e86c1, 0x27ae60, 0xd68910, 0x7d3c98, 0x566573, 0xe67e22];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        if (rnd() < 0.15) continue;
        const cx = yx + col * 7.5;
        const cz = yz + row * 6.5;
        const stack = rnd() < 0.4 ? 2 : 1;
        for (let s = 0; s < stack; s++) {
          addBox(cx, p.h - 0.4 + s * 2.6, cz, cx + 6, p.h + 2.6 + s * 2.6, cz + 2.4, 'container', pick(colors));
        }
        if (rnd() < 0.7) addLoot(cx + rf(0.5, 5.5), p.h, cz + 3.4, 2);
      }
    }
    addCrate(yx + 6.6, yz + 4.5, 1.1, p.h, true);
    addCrate(yx + 14.2, yz + 11, 1.2, p.h);
    // Pier and lighthouse.
    const px = p.x - 2;
    claim(px - 1, p.z + 28, px + 5, p.z + 40);
    addBox(px, -3.2, p.z + 29, px + 4, p.h - 0.08, p.z + 70, 'pier', 0x9b7b55);
    for (let z = p.z + 34; z < p.z + 70; z += 9) {
      addBox(px - 0.25, -3.2, z, px + 0.05, p.h + 0.7, z + 0.3, 'post', 0x6e5235);
      addBox(px + 3.95, -3.2, z, px + 4.25, p.h + 0.7, z + 0.3, 'post', 0x6e5235);
    }
    addLoot(px + 2, p.h - 0.08, p.z + 52, 1);
    addLoot(px + 2, p.h - 0.08, p.z + 66, 2);
    addBox(px + 0.5, -3.2, p.z + 70, px + 3.5, p.h + 13, p.z + 73, 'lighthouse', 0xf2efe6, 0);
    decor.push({ t: 'lighthouse', x: px + 2, y: p.h - 0.08, z: p.z + 71.5, h: 13 });
    scatterBuildings(p, 4, [[14, 10], [12, 9], [10, 8]], {
      walls: [0x8fa3ad, 0x9aa7a0, 0xa9b7c0], roofs: [0x6f7d86, 0x77858c], roof: 'flat', stairs: 0.5,
      gap: 4, h: 4.4, tier: 2, floorC: 0x80837f,
    });
  }

  // --- Kurinji Heights: hill-station bungalows, lookout, tea terraces --------
  {
    const p = byId.heights;
    addLookout(p.x - 4, p.z - 3, p.h, 0xe9e2d0);
    scatterBuildings(p, 5, [[9, 7], [8, 6], [10, 7]], {
      walls: [0xf5f2ea, 0xf0e9dc, 0xe6efe9], roofs: [0x9c3b2e, 0x8f3a30], roof: 'gable', gap: 3.5,
    });
    // Tea bushes in contour rows on the slopes: good low cover.
    for (let z = p.z - 60; z <= p.z + 62; z += 3.6) {
      for (let x = p.x - 60; x <= p.x + 62; x += 4.4) {
        const dx = x - p.x;
        const dz = z - p.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < p.r + 6 || d > 60) continue;
        if (dz < -8 && dx < 12) continue; // leave the north-west slope open
        if (rnd() < 0.42) continue;
        if (distToRoads(x, z) < 5) continue;
        const gy = heightAt(x, z);
        if (gy < 3.5) continue;
        addBox(x - 1.7, gy - 0.8, z - 0.5, x + 1.7, gy + 0.8, z + 0.5, 'bush', 0x3f7d3a);
      }
    }
  }

  // --- Paalai Outpost: walled compound with lookouts and barracks ------------
  {
    const p = byId.outpost;
    const R = 25;
    const H = 2.7;
    const c = 0x9a9373;
    const g = 2.8; // half gate width
    wall(true, p.x - R, p.x + R, p.z - R, p.z - R + 0.5, p.h, H, [{ a: p.x - g, b: p.x + g, lo: 0, hi: 99 }], c, 'compound');
    wall(true, p.x - R, p.x + R, p.z + R - 0.5, p.z + R, p.h, H, [{ a: p.x - g, b: p.x + g, lo: 0, hi: 99 }], c, 'compound');
    wall(false, p.z - R, p.z + R, p.x - R, p.x - R + 0.5, p.h, H, [{ a: p.z - g, b: p.z + g, lo: 0, hi: 99 }], c, 'compound');
    wall(false, p.z - R, p.z + R, p.x + R - 0.5, p.x + R, p.h, H, [], c, 'compound');
    addLookout(p.x + R - 11.5, p.z - R + 1.5, p.h, 0x8d8f6a);
    addLookout(p.x - R + 1.5, p.z + R - 6, p.h, 0x8d8f6a);
    // Sandbag positions covering the gates.
    for (const [sx, sz, alongX] of [[p.x - 5, p.z - R + 5, true], [p.x + 3, p.z + R - 6, true], [p.x - R + 5, p.z - 5, false]]) {
      claim(sx - 1, sz - 1, sx + 4, sz + 4);
      if (alongX) addBox(sx, p.h - 0.4, sz, sx + 2.6, p.h + 0.9, sz + 0.6, 'sandbag', 0xb9a57a);
      else addBox(sx, p.h - 0.4, sz, sx + 0.6, p.h + 0.9, sz + 2.6, 'sandbag', 0xb9a57a);
    }
    claim(p.x - 3, p.z - 3, p.x + 3, p.z + 3);
    addCrate(p.x - 1, p.z, 1.3, p.h, true);
    addCrate(p.x + 0.6, p.z + 0.3, 1.1, p.h);
    addLoot(p.x + 1.8, p.h, p.z - 1.5, 2);
    scatterBuildings(p, 4, [[10, 6], [9, 6], [8, 7]], {
      walls: [0x8d8f6a, 0x85875f], roofs: [0x6f7355, 0x676b4f], roof: 'flat', stairs: 0.25, gap: 3.2,
      h: 3.0, tier: 2, reach: 21, floorC: 0x7d7a6a,
    });
  }

  // --- Mullai Woods: forest cabins --------------------------------------------
  {
    const p = byId.woods;
    for (let a = 0, placed = 0; a < 600 && placed < 4; a++) {
      const w = pick([6, 7, 8]);
      const d = pick([5, 6]);
      const x0 = Math.round(p.x + rf(-p.r + 8, p.r - 14));
      const z0 = Math.round(p.z + rf(-p.r + 8, p.r - 12));
      if (!rectFree(x0 - 1, z0 - 1, x0 + w + 1, z0 + d + 1, 8)) continue;
      if (rectRoadDist(x0, z0, x0 + w, z0 + d) < 4) continue;
      // Cabins stand on the natural ground, so they need a nearly level spot
      // and their floor sits on its highest point.
      let y = -Infinity;
      let lo = Infinity;
      for (let cz = z0 - 1; cz <= z0 + d + 1; cz++) {
        for (let cx = x0 - 1; cx <= x0 + w + 1; cx++) {
          const g = heightAt(cx, cz);
          if (g > y) y = g;
          if (g < lo) lo = g;
        }
      }
      if (y - lo > 0.38 || lo < 1.5) continue;
      claim(x0 - 1, z0 - 1, x0 + w + 1, z0 + d + 1);
      addBuilding({
        x0, z0, w, d, y, h: 2.9, wallC: pick([0x8a6240, 0x7a5636, 0x94704c]), roofC: 0x4f6b3a,
        roof: 'gable', door: pick(['N', 'S', 'E', 'W']), floorC: 0x6b5138,
      });
      placed++;
    }
  }

  // --- Bridge over the creek ---------------------------------------------------
  {
    const b = BRIDGE;
    addBox(b.x0, b.top - 0.5, b.z0, b.x1, b.top, b.z1, 'bridge', 0x9c9588);
    for (const x of [b.x0 - 0.2, b.x1]) {
      addBox(x, b.top, b.z0, x + 0.2, b.top + 1.0, b.z1, 'rail', 0xd9d2c4);
    }
    for (let z = b.z0 + 6; z < b.z1; z += 11) {
      addBox(b.x0 + 0.6, -3.2, z, b.x0 + 1.4, b.top - 0.5, z + 0.8, 'pillar', 0x8b8579);
      addBox(b.x1 - 1.4, -3.2, z, b.x1 - 0.6, b.top - 0.5, z + 0.8, 'pillar', 0x8b8579);
    }
    claim(b.x0 - 1, b.z0 - 6, b.x1 + 1, b.z1 + 6);
    addLoot((b.x0 + b.x1) / 2, b.top, (b.z0 + b.z1) / 2, 2);
  }

  // --- Parked vehicles: painted lorries and auto-rickshaws ---------------------
  // These are spawn points; the match creates drivable vehicles there.
  const vehicleSpawns = [];
  const HALF_PI = 1.5707963267948966;
  function addVehicle(type, x, z, alongX) {
    const [len, wid] = type === 'lorry' ? [6.4, 2.6] : [2.9, 1.7];
    const hx = (alongX ? len : wid) / 2;
    const hz = (alongX ? wid : len) / 2;
    if (!rectFree(x - hx, z - hz, x + hx, z + hz, 1.2) || heightAt(x, z) < 1) return false;
    claim(x - hx, z - hz, x + hx, z + hz);
    // yaw 0 faces -Z; -90 degrees faces +X.
    vehicleSpawns.push({ type, x, z, yaw: alongX ? -HALF_PI : 0, v: rnd() });
    return true;
  }
  addVehicle('lorry', -22, 15.6, true);
  addVehicle('lorry', 34, 44.5, true);
  addVehicle('lorry', 104, 62, false);
  addVehicle('lorry', 78, -72, true);
  addVehicle('auto', -8, 6.6, true);
  addVehicle('auto', 14, 22.5, false);
  addVehicle('auto', -76, 13.2, true);
  addVehicle('auto', 9, -22, false);
  addVehicle('auto', 62, 108, true);
  addVehicle('auto', -98, 46, false);
  addVehicle('auto', 100, -30, false);
  addVehicle('auto', 30, -88, true);
  addVehicle('auto', -108, -52, false);
  addVehicle('auto', -30, 122, true);
  addVehicle('auto', 88, 84, false);

  // --- Supply camps in the wild -------------------------------------------------
  for (let a = 0, placed = 0; a < 300 && placed < 8; a++) {
    const x = rf(-140, 140);
    const z = rf(-140, 140);
    const y = heightAt(x, z);
    if (y < 1.5 || inFields(x, z, 4)) continue;
    if (!rectFree(x - 3, z - 3, x + 3, z + 3, 14) || distToRoads(x, z) < 6) continue;
    if (Math.abs(heightAt(x + 2, z) - y) > 0.5 || Math.abs(heightAt(x, z + 2) - y) > 0.5) continue;
    claim(x - 3, z - 3, x + 3, z + 3);
    addCrate(x, z, 1.2, y, rnd() < 0.5);
    addCrate(x + 1.5, z + 0.4, 1.0, y);
    if (rnd() < 0.6) addCrate(x - 0.3, z + 1.6, 1.1, y);
    addLoot(x - 1.4, heightAt(x - 1.4, z - 0.8), z - 0.8, 1);
    addLoot(x + 0.6, heightAt(x + 0.6, z - 1.6), z - 1.6, rnd() < 0.3 ? 2 : 1);
    placed++;
  }

  // --- Fishing boats pulled up on the beaches -----------------------------------
  const boats = [];
  for (let a = 0; a < 2500 && boats.length < 9; a++) {
    const x = rf(-170, 170);
    const z = rf(-170, 170);
    const y = heightAt(x, z);
    if (y < 0.3 || y > 0.9) continue;
    if (boats.some((b) => (b.x - x) * (b.x - x) + (b.z - z) * (b.z - z) < 40 * 40)) continue;
    if (!rectFree(x - 3, z - 3, x + 3, z + 3, 2) || distToRoads(x, z) < 5) continue;
    const alongX = rnd() < 0.5;
    claim(x - 3, z - 3, x + 3, z + 3);
    const hx = alongX ? 2.6 : 0.8;
    const hz = alongX ? 0.8 : 2.6;
    addBox(x - hx, y - 0.5, z - hz, x + hx, y + 0.85, z + hz, 'boat', 0xffffff, 0);
    decor.push({ t: 'boat', x, y, z, ax: alongX ? 'x' : 'z', v: rnd() });
    boats.push({ x, z });
    const lx = x + (alongX ? 0 : 1.6);
    const lz = z + (alongX ? 1.6 : 0);
    if (rnd() < 0.6 && heightAt(lx, lz) > 0.4) addLoot(lx, heightAt(lx, lz), lz, 1);
  }

  // --- Rocks -----------------------------------------------------------------------
  for (let a = 0, placed = 0; a < 900 && placed < 70; a++) {
    const x = rf(-165, 165);
    const z = rf(-165, 165);
    const y = heightAt(x, z);
    if (y < 0.4 || inFields(x, z, 2)) continue;
    // Prefer high ground and the woods.
    const want = y > 9 ? 1 : fbm(x / 30, z / 30, seed + 21, 2) > 0.58 ? 0.8 : 0.12;
    if (rnd() > want) continue;
    const sx = rf(1.0, 2.6);
    const sz = rf(1.0, 2.6);
    const sy = rf(0.9, 2.4);
    if (!rectFree(x - sx, z - sz, x + sx, z + sz, 1.5) || distToRoads(x, z) < 4.5 + sx) continue;
    claim(x - sx, z - sz, x + sx, z + sz);
    addBox(x - sx * 0.8, y - 1, z - sz * 0.8, x + sx * 0.8, y + sy * 0.85, z + sz * 0.8, 'rock', 0x8c8c86, 0);
    decor.push({ t: 'rock', x, y, z, sx, sy, sz, v: rnd() });
    placed++;
  }

  // --- Trees: coconut palms on low ground, broadleaf trees inland -------------------
  const woods = byId.woods;
  function tryTree(x, z, forcePalm) {
    const y = heightAt(x, z);
    if (y < 0.7 || inFields(x, z, 1.5)) return false;
    if (!rectFree(x - 0.4, z - 0.4, x + 0.4, z + 0.4, 1.6) || distToRoads(x, z) < 4.2) return false;
    const palm = forcePalm ?? y < 3.2;
    claim(x - 0.6, z - 0.6, x + 0.6, z + 0.6);
    if (palm) {
      const h = rf(6.5, 10);
      addBox(x - 0.25, y - 1, z - 0.25, x + 0.25, y + h, z + 0.25, 'trunk', 0x8a7350, 0);
      decor.push({ t: 'palm', x, y, z, h, v: rnd() });
    } else {
      const h = rf(4.2, 6.5);
      addBox(x - 0.32, y - 1, z - 0.32, x + 0.32, y + h * 0.62, z + 0.32, 'trunk', 0x6b4e33, 0);
      decor.push({ t: 'tree', x, y, z, h, r: rf(1.9, 3.1), v: rnd() });
    }
    return true;
  }
  for (let a = 0, placed = 0; a < 900 && placed < 130; a++) {
    let ux;
    let uz;
    do {
      ux = rnd() * 2 - 1;
      uz = rnd() * 2 - 1;
    } while (ux * ux + uz * uz > 1);
    if (tryTree(woods.x + ux * (woods.r + 12), woods.z + uz * (woods.r + 12), false)) placed++;
  }
  for (let a = 0, placed = 0; a < 5000 && placed < 260; a++) {
    const x = rf(-170, 170);
    const z = rf(-170, 170);
    const density = fbm(x / 45, z / 45, seed + 11, 3);
    if (rnd() > density * 1.25 - 0.2) continue;
    if (tryTree(x, z)) placed++;
  }
  // Palms lining the village and the harbour road.
  for (const p of [byId.village, byId.harbour, byId.junction]) {
    for (let a = 0, placed = 0; a < 120 && placed < 10; a++) {
      if (tryTree(p.x + rf(-p.r, p.r), p.z + rf(-p.r, p.r), true)) placed++;
    }
  }

  // --- Extra loot scattered across the countryside ------------------------------------
  for (let a = 0, placed = 0; a < 600 && placed < 34; a++) {
    const x = rf(-150, 150);
    const z = rf(-150, 150);
    const y = heightAt(x, z);
    if (y < 1.2) continue;
    if (!rectFree(x - 0.5, z - 0.5, x + 0.5, z + 0.5, 0.8)) continue;
    addLoot(x, y, z, 1);
    placed++;
  }

  // ---------------------------------------------------------------- spatial hash
  const cells = new Array(BOX_N * BOX_N);
  for (let i = 0; i < cells.length; i++) cells[i] = [];
  const cellOf = (v) => {
    const c = Math.floor((v + WORLD_HALF) / BOX_CELL);
    return c < 0 ? 0 : c >= BOX_N ? BOX_N - 1 : c;
  };
  for (const b of boxes) {
    const cx0 = cellOf(b.x0);
    const cx1 = cellOf(b.x1);
    const cz0 = cellOf(b.z0);
    const cz1 = cellOf(b.z1);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) cells[cz * BOX_N + cx].push(b);
    }
  }

  // Collects boxes that may touch the given XZ rectangle (may contain duplicates).
  function queryBoxes(x0, z0, x1, z1, out) {
    out.length = 0;
    const cx0 = cellOf(x0);
    const cx1 = cellOf(x1);
    const cz0 = cellOf(z0);
    const cz1 = cellOf(z1);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = cells[cz * BOX_N + cx];
        for (let i = 0; i < cell.length; i++) out.push(cell[i]);
      }
    }
    return out;
  }

  return {
    seed,
    size: WORLD_SIZE,
    heights,
    maxHeight,
    heightAt,
    isLand: (x, z) => heightAt(x, z) > SEA_LEVEL + 0.6,
    boxes,
    decor,
    lootSpawns,
    vehicleSpawns,
    pois: POIS,
    roads: ROADS,
    fields: FIELDS,
    cells,
    cellSize: BOX_CELL,
    cellCount: BOX_N,
    queryBoxes,
  };
}
