// Character movement, collision and ray casting against the static world.
// This file runs on the server (authoritative) and in the browser (prediction),
// so it must stay deterministic: same state + same input => same result.

import {
  BTN, PLAYER_RADIUS, PLAYER_HEIGHT, CROUCH_HEIGHT, STEP_HEIGHT, GRAVITY, JUMP_SPEED,
  WALK_SPEED, SPRINT_SPEED, CROUCH_SPEED, ADS_SPEED, SWIM_SPEED, GROUND_ACCEL, AIR_ACCEL,
  CHUTE_SPEED, CHUTE_ACCEL, CHUTE_FALL, SEA_LEVEL, SWIM_DEPTH, WORLD_HALF, WORLD_MARGIN,
  MANTLE_REACH, MANTLE_SPEED,
} from './constants.js';

export function makeMoveState(x = 0, y = 0, z = 0) {
  return { x, y, z, vx: 0, vy: 0, vz: 0, ground: false, crouch: false, chute: false };
}

export function copyMoveState(dst, src) {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
  dst.ground = src.ground; dst.crouch = src.crouch; dst.chute = src.chute;
  return dst;
}

const scratch = [];

function circleOverlapsBox(x, z, r, b) {
  const cx = x < b.x0 ? b.x0 : x > b.x1 ? b.x1 : x;
  const cz = z < b.z0 ? b.z0 : z > b.z1 ? b.z1 : z;
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

// Lowest walkable surface a player whose feet are at `y` can stand on at (x, z).
export function floorAt(world, x, z, y, radius = PLAYER_RADIUS * 0.6) {
  let floor = world.heightAt(x, z);
  const swim = SEA_LEVEL - SWIM_DEPTH;
  if (floor < swim) floor = swim;
  const boxes = world.queryBoxes(x - radius, z - radius, x + radius, z + radius, scratch);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.y1 > floor && b.y1 <= y + STEP_HEIGHT + 1e-6 && circleOverlapsBox(x, z, radius, b)) floor = b.y1;
  }
  return floor;
}

function headBlocked(world, s) {
  const boxes = world.queryBoxes(s.x - PLAYER_RADIUS, s.z - PLAYER_RADIUS, s.x + PLAYER_RADIUS, s.z + PLAYER_RADIUS, scratch);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.y0 < s.y + PLAYER_HEIGHT && b.y1 > s.y + CROUCH_HEIGHT && circleOverlapsBox(s.x, s.z, PLAYER_RADIUS * 0.9, b)) return true;
  }
  return false;
}

// True when the player is deep enough in water to be swimming.
export function isSwimming(world, s) {
  return s.y < SEA_LEVEL - 0.7 && world.heightAt(s.x, s.z) < SEA_LEVEL - 0.7;
}

