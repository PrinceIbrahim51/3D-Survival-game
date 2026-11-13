// Coarse navigation grid for bots: 1 m cells, A* path search. Built once per
// world. Bots only navigate at ground level; roofs and towers are for humans.

import { WORLD_SIZE, WORLD_HALF, PLAYER_RADIUS, PLAYER_HEIGHT, STEP_HEIGHT } from '../shared/constants.js';

const N = WORLD_SIZE; // cells per side (1 m each)

export function buildNav(world) {
  const walk = new Uint8Array(N * N);
  const tmp = [];
  const r = PLAYER_RADIUS + 0.05;
  for (let cz = 0; cz < N; cz++) {
    for (let cx = 0; cx < N; cx++) {
      const x = cx - WORLD_HALF + 0.5;
      const z = cz - WORLD_HALF + 0.5;
      if (Math.abs(x) > WORLD_HALF - 4 || Math.abs(z) > WORLD_HALF - 4) continue;
      // Stand on low boxes (floors, first stair steps).
      let floor = world.heightAt(x, z);
      const boxes = world.queryBoxes(x - r, z - r, x + r, z + r, tmp);
      for (const b of boxes) {
        if (b.y1 > floor && b.y1 <= floor + STEP_HEIGHT && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) floor = b.y1;
      }
      // The bridge deck and the pier stand over water, far more than a step
      // above the creek bed, so they are accepted explicitly.
      for (const b of boxes) {
        if ((b.k === 'bridge' || b.k === 'pier') && x >= b.x0 + r && x <= b.x1 - r && z >= b.z0 && z <= b.z1) floor = b.y1;
      }
      if (floor < -0.9) continue; // deep water: bots stay out
      let blocked = false;
      for (const b of boxes) {
        if (b.y1 <= floor + STEP_HEIGHT || b.y0 >= floor + PLAYER_HEIGHT) continue;
        const px = x < b.x0 ? b.x0 : x > b.x1 ? b.x1 : x;
        const pz = z < b.z0 ? b.z0 : z > b.z1 ? b.z1 : z;
        if ((x - px) * (x - px) + (z - pz) * (z - pz) < r * r) {
          blocked = true;
          break;
        }
      }
      if (!blocked) walk[cz * N + cx] = 1;
    }
  }

  const cellOf = (v) => {
    const c = Math.floor(v + WORLD_HALF);
    return c < 0 ? 0 : c >= N ? N - 1 : c;
  };
  // Parked vehicles are not part of the static world, but bots should still
  // walk around where they start out.
  for (const sp of world.vehicleSpawns || []) {
    const rad = sp.type === 'lorry' ? 3.6 : 1.9;
    for (let cz = cellOf(sp.z - rad); cz <= cellOf(sp.z + rad); cz++) {
      for (let cx = cellOf(sp.x - rad); cx <= cellOf(sp.x + rad); cx++) {
        const x = cx - WORLD_HALF + 0.5;
        const z = cz - WORLD_HALF + 0.5;
        if ((x - sp.x) * (x - sp.x) + (z - sp.z) * (z - sp.z) < rad * rad) walk[cz * N + cx] = 0;
      }
    }
  }
  const isWalkable = (x, z) => walk[cellOf(z) * N + cellOf(x)] === 1;

  // Nearest walkable cell centre to (x, z), searching outward in rings.
  function nearestWalkable(x, z, maxRing = 8) {
    const cx = cellOf(x);
    const cz = cellOf(z);
    if (walk[cz * N + cx]) return cz * N + cx;
    for (let ring = 1; ring <= maxRing; ring++) {
      let best = -1;
      let bestD = Infinity;
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= N || nz >= N || !walk[nz * N + nx]) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = nz * N + nx;
          }
        }
      }
      if (best !== -1) return best;
    }
    return -1;
  }

  // True when a straight walk between two points crosses only walkable cells.
  function lineClear(x0, z0, x1, z1) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.sqrt(dx * dx + dz * dz);
    const steps = Math.ceil(len / 0.4);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (!isWalkable(x0 + dx * t, z0 + dz * t)) return false;
    }
    return true;
  }

  // A* scratch buffers, reused across searches.
  const gScore = new Float32Array(N * N);
  const parent = new Int32Array(N * N);
  const stamp = new Uint32Array(N * N);
  const closed = new Uint32Array(N * N);
  let searchId = 0;
  const heap = [];
  const heapF = [];

  function push(node, f) {
    let i = heap.length;
    heap.push(node);
    heapF.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= f) break;
      heap[i] = heap[p];
      heapF[i] = heapF[p];
      i = p;
    }
    heap[i] = node;
    heapF[i] = f;
  }
  function pop() {
    const top = heap[0];
    const last = heap.pop();
    const lastF = heapF.pop();
    const n = heap.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && heapF[c + 1] < heapF[c]) c++;
        if (heapF[c] >= lastF) break;
        heap[i] = heap[c];
        heapF[i] = heapF[c];
        i = c;
      }
      heap[i] = last;
      heapF[i] = lastF;
    }
    return top;
  }

  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
  const COST = [1, 1, 1, 1, 1.4142, 1.4142, 1.4142, 1.4142];

  // Returns an array of [x, z] waypoints from start to goal, or null.
  function findPath(sx, sz, tx, tz, maxExpand = 9000) {
    const start = nearestWalkable(sx, sz);
    const goal = nearestWalkable(tx, tz);
    if (start === -1 || goal === -1) return null;
    if (start === goal) return [[tx, tz]];
    searchId++;
    heap.length = 0;
    heapF.length = 0;
    const gx = goal % N;
    const gz = (goal - gx) / N;
    gScore[start] = 0;
    parent[start] = -1;
    stamp[start] = searchId;
    push(start, 0);
    let expanded = 0;
    let bestNode = start;
    let bestH = Infinity;
    let found = false;
    while (heap.length > 0 && expanded < maxExpand) {
      const cur = pop();
      if (closed[cur] === searchId) continue;
      closed[cur] = searchId;
      if (cur === goal) {
        found = true;
        break;
      }
      expanded++;
      const cx = cur % N;
      const cz = (cur - cx) / N;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k];
        const nz = cz + DZ[k];
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        const ni = nz * N + nx;
        if (!walk[ni] || closed[ni] === searchId) continue;
        // No cutting corners diagonally.
        if (k >= 4 && (!walk[cz * N + nx] || !walk[nz * N + cx])) continue;
        const g = gScore[cur] + COST[k];
        if (stamp[ni] === searchId && g >= gScore[ni]) continue;
        stamp[ni] = searchId;
        gScore[ni] = g;
        parent[ni] = cur;
        const ax = Math.abs(nx - gx);
        const az = Math.abs(nz - gz);
        const h = (ax + az) + (1.4142 - 2) * Math.min(ax, az);
        if (h < bestH) {
          bestH = h;
          bestNode = ni;
        }
        push(ni, g + h * 1.05);
      }
    }
    // If the goal was out of reach within the budget, walk toward the closest
    // point we did reach; the bot will re-plan from there.
    let node = found ? goal : bestNode;
    if (node === start) return null;
    const path = [];
    while (node !== -1 && node !== start) {
      const x = node % N;
      const z = (node - x) / N;
      path.push([x - WORLD_HALF + 0.5, z - WORLD_HALF + 0.5]);
      node = parent[node];
    }
    path.reverse();
    if (found) path.push([tx, tz]);
    return path;
  }

  return { walk, size: N, isWalkable, lineClear, findPath, nearestWalkable };
}

let cachedNav = null;
let cachedFor = null;
export function getNav(world) {
  if (cachedFor !== world) {
    cachedNav = buildNav(world);
    cachedFor = world;
  }
  return cachedNav;
}
