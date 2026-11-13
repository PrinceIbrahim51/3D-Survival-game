// Builds the static 3D scene for Aindinai Island from the shared world data:
// terrain with a painted ground texture, water, sky, every building and prop,
// trees, plus the top-down map image used by the minimap.

import * as THREE from 'three';
import { GRID_N, GRID_CELL, FIELDS, ROADS, POIS } from '/shared/world.js';
import { WORLD_SIZE, WORLD_HALF } from '/shared/constants.js';
import { fbm, smooth01 } from '/shared/rng.js';

const CHUNK = 90; // metres; static geometry is split into chunks for culling
const tmpColor = new THREE.Color();
const colorCache = new Map();

function rgb(hex) {
  let c = colorCache.get(hex);
  if (!c) {
    tmpColor.setHex(hex);
    c = [tmpColor.r, tmpColor.g, tmpColor.b];
    colorCache.set(hex, c);
  }
  return c;
}

// Collects coloured triangles and turns them into one BufferGeometry.
export class GeoBuilder {
  constructor() {
    this.pos = [];
    this.col = [];
  }

  tri(a, b, c, color, shade = 1) {
    const k = rgb(color);
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) this.col.push(k[0] * shade, k[1] * shade, k[2] * shade);
  }

  quad(a, b, c, d, color, shade = 1) {
    this.tri(a, b, c, color, shade);
    this.tri(a, c, d, color, shade);
  }

  box(x0, y0, z0, x1, y1, z1, color, opts = {}) {
    const top = opts.top ?? color;
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], top, 1.06);
    if (opts.bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], color, 0.7);
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], color, 0.94);
    this.quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], color, 0.9);
    this.quad([x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], color, 1.0);
    this.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], color, 0.86);
  }

  // Appends a three.js geometry, transformed by `matrix`.
  geometry(geom, matrix, color, shade = 1) {
    const g = geom.index ? geom.toNonIndexed() : geom;
    const p = g.attributes.position;
    const v = new THREE.Vector3();
    const k = rgb(color);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      if (matrix) v.applyMatrix4(matrix);
      this.pos.push(v.x, v.y, v.z);
      this.col.push(k[0] * shade, k[1] * shade, k[2] * shade);
    }
    if (g !== geom) g.dispose();
  }

  get empty() {
    return this.pos.length === 0;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

const mix = (a, b, t) => a + (b - a) * (t < 0 ? 0 : t > 1 ? 1 : t);
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

// --------------------------------------------------------------- ground paint

function strokeRoads(ctx, width, style, dash) {
  ctx.lineWidth = width;
  ctx.strokeStyle = style;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash(dash || []);
  for (const road of ROADS) {
    ctx.beginPath();
    road.pts.forEach((p, i) => {
      // The bridge segment has no ground under it.
      if (i === 0 || i - 1 === road.bridge) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// Paints the ground colour texture and the map image. Both are drawn in world
// coordinates (x to the right, z down) so they line up with the terrain.
function paintMaps(world, groundSize, mapSize) {
  const L = 512;
  const ground = new Uint8ClampedArray(L * L * 4);
  const map = new Uint8ClampedArray(L * L * 4);
  const sand = [224, 206, 160];
  const wet = [168, 160, 126];
  const seabed = [84, 118, 120];
  const grassA = [98, 146, 66];
  const grassB = [132, 170, 82];
  const dry = [182, 164, 106];
  const dark = [70, 114, 58];
  const tea = [92, 150, 86];
  const rock = [130, 124, 114];
  const pads = {
    junction: [156, 150, 140], village: [190, 156, 116], harbour: [146, 146, 140], outpost: [176, 156, 114],
  };
  const byId = Object.fromEntries(POIS.map((p) => [p.id, p]));
  const step = WORLD_SIZE / L;
  for (let j = 0; j < L; j++) {
    for (let i = 0; i < L; i++) {
      const x = -WORLD_HALF + (i + 0.5) * step;
      const z = -WORLD_HALF + (j + 0.5) * step;
      const h = world.heightAt(x, z);
      let c;
      let m;
      if (h < -0.15) {
        c = mix3(wet, seabed, -h / 2.4);
        m = mix3([108, 196, 204], [30, 104, 150], -h / 2.6);
      } else if (h < 0.75) {
        c = mix3(wet, sand, (h + 0.15) / 0.4);
        m = sand;
      } else {
        const n1 = fbm(x / 14, z / 14, 5, 3);
        const n2 = fbm(x / 2.7, z / 2.7, 9, 2);
        c = mix3(grassA, grassB, n1 * 1.4 - 0.2);
        const dO = Math.hypot(x - byId.outpost.x, z - byId.outpost.z);
        c = mix3(c, dry, (1 - smooth01(dO / 78)) * 0.9);
        const dW = Math.hypot(x - byId.woods.x, z - byId.woods.z);
        c = mix3(c, dark, (1 - smooth01(dW / 62)) * 0.75);
        if (h > 8) c = mix3(c, tea, ((h - 8) / 6) * 0.7);
        const slope = Math.abs(world.heightAt(x + 1.2, z) - world.heightAt(x - 1.2, z))
          + Math.abs(world.heightAt(x, z + 1.2) - world.heightAt(x, z - 1.2));
        c = mix3(c, rock, (slope - 1.9) / 1.2);
        for (const id of Object.keys(pads)) {
          const p = byId[id];
          const d = Math.hypot(x - p.x, z - p.z);
          const w = 1 - smooth01((d - p.r * (0.82 + (n1 - 0.5) * 0.25)) / (p.r * 0.2));
          if (w > 0) c = mix3(c, pads[id], w * 0.92);
        }
        c = mix3(sand, c, (h - 0.75) / 0.8);
        const b = 0.9 + n2 * 0.2;
        c = [c[0] * b, c[1] * b, c[2] * b];
        m = c;
      }
      const k = (j * L + i) * 4;
      ground[k] = c[0]; ground[k + 1] = c[1]; ground[k + 2] = c[2]; ground[k + 3] = 255;
      map[k] = m[0]; map[k + 1] = m[1]; map[k + 2] = m[2]; map[k + 3] = 255;
    }
  }

  function finish(data, size, forMap) {
    const low = document.createElement('canvas');
    low.width = low.height = L;
    low.getContext('2d').putImageData(new ImageData(data, L, L), 0, 0);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(low, 0, 0, size, size);
    const s = size / WORLD_SIZE;
    ctx.setTransform(s, 0, 0, s, size / 2, size / 2);

    // Paddy fields: a patchwork of plots divided by earth bunds.
    const f = FIELDS;
    const greens = ['#8fc956', '#7fbf4f', '#9ad063', '#86b95a', '#74b267'];
    const cols = 4;
    const rows = 4;
    const pw = (f.x1 - f.x0) / cols;
    const ph = (f.z1 - f.z0) / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = greens[(r * 3 + c * 2) % greens.length];
        ctx.fillRect(f.x0 + c * pw, f.z0 + r * ph, pw, ph);
      }
    }
    if (!forMap) {
      // Rows of rice plants.
      ctx.strokeStyle = 'rgba(40, 90, 30, 0.22)';
      ctx.lineWidth = 0.14;
      ctx.beginPath();
      for (let x = f.x0 + 0.5; x < f.x1; x += 0.7) {
        ctx.moveTo(x, f.z0);
        ctx.lineTo(x, f.z1);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = '#8f7b52';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let c = 0; c <= cols; c++) {
      ctx.moveTo(f.x0 + c * pw, f.z0);
      ctx.lineTo(f.x0 + c * pw, f.z1);
    }
    for (let r = 0; r <= rows; r++) {
      ctx.moveTo(f.x0, f.z0 + r * ph);
      ctx.lineTo(f.x1, f.z0 + r * ph);
    }
    ctx.stroke();

    // Roads: dirt shoulder, asphalt, dashed centre line.
    strokeRoads(ctx, 7, forMap ? 'rgba(120,104,84,0.9)' : 'rgba(150,132,104,0.85)');
    strokeRoads(ctx, 5.2, forMap ? '#d8d0c0' : '#5d5b58');
    if (!forMap) strokeRoads(ctx, 0.2, '#e6dca8', [2.2, 2.6]);
    // Roundabout around the clock tower.
    const j = byId.junction;
    ctx.fillStyle = forMap ? '#d8d0c0' : '#5d5b58';
    ctx.beginPath();
    ctx.arc(j.x, j.z, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = forMap ? '#b9b2a2' : '#a59d8e';
    ctx.beginPath();
    ctx.arc(j.x, j.z, 4.2, 0, Math.PI * 2);
    ctx.fill();

    if (forMap) {
      // Footprints of everything solid.
      for (const b of world.boxes) {
        let style = null;
        if (b.k === 'roof') style = '#' + b.c.toString(16).padStart(6, '0');
        else if (b.k === 'container' || b.k === 'tank' || b.k === 'tower' || b.k === 'hay') style = '#' + b.c.toString(16).padStart(6, '0');
        else if (b.k === 'compound') style = '#5a5644';
        else if (b.k === 'bridge' || b.k === 'pier') style = '#b9ab90';
        else if (b.k === 'lighthouse') style = '#f4f0e6';
        else if (b.k === 'rock') style = '#8d8d86';
        if (!style) continue;
        ctx.fillStyle = style;
        ctx.fillRect(b.x0, b.z0, b.x1 - b.x0, b.z1 - b.z0);
      }
      for (const d of world.decor) {
        if (d.t !== 'palm' && d.t !== 'tree') continue;
        ctx.fillStyle = d.t === 'palm' ? 'rgba(52,128,58,0.9)' : 'rgba(40,104,48,0.9)';
        ctx.beginPath();
        ctx.arc(d.x, d.z, d.t === 'palm' ? 1.5 : d.r * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Fine speckle so the ground does not look flat up close.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const tile = document.createElement('canvas');
      tile.width = tile.height = 128;
      const tc = tile.getContext('2d');
      const id = tc.createImageData(128, 128);
      let seed = 1234567;
      for (let k = 0; k < id.data.length; k += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        const v = (seed >>> 24) & 255;
        id.data[k] = id.data[k + 1] = id.data[k + 2] = v;
        id.data[k + 3] = 26;
      }
      tc.putImageData(id, 0, 0);
      ctx.fillStyle = ctx.createPattern(tile, 'repeat');
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  return { ground: finish(ground, groundSize, false), map: finish(map, mapSize, true) };
}

function makeDetailTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(size, size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // Tileable noise: wrap coordinates through the hash period.
      const a = fbm(i / 6, j / 6, 77, 3);
      const b = fbm((i - size) / 6, j / 6, 77, 3);
      const c = fbm(i / 6, (j - size) / 6, 77, 3);
      const d = fbm((i - size) / 6, (j - size) / 6, 77, 3);
      const u = i / size;
      const v = j / size;
      const n = (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
      const val = Math.max(0, Math.min(255, 128 + (n - 0.5) * 420));
      const k = (j * size + i) * 4;
      id.data[k] = id.data[k + 1] = id.data[k + 2] = val;
      id.data[k + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// ------------------------------------------------------------------- terrain

function buildTerrain(world, groundCanvas, maxAniso) {
  const n = GRID_N;
  const pos = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      pos[k * 3] = -WORLD_HALF + i * GRID_CELL;
      pos[k * 3 + 1] = world.heights[k];
      pos[k * 3 + 2] = -WORLD_HALF + j * GRID_CELL;
      uv[k * 2] = i / (n - 1);
      uv[k * 2 + 1] = 1 - j / (n - 1);
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let t = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Same diagonal as world.heightAt().
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  const tex = new THREE.CanvasTexture(groundCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, maxAniso);
  const detail = makeDetailTexture();
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = { value: detail };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform sampler2D detailMap;\nvoid main() {')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float det = texture2D( detailMap, vMapUv * 150.0 ).r;
        float det2 = texture2D( detailMap, vMapUv * 23.0 ).r;
        diffuseColor.rgb *= 0.74 + det * 0.34 + det2 * 0.18;`,
      );
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// --------------------------------------------------------------------- props

const HEX6 = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
const DODECA = new THREE.DodecahedronGeometry(1, 0);
const ICOSA = new THREE.IcosahedronGeometry(1, 0);
const OCTA = new THREE.OctahedronGeometry(1, 0);
const CYL12 = new THREE.CylinderGeometry(1, 1, 1, 12, 1, false);
const CONE4 = new THREE.ConeGeometry(1, 1, 4, 1, false);
const CIRCLE = new THREE.CircleGeometry(1, 20);
const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const E = new THREE.Euler();

function trs(x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
  E.set(rx, ry, rz);
  Q.setFromEuler(E);
  return M.compose(V1.set(x, y, z), Q, V2.set(sx, sy, sz));
}

function addPalm(solid, leaves, d) {
  const ang = d.v * Math.PI * 2;
  const lean = 0.5 + ((d.v * 7) % 1) * 1.6;
  const lx = Math.cos(ang) * lean;
  const lz = Math.sin(ang) * lean;
  const rings = [];
  const segs = 4;
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const r = 0.26 - t * 0.12;
    const cx = d.x + lx * t * t;
    const cy = d.y - 0.4 + (d.h + 0.4) * t;
    const cz = d.z + lz * t * t;
    const ring = [];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      ring.push([cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r]);
    }
    rings.push(ring);
  }
  for (let s = 0; s < segs; s++) {
    for (let k = 0; k < 6; k++) {
      const k2 = (k + 1) % 6;
      solid.quad(rings[s][k], rings[s + 1][k], rings[s + 1][k2], rings[s][k2], s % 2 ? 0x8f7a58 : 0x7d6a4c, 0.85 + (k % 3) * 0.08);
    }
  }
  const tx = d.x + lx;
  const ty = d.y + d.h;
  const tz = d.z + lz;
  const fronds = 9;
  const drop = [0.1, 0.75, 0.55, -0.9];
  const width = [0.22, 0.62, 0.5, 0.06];
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + d.v * 5;
    const len = 3.0 + ((d.v * 13 + f * 0.37) % 1) * 1.1;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const pts = [];
    for (let k = 0; k < 4; k++) {
      const t = k / 3;
      const cx = tx + dx * len * t;
      const cy = ty + drop[k] * (0.8 + ((f * 0.61 + d.v) % 1) * 0.5);
      const cz = tz + dz * len * t;
      pts.push([[cx - dz * width[k], cy, cz + dx * width[k]], [cx + dz * width[k], cy, cz - dx * width[k]], [cx, cy + 0.16, cz]]);
    }
    for (let k = 0; k < 3; k++) {
      const color = f % 2 ? 0x4a9a3e : 0x3f8a36;
      // Two halves folded along the midrib, like a real frond.
      leaves.quad(pts[k][0], pts[k + 1][0], pts[k + 1][2], pts[k][2], color, 0.95);
      leaves.quad(pts[k][2], pts[k + 1][2], pts[k + 1][1], pts[k][1], color, 1.08);
    }
  }
  for (let c = 0; c < 3; c++) {
    const a = c * 2.1 + d.v * 9;
    solid.geometry(OCTA, trs(tx + Math.cos(a) * 0.3, ty - 0.25, tz + Math.sin(a) * 0.3, 0.17, 0.2, 0.17), 0x5c7a2e);
  }
}

function addTree(solid, leaves, d) {
  const th = d.h * 0.62;
  solid.geometry(HEX6, trs(d.x, d.y + th / 2 - 0.3, d.z, 0.3, th + 0.6, 0.3), 0x6b4e33, 0.9);
  const greens = [0x3d7f36, 0x4a8f3c, 0x356f32, 0x548f45];
  const blobs = 3;
  for (let b = 0; b < blobs; b++) {
    const a = d.v * 6.283 + b * 2.2;
    const off = b === 0 ? 0 : d.r * 0.55;
    const r = d.r * (b === 0 ? 1 : 0.72);
    leaves.geometry(
      DODECA,
      trs(d.x + Math.cos(a) * off, d.y + th + r * 0.55 + (b === 0 ? 0.3 : -0.2), d.z + Math.sin(a) * off, r, r * 0.82, r, a, a * 1.7, 0),
      greens[(b + Math.floor(d.v * 4)) % greens.length],
      0.95 + b * 0.05,
    );
  }
}

function addRock(solid, d) {
  // Sits low so the top of the rock roughly matches its box collider.
  solid.geometry(ICOSA, trs(d.x, d.y - d.sy * 0.12, d.z, d.sx, d.sy, d.sz, d.v * 3, d.v * 7, d.v * 2), 0x8a8983, 0.9 + d.v * 0.2);
}

function addGable(solid, d) {
  const { x0, z0, x1, z1, y, h, c } = d;
  const wc = d.wc ?? 0xe9dfc8;
  if (d.ax === 'x') {
    const zm = (z0 + z1) / 2;
    solid.quad([x0, y, z1], [x1, y, z1], [x1, y + h, zm], [x0, y + h, zm], c, 1.0);
    solid.quad([x1, y, z0], [x0, y, z0], [x0, y + h, zm], [x1, y + h, zm], c, 0.85);
    solid.tri([x0, y, z0], [x0, y, z1], [x0, y + h, zm], wc, 0.9);
    solid.tri([x1, y, z1], [x1, y, z0], [x1, y + h, zm], wc, 0.95);
  } else {
    const xm = (x0 + x1) / 2;
    solid.quad([x1, y, z1], [x1, y, z0], [xm, y + h, z0], [xm, y + h, z1], c, 0.95);
    solid.quad([x0, y, z0], [x0, y, z1], [xm, y + h, z1], [xm, y + h, z0], c, 0.85);
    solid.tri([x0, y, z1], [x1, y, z1], [xm, y + h, z1], wc, 1.0);
    solid.tri([x1, y, z0], [x0, y, z0], [xm, y + h, z0], wc, 0.88);
  }
}

// Helper: add a box given in the local frame of a prop that is aligned with X
// (ax === 'x') or Z. Local +x is the prop's forward direction.
function localBox(solid, d, lx0, ly0, lz0, lx1, ly1, lz1, color) {
  if (d.ax === 'x') solid.box(d.x + lx0, d.y + ly0, d.z + lz0, d.x + lx1, d.y + ly1, d.z + lz1, color, { bottom: true });
  else solid.box(d.x + lz0, d.y + ly0, d.z + lx0, d.x + lz1, d.y + ly1, d.z + lx1, color, { bottom: true });
}

const LORRY_PAINT = [[0xd9a21b, 0x1f7a4d, 0xc0392b], [0x2e7dbf, 0xe0b23a, 0xb03a2e], [0xb5462f, 0xe8c34a, 0x2a6f8f], [0x2f8f5b, 0xd9d2c0, 0xc0562b]];
function addLorry(solid, d) {
  const p = LORRY_PAINT[Math.floor(d.v * LORRY_PAINT.length)];
  localBox(solid, d, -3.1, 0.55, -1.15, 3.1, 0.85, 1.15, 0x3a3a3a); // chassis
  localBox(solid, d, 1.5, 0.85, -1.15, 3.1, 2.55, 1.15, p[0]); // cab
  localBox(solid, d, 2.2, 1.65, -1.17, 3.12, 2.3, 1.17, 0x243640); // windows
  localBox(solid, d, 1.4, 2.55, -1.2, 3.15, 2.75, 1.2, p[2]); // painted crown board
  localBox(solid, d, -3.1, 0.85, -1.2, 1.35, 2.2, 1.2, p[1]); // cargo bed
  localBox(solid, d, -3.12, 1.25, -1.22, 1.37, 1.5, 1.22, p[2]); // stripe
  localBox(solid, d, -3.12, 1.85, -1.22, 1.37, 1.98, 1.22, p[0]);
  for (const wx of [-2.2, -1.1, 2.2]) {
    localBox(solid, d, wx - 0.45, 0, -1.2, wx + 0.45, 0.9, -0.85, 0x1c1c1c);
    localBox(solid, d, wx - 0.45, 0, 0.85, wx + 0.45, 0.9, 1.2, 0x1c1c1c);
  }
}

function addAuto(solid, d) {
  localBox(solid, d, -1.3, 0.3, -0.68, 1.0, 0.95, 0.68, 0xe8b923); // yellow tub
  localBox(solid, d, 0.85, 0.3, -0.42, 1.32, 0.9, 0.42, 0xe8b923); // nose
  localBox(solid, d, -1.25, 0.95, -0.66, -1.1, 1.6, 0.66, 0x202020); // rear frame
  localBox(solid, d, 0.7, 0.95, -0.62, 0.8, 1.6, 0.62, 0x2c3d47); // windscreen
  localBox(solid, d, -1.32, 1.6, -0.7, 0.9, 1.74, 0.7, 0x1b1b1b); // black canopy
  localBox(solid, d, -0.9, 0.95, -0.6, -0.3, 1.2, 0.6, 0x5a2d22); // seat
  localBox(solid, d, 0.85, 0, -0.14, 1.3, 0.5, 0.14, 0x161616);
  localBox(solid, d, -1.15, 0, -0.72, -0.65, 0.5, -0.5, 0x161616);
  localBox(solid, d, -1.15, 0, 0.5, -0.65, 0.5, 0.72, 0x161616);
}

const BOAT_PAINT = [[0x2a7fb8, 0xf2efe4], [0xc24a36, 0xf2c94c], [0x2f9a6a, 0xf2efe4], [0xe0a432, 0x2f5f8f]];
function addBoat(solid, d) {
  const p = BOAT_PAINT[Math.floor(d.v * BOAT_PAINT.length)];
  // Hull cross-sections from stern to bow: [x, halfWidth, keelY, gunwaleY].
  const secs = [[-2.6, 0.5, 0.2, 0.8], [-1.6, 0.78, 0.0, 0.78], [0.6, 0.8, 0.0, 0.8], [1.9, 0.5, 0.12, 0.95], [2.8, 0.04, 0.5, 1.25]];
  const P = (lx, ly, lz) => (d.ax === 'x' ? [d.x + lx, d.y + ly, d.z + lz] : [d.x + lz, d.y + ly, d.z + lx]);
  // Mirrored placement flips handedness, so swap winding for the Z-aligned case.
  const quad = (a, b, c, e, color, shade) => (d.ax === 'x' ? solid.quad(a, b, c, e, color, shade) : solid.quad(e, c, b, a, color, shade));
  for (let i = 0; i < secs.length - 1; i++) {
    const [xa, wa, ka, ga] = secs[i];
    const [xb, wb, kb, gb] = secs[i + 1];
    quad(P(xa, ka, 0), P(xa, ga, wa), P(xb, gb, wb), P(xb, kb, 0), p[0], 1.0); // starboard
    quad(P(xb, kb, 0), P(xb, gb, -wb), P(xa, ga, -wa), P(xa, ka, 0), p[0], 0.85); // port
    quad(P(xa, ga - 0.22, wa * 0.86), P(xa, ga - 0.22, -wa * 0.86), P(xb, gb - 0.22, -wb * 0.86), P(xb, gb - 0.22, wb * 0.86), p[1], 0.9); // deck
  }
  const [xs, ws, ks, gs] = secs[0];
  quad(P(xs, ks, 0), P(xs, gs, -ws), P(xs, gs, ws), P(xs, ks, 0), p[1], 0.8); // stern
}

function addLighthouse(solid, d) {
  const bands = 6;
  const bh = d.h / bands;
  for (let b = 0; b < bands; b++) {
    const r0 = 1.9 - (b / bands) * 0.7;
    const r1 = 1.9 - ((b + 1) / bands) * 0.7;
    const g = new THREE.CylinderGeometry(r1, r0, bh, 12, 1, true);
    solid.geometry(g, trs(d.x, d.y + bh * (b + 0.5), d.z, 1, 1, 1), b % 2 ? 0xc0392b : 0xf2efe6);
    g.dispose();
  }
  solid.geometry(CYL12, trs(d.x, d.y + d.h + 0.15, d.z, 1.9, 0.3, 1.9), 0x3a3a3a);
  solid.geometry(CYL12, trs(d.x, d.y + d.h + 1.1, d.z, 1.0, 1.6, 1.0), 0xffe9a0);
  const cone = new THREE.ConeGeometry(1.35, 1.2, 12);
  solid.geometry(cone, trs(d.x, d.y + d.h + 2.5, d.z, 1, 1, 1), 0xc0392b);
  cone.dispose();
}

function addClock(solid, d) {
  for (let s = 0; s < 4; s++) {
    const a = (s * Math.PI) / 2;
    const nx = Math.sin(a);
    const nz = Math.cos(a);
    solid.geometry(CIRCLE, trs(d.x + nx * d.s, d.y, d.z + nz * d.s, 1.25, 1.25, 1, 0, a, 0), 0xfaf6ea);
    solid.geometry(CIRCLE, trs(d.x + nx * (d.s + 0.01), d.y, d.z + nz * (d.s + 0.01), 0.1, 0.1, 1, 0, a, 0), 0x222222);
    // Hands: thin boxes lying on the face.
    const hand = new THREE.BoxGeometry(0.1, 0.95, 0.02);
    hand.translate(0, 0.42, 0);
    solid.geometry(hand, trs(d.x + nx * (d.s + 0.02), d.y, d.z + nz * (d.s + 0.02), 1, 1, 1, 0, a, -0.9), 0x222222);
    solid.geometry(hand, trs(d.x + nx * (d.s + 0.02), d.y, d.z + nz * (d.s + 0.02), 1, 0.7, 1, 0, a, 1.3), 0x222222);
    hand.dispose();
  }
}

// Geometry for a drivable vehicle, modelled facing +X with its origin on the
// ground under its centre.
export function vehicleGeometry(type, variant) {
  const b = new GeoBuilder();
  const d = { x: 0, y: 0, z: 0, ax: 'x', v: variant };
  if (type === 'lorry') addLorry(b, d);
  else addAuto(b, d);
  return b.build();
}

const BOX_STYLE = {
  floor: { top: 0xa89c8a },
  stairs: {},
  crate: { top: 0xc49a62 },
  hay: { top: 0xe6c85a },
  bush: { top: 0x4c9244 },
  pier: { top: 0xb08f66 },
  bridge: { top: 0x6a6866 },
  sandbag: { top: 0xcbb98c },
  container: {},
};

// ----------------------------------------------------------------- the scene

export function buildWorldScene(world, renderer, quality) {
  const group = new THREE.Group();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const groundSize = quality === 'low' ? 1024 : 2048;
  const maps = paintMaps(world, groundSize, 1024);

  const terrain = buildTerrain(world, maps.ground, maxAniso);
  group.add(terrain);

  // Sea: a huge plane; the island pokes through it.
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(3000, 3000),
    new THREE.MeshLambertMaterial({ color: 0x3aa6c4, transparent: true, opacity: 0.8 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0;
  water.renderOrder = 1;
  group.add(water);
  // Sea floor continuing beyond the edge of the terrain grid.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshLambertMaterial({ color: 0x547678 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -3.22;
  group.add(floor);

  // Sky dome with a simple vertical gradient.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1400, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x3f8fd8) },
        horizon: { value: new THREE.Color(0xcfe6ef) },
        sunDir: { value: new THREE.Vector3(0.45, 0.72, 0.32).normalize() },
      },
      vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 c = mix(horizon, top, pow(h, 0.55));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          c += vec3(1.0, 0.85, 0.6) * (pow(s, 600.0) * 1.5 + pow(s, 12.0) * 0.18);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  group.add(sky);

  // Static geometry, split into chunks.
  const chunks = new Map();
  function builderFor(kind, x, z) {
    const cx = Math.floor((x + WORLD_HALF) / CHUNK);
    const cz = Math.floor((z + WORLD_HALF) / CHUNK);
    const key = kind + ':' + cx + ':' + cz;
    let b = chunks.get(key);
    if (!b) {
      b = new GeoBuilder();
      b.kind = kind;
      chunks.set(key, b);
    }
    return b;
  }

  for (const b of world.boxes) {
    if (!b.v) continue;
    const solid = builderFor('solid', (b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
    const style = BOX_STYLE[b.k] || {};
    solid.box(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, b.c, { top: style.top, bottom: b.k === 'roof' || b.k === 'tank' || b.k === 'bridge' || b.k === 'container' });
    if (b.k === 'container') {
      // Corrugation ribs and door bars.
      const along = b.x1 - b.x0 > b.z1 - b.z0;
      const dark = 0x1d1d1d;
      if (along) {
        for (let x = b.x0 + 0.5; x < b.x1 - 0.2; x += 1) {
          solid.box(x, b.y0 + 0.15, b.z0 - 0.03, x + 0.12, b.y1 - 0.15, b.z1 + 0.03, dark);
        }
      } else {
        for (let z = b.z0 + 0.5; z < b.z1 - 0.2; z += 1) {
          solid.box(b.x0 - 0.03, b.y0 + 0.15, z, b.x1 + 0.03, b.y1 - 0.15, z + 0.12, dark);
        }
      }
    }
  }
  for (const d of world.decor) {
    const solid = builderFor('solid', d.x ?? d.x0, d.z ?? d.z0);
    const leaves = builderFor('leaves', d.x ?? d.x0, d.z ?? d.z0);
    switch (d.t) {
      case 'palm': addPalm(solid, leaves, d); break;
      case 'tree': addTree(solid, leaves, d); break;
      case 'rock': addRock(solid, d); break;
      case 'gable': addGable(solid, d); break;
      case 'boat': addBoat(leaves, d); break;
      case 'lighthouse': addLighthouse(solid, d); break;
      case 'clock': addClock(leaves, d); break;
      case 'spire': solid.geometry(CONE4, trs(d.x, d.y + d.h / 2, d.z, d.w * 0.72, d.h, d.w * 0.72, 0, Math.PI / 4, 0), d.c); break;
      default:
    }
  }
  const solidMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const leafMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  const shadows = quality !== 'low';
  for (const b of chunks.values()) {
    if (b.empty) continue;
    const mesh = new THREE.Mesh(b.build(), b.kind === 'solid' ? solidMat : leafMat);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  // Lighting: warm sun, cool sky fill.
  const hemi = new THREE.HemisphereLight(0xdcefff, 0x7c8a5c, 1.35);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.3);
  const sunDir = new THREE.Vector3(0.45, 0.72, 0.32).normalize();
  sun.position.copy(sunDir).multiplyScalar(150);
  if (shadows) {
    sun.castShadow = true;
    const size = quality === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(size, size);
    const ext = quality === 'high' ? 75 : 55;
    sun.shadow.camera.left = -ext;
    sun.shadow.camera.right = ext;
    sun.shadow.camera.top = ext;
    sun.shadow.camera.bottom = -ext;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 320;
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.05;
  }
  group.add(sun);
  group.add(sun.target);

  return {
    group,
    mapCanvas: maps.map,
    sun,
    sunDir,
    sky,
    // Keeps the shadow frustum centred on the area around the camera.
    follow(x, y, z) {
      // Snap to whole metres so shadow edges do not shimmer while moving.
      const fx = Math.round(x);
      const fz = Math.round(z);
      sun.target.position.set(fx, y, fz);
      sun.position.set(fx + sunDir.x * 150, y + sunDir.y * 150, fz + sunDir.z * 150);
      sky.position.set(x, 0, z);
    },
  };
}