// Advances one player by dt seconds using input { mx, mz, yaw, b }.
export function stepPlayer(world, s, inp, dt) {
  const b = inp.b;
  let mx = inp.mx;
  let mz = inp.mz;
  const ml = Math.sqrt(mx * mx + mz * mz);
  if (ml > 1) {
    mx /= ml;
    mz /= ml;
  }
  const sin = Math.sin(inp.yaw);
  const cos = Math.cos(inp.yaw);
  // right = (cos, -sin), forward = (-sin, -cos) in the XZ plane.
  const wx = cos * mx - sin * mz;
  const wz = -sin * mx - cos * mz;

  if ((b & BTN.CROUCH) !== 0 && !s.chute) s.crouch = true;
  else if (s.crouch && !headBlocked(world, s)) s.crouch = false;

  const swimming = isSwimming(world, s);
  let speed;
  if (s.chute) speed = CHUTE_SPEED;
  else if (swimming) speed = SWIM_SPEED;
  else if (s.crouch) speed = CROUCH_SPEED;
  else if (b & BTN.ADS) speed = ADS_SPEED;
  else if ((b & BTN.SPRINT) && mz > 0.3) speed = SPRINT_SPEED;
  else speed = WALK_SPEED;

  let accel = s.chute ? CHUTE_ACCEL : s.ground ? GROUND_ACCEL : AIR_ACCEL;
  if (!s.ground && !s.chute && ml < 0.01) accel = 0; // keep momentum in the air
  let dvx = wx * speed - s.vx;
  let dvz = wz * speed - s.vz;
  const dl = Math.sqrt(dvx * dvx + dvz * dvz);
  const maxDv = accel * dt;
  if (dl > maxDv && dl > 0) {
    dvx *= maxDv / dl;
    dvz *= maxDv / dl;
  }
  s.vx += dvx;
  s.vz += dvz;

  if (s.ground && (b & BTN.JUMP) && !s.crouch && !swimming) {
    s.vy = JUMP_SPEED;
    s.ground = false;
  }
  if (!s.ground) {
    s.vy -= GRAVITY * dt;
    if (s.chute && s.vy < -CHUTE_FALL) s.vy = -CHUTE_FALL;
    if (s.vy < -50) s.vy = -50;
  }

  // --- horizontal move, pushing out of anything that acts as a wall ---------
  let nx = s.x + s.vx * dt;
  let nz = s.z + s.vz * dt;
  const height = s.crouch ? CROUCH_HEIGHT : PLAYER_HEIGHT;
  const lo = s.y + STEP_HEIGHT;
  const hi = s.y + height;
  const R = PLAYER_RADIUS;
  const boxes = world.queryBoxes(nx - R - 0.5, nz - R - 0.5, nx + R + 0.5, nz + R + 0.5, scratch);
  let ledge = false; // pushing against something low enough to climb
  for (let iter = 0; iter < 3; iter++) {
    let pushed = false;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.y1 <= lo || bx.y0 >= hi) continue;
      const cx = nx < bx.x0 ? bx.x0 : nx > bx.x1 ? bx.x1 : nx;
      const cz = nz < bx.z0 ? bx.z0 : nz > bx.z1 ? bx.z1 : nz;
      const dx = nx - cx;
      const dz = nz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2);
        const push = (R - d) / d;
        nx += dx * push;
        nz += dz * push;
      } else {
        // Centre is inside the box: leave through the nearest face.
        const l = nx - bx.x0;
        const r = bx.x1 - nx;
        const n = nz - bx.z0;
        const f = bx.z1 - nz;
        const m = Math.min(l, r, n, f);
        if (m === l) nx = bx.x0 - R;
        else if (m === r) nx = bx.x1 + R;
        else if (m === n) nz = bx.z0 - R;
        else nz = bx.z1 + R;
      }
      pushed = true;
      if (bx.y1 - s.y <= MANTLE_REACH) ledge = true;
    }
    if (!pushed) break;
  }
  // Vaulting: holding jump while pressed against a ledge within reach keeps
  // pulling the player up until they can step onto it. Combined with a jump
  // this clears crates, rocks and low walls, but not building walls.
  if (ledge && (b & BTN.JUMP) && !s.chute && !s.crouch && !swimming && s.vy < MANTLE_SPEED) {
    s.vy = MANTLE_SPEED;
    s.ground = false;
  }
  const lim = WORLD_HALF - WORLD_MARGIN;
  if (nx < -lim) nx = -lim; else if (nx > lim) nx = lim;
  if (nz < -lim) nz = -lim; else if (nz > lim) nz = lim;

  // --- vertical move: ceilings, floors, stepping and ledges -------------------
  let ny = s.y + s.vy * dt;
  if (s.vy > 0) {
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.y0 >= hi - 1e-6 && bx.y0 < ny + height && circleOverlapsBox(nx, nz, R * 0.9, bx)) {
        ny = bx.y0 - height;
        s.vy = 0;
      }
    }
  }
  let floor = world.heightAt(nx, nz);
  if (floor < SEA_LEVEL - SWIM_DEPTH) floor = SEA_LEVEL - SWIM_DEPTH;
  const fr = R * 0.6;
  for (let i = 0; i < boxes.length; i++) {
    const bx = boxes[i];
    if (bx.y1 > floor && bx.y1 <= s.y + STEP_HEIGHT + 1e-6 && circleOverlapsBox(nx, nz, fr, bx)) floor = bx.y1;
  }
  if (ny <= floor) {
    ny = floor;
    s.vy = 0;
    s.ground = true;
    s.chute = false;
  } else if (s.ground && s.vy <= 0 && ny - floor <= STEP_HEIGHT + 0.05) {
    ny = floor; // stay glued to stairs and slopes when walking down
    s.vy = 0;
  } else {
    s.ground = false;
  }
  s.x = nx;
  s.y = ny;
  s.z = nz;
  return s;
}

// ------------------------------------------------------------------ ray casts

// Ray vs axis-aligned box. Returns the entry distance or Infinity.
function rayBox(b, ox, oy, oz, ix, iy, iz, tmax) {
  let t0 = 0;
  let t1 = tmax;
  let a = (b.x0 - ox) * ix;
  let c = (b.x1 - ox) * ix;
  if (a > c) { const t = a; a = c; c = t; }
  if (a > t0) t0 = a;
  if (c < t1) t1 = c;
  if (t0 > t1) return Infinity;
  a = (b.y0 - oy) * iy;
  c = (b.y1 - oy) * iy;
  if (a > c) { const t = a; a = c; c = t; }
  if (a > t0) t0 = a;
  if (c < t1) t1 = c;
  if (t0 > t1) return Infinity;
  a = (b.z0 - oz) * iz;
  c = (b.z1 - oz) * iz;
  if (a > c) { const t = a; a = c; c = t; }
  if (a > t0) t0 = a;
  if (c < t1) t1 = c;
  if (t0 > t1) return Infinity;
  return t0;
}

function rayBoxes(world, ox, oy, oz, dx, dy, dz, maxDist) {
  const ix = 1 / (dx === 0 ? 1e-12 : dx);
  const iy = 1 / (dy === 0 ? 1e-12 : dy);
  const iz = 1 / (dz === 0 ? 1e-12 : dz);
  const CS = world.cellSize;
  const N = world.cellCount;
  let cx = Math.floor((ox + WORLD_HALF) / CS);
  let cz = Math.floor((oz + WORLD_HALF) / CS);
  const stepX = dx > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const adx = Math.abs(dx);
  const adz = Math.abs(dz);
  const tDeltaX = adx > 1e-9 ? CS / adx : Infinity;
  const tDeltaZ = adz > 1e-9 ? CS / adz : Infinity;
  const bx = (cx + (dx > 0 ? 1 : 0)) * CS - WORLD_HALF;
  const bz = (cz + (dz > 0 ? 1 : 0)) * CS - WORLD_HALF;
  let tMaxX = adx > 1e-9 ? (bx - ox) / dx : Infinity;
  let tMaxZ = adz > 1e-9 ? (bz - oz) / dz : Infinity;
  let best = maxDist;
  for (let guard = 0; guard < 200; guard++) {
    if (cx >= 0 && cz >= 0 && cx < N && cz < N) {
      const cell = world.cells[cz * N + cx];
      for (let i = 0; i < cell.length; i++) {
        const t = rayBox(cell[i], ox, oy, oz, ix, iy, iz, best);
        if (t < best) best = t;
      }
    }
    const tExit = tMaxX < tMaxZ ? tMaxX : tMaxZ;
    if (best <= tExit || tExit > maxDist) break;
    if (tMaxX < tMaxZ) {
      cx += stepX;
      tMaxX += tDeltaX;
      if (cx < 0 || cx >= N) break;
    } else {
      cz += stepZ;
      tMaxZ += tDeltaZ;
      if (cz < 0 || cz >= N) break;
    }
  }
  return best;
}

function rayTerrain(world, ox, oy, oz, dx, dy, dz, maxDist) {
  const top = world.maxHeight + 0.5;
  if (oy > top && dy >= 0) return maxDist;
  let t = 0;
  // Skip ahead to where the ray drops below the highest terrain point.
  if (oy > top && dy < 0) t = (top - oy) / dy;
  let prev = t;
  while (t < maxDist) {
    const y = oy + dy * t;
    if (y > top && dy >= 0) return maxDist;
    const h = world.heightAt(ox + dx * t, oz + dz * t);
    if (y < h) {
      let a = prev;
      let b = t;
      for (let i = 0; i < 7; i++) {
        const m = (a + b) / 2;
        if (oy + dy * m < world.heightAt(ox + dx * m, oz + dz * m)) b = m;
        else a = m;
      }
      return a;
    }
    prev = t;
    // Larger steps when the ray is far above the ground.
    const gap = y - h;
    t += gap > 4 ? gap * 0.5 : 0.75;
  }
  return maxDist;
}

// Distance along a normalised ray to the first static obstacle (terrain or a
// box). Returns maxDist when nothing is hit.
export function raycastWorld(world, ox, oy, oz, dx, dy, dz, maxDist) {
  const t = rayBoxes(world, ox, oy, oz, dx, dy, dz, maxDist);
  return rayTerrain(world, ox, oy, oz, dx, dy, dz, t);
}

// Ray vs a standing player. Returns { t, part } with part 'head' | 'body' |
// 'legs', or null. (px, py, pz) is the player's feet position.
export function rayPlayer(ox, oy, oz, dx, dy, dz, maxDist, px, py, pz, crouch) {
  const bodyTop = crouch ? 0.95 : 1.45;
  const headY = py + (crouch ? 1.08 : 1.62);
  let best = Infinity;
  let part = null;

  // Head: sphere.
  const hr = 0.24;
  const lx = ox - px;
  const ly = oy - headY;
  const lz = oz - pz;
  const bq = lx * dx + ly * dy + lz * dz;
  const cq = lx * lx + ly * ly + lz * lz - hr * hr;
  const disc = bq * bq - cq;
  if (disc >= 0) {
    const t = -bq - Math.sqrt(disc);
    if (t >= 0 && t < maxDist) {
      best = t;
      part = 'head';
    }
  }

  // Body: vertical cylinder.
  const r = 0.42;
  const a = dx * dx + dz * dz;
  if (a > 1e-9) {
    const b2 = lx * dx + lz * dz;
    const c2 = lx * lx + lz * lz - r * r;
    const d2 = b2 * b2 - a * c2;
    if (d2 >= 0) {
      const sq = Math.sqrt(d2);
      let t = (-b2 - sq) / a;
      if (t < 0 && c2 < 0) t = 0; // muzzle already inside the cylinder
      if (t >= 0 && t < maxDist && t < best) {
        const y = oy + dy * t;
        if (y >= py && y <= py + bodyTop) {
          best = t;
          part = y < py + bodyTop * 0.42 ? 'legs' : 'body';
        } else {
          // Entered the infinite cylinder above/below: check the end caps.
          const capY = y > py + bodyTop ? py + bodyTop : py;
          if (Math.abs(dy) > 1e-6) {
            const tc = (capY - oy) / dy;
            const hx = ox + dx * tc - px;
            const hz = oz + dz * tc - pz;
            if (tc >= 0 && tc < maxDist && tc < best && hx * hx + hz * hz <= r * r) {
              best = tc;
              part = capY === py ? 'legs' : 'body';
            }
          }
        }
      }
    }
  }
  return part ? { t: best, part } : null;
}

// ---------------------------------------------------------------- throwables

const PROJ_GRAVITY = 20;
const PROJ_RADIUS = 0.12;
const projScratch = [];

function pointBlocked(world, x, y, z) {
  const r = PROJ_RADIUS;
  const boxes = world.queryBoxes(x - r, z - r, x + r, z + r, projScratch);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r && y > b.y0 - r && y < b.y1 + r) return true;
  }
  return false;
}

// Advances a thrown object { x, y, z, vx, vy, vz }: gravity, bouncing off the
// ground and off boxes. Deterministic, so clients can draw the same arc the
// server simulates from just the launch state.
export function stepProjectile(world, p, dt) {
  const sub = 3;
  const h = dt / sub;
  for (let i = 0; i < sub; i++) {
    p.vy -= PROJ_GRAVITY * h;
    const nx = p.x + p.vx * h;
    if (pointBlocked(world, nx, p.y, p.z)) p.vx = -p.vx * 0.4;
    else p.x = nx;
    const nz = p.z + p.vz * h;
    if (pointBlocked(world, p.x, p.y, nz)) p.vz = -p.vz * 0.4;
    else p.z = nz;
    let ny = p.y + p.vy * h;
    const floor = world.heightAt(p.x, p.z) + PROJ_RADIUS;
    const hitBox = pointBlocked(world, p.x, ny, p.z);
    if (ny < floor || hitBox) {
      ny = ny < floor ? floor : p.y;
      p.vy = Math.abs(p.vy) < 1.5 ? 0 : -p.vy * 0.35;
      p.vx *= 0.7;
      p.vz *= 0.7;
    }
    p.y = ny;
  }
  const lim = WORLD_HALF - 1;
  if (p.x < -lim) p.x = -lim; else if (p.x > lim) p.x = lim;
  if (p.z < -lim) p.z = -lim; else if (p.z > lim) p.z = lim;
  return p;
}

export function projectileBlocked(world, x, y, z) {
  return pointBlocked(world, x, y, z);
}
