// Drivable vehicles: data and the arcade driving model. Like the character
// physics this runs on the server (authoritative) and in the driver's browser
// (prediction), so it must be deterministic.

import { BTN, WORLD_HALF, WORLD_MARGIN, SEA_LEVEL } from './constants.js';

// seatPos: [forward, right, up] of each seat relative to the vehicle origin.
// A vehicle collides as two circles of `radius` placed `offset` ahead of and
// behind its centre.
export const VEHICLES = {
  auto: {
    name: 'Auto', seats: 3, maxSpeed: 15, reverse: 5, accel: 9, brake: 22, turn: 1.9,
    radius: 0.8, offset: 0.62, height: 1.75, hp: 350, cam: 6.2,
    seatPos: [[0.45, 0, 0.5], [-0.6, -0.32, 0.55], [-0.6, 0.32, 0.55]],
  },
  lorry: {
    name: 'Lorry', seats: 2, maxSpeed: 12.5, reverse: 4, accel: 5.5, brake: 16, turn: 1.15,
    radius: 1.3, offset: 1.85, height: 2.9, hp: 900, cam: 9.5,
    seatPos: [[2.3, -0.5, 1.25], [2.3, 0.5, 1.25]],
  },
};
export const VEHICLE_KINDS = Object.keys(VEHICLES);
export const ENTER_RADIUS = 3.6;

export function makeVehicleState(x, y, z, yaw) {
  return { x, y, z, yaw, speed: 0 };
}

export function copyVehicleState(dst, src) {
  dst.x = src.x; dst.y = src.y; dst.z = src.z; dst.yaw = src.yaw; dst.speed = src.speed;
  return dst;
}

const scratch = [];
const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));
const FLOOR_KINDS = { bridge: 1, pier: 1, floor: 1 };

// World position of a seat.
export function seatPosition(def, v, seat, out = {}) {
  const sp = def.seatPos[seat] || def.seatPos[0];
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  // right = (cos yaw, -sin yaw)
  out.x = v.x + fx * sp[0] + Math.cos(v.yaw) * sp[1];
  out.y = v.y + sp[2];
  out.z = v.z + fz * sp[0] - Math.sin(v.yaw) * sp[1];
  return out;
}

// The two collision circles of a vehicle, written into `out` (array of
// { x, z, r, y0, y1 }) starting at index i. Returns the next free index.
export function vehicleCircles(def, v, out, i = 0) {
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  for (const sign of [1, -1]) {
    const c = out[i] || (out[i] = {});
    c.x = v.x + fx * def.offset * sign;
    c.z = v.z + fz * def.offset * sign;
    c.r = def.radius;
    c.y0 = v.y - 0.5;
    c.y1 = v.y + def.height;
    i++;
  }
  return i;
}

// Advances a vehicle by dt using input { mx: steer, mz: throttle, b: buttons }
// (jump = handbrake). Returns the speed lost in a collision (0 if none).
export function stepVehicle(world, def, v, inp, dt) {
  let thr = inp.mz;
  let steer = inp.mx;
  if (thr > 1) thr = 1; else if (thr < -1) thr = -1;
  if (steer > 1) steer = 1; else if (steer < -1) steer = -1;
  const flooded = world.heightAt(v.x, v.z) < SEA_LEVEL - 0.85;
  const max = flooded ? 2.5 : def.maxSpeed;

  if (inp.b & BTN.JUMP) v.speed = approach(v.speed, 0, def.brake * 1.3 * dt);
  else if (thr > 0.05) {
    if (v.speed < 0) v.speed = approach(v.speed, 0, def.brake * dt);
    else v.speed = Math.min(max, v.speed + def.accel * thr * dt);
  } else if (thr < -0.05) {
    if (v.speed > 0.3) v.speed = approach(v.speed, 0, def.brake * dt);
    else v.speed = Math.max(-def.reverse, v.speed + def.accel * thr * dt);
  } else {
    v.speed = approach(v.speed, 0, 3.5 * dt); // rolling resistance
  }
  if (v.speed > max) v.speed = approach(v.speed, max, 14 * dt);

  // Steering needs motion; it flips when reversing, like a real vehicle.
  let grip = v.speed / 5;
  if (grip > 1) grip = 1; else if (grip < -1) grip = -1;
  v.yaw -= steer * def.turn * grip * dt;
  if (v.yaw > Math.PI) v.yaw -= Math.PI * 2; else if (v.yaw < -Math.PI) v.yaw += Math.PI * 2;

  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  let nx = v.x + fx * v.speed * dt;
  let nz = v.z + fz * v.speed * dt;
  const R = def.radius;
  const lo = v.y + 0.45;
  const hi = v.y + def.height;
  let hit = false;
  for (let k = 0; k < 2; k++) {
    const sign = k === 0 ? 1 : -1;
    let cx = nx + fx * def.offset * sign;
    let cz = nz + fz * def.offset * sign;
    const boxes = world.queryBoxes(cx - R - 0.5, cz - R - 0.5, cx + R + 0.5, cz + R + 0.5, scratch);
    for (let iter = 0; iter < 2; iter++) {
      let pushed = false;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.y1 <= lo || b.y0 >= hi) continue;
        if (FLOOR_KINDS[b.k] && b.y1 <= v.y + 0.8) continue; // something to drive on, not into
        const px = cx < b.x0 ? b.x0 : cx > b.x1 ? b.x1 : cx;
        const pz = cz < b.z0 ? b.z0 : cz > b.z1 ? b.z1 : cz;
        const dx = cx - px;
        const dz = cz - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= R * R) continue;
        let ox;
        let oz;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          ox = (dx / d) * (R - d);
          oz = (dz / d) * (R - d);
        } else {
          // Centre inside the box: back out the way we came.
          ox = -fx * Math.sign(v.speed || 1) * R;
          oz = -fz * Math.sign(v.speed || 1) * R;
        }
        cx += ox; cz += oz;
        nx += ox; nz += oz;
        pushed = true;
        hit = true;
      }
      if (!pushed) break;
    }
  }
  let lost = 0;
  if (hit) {
    lost = Math.abs(v.speed) * 0.55;
    v.speed *= 0.45;
  }
  const lim = WORLD_HALF - WORLD_MARGIN - 1;
  if (nx < -lim) nx = -lim; else if (nx > lim) nx = lim;
  if (nz < -lim) nz = -lim; else if (nz > lim) nz = lim;
  v.x = nx;
  v.z = nz;

  // Ride height: mean ground height under both axles, bridge decks and floors
  // count as ground, and the vehicle never sinks deeper than wading depth.
  const hf = world.heightAt(nx + fx * def.offset, nz + fz * def.offset);
  const hr = world.heightAt(nx - fx * def.offset, nz - fz * def.offset);
  let ty = (hf + hr) / 2;
  if (ty < SEA_LEVEL - 0.7) ty = SEA_LEVEL - 0.7;
  const under = world.queryBoxes(nx, nz, nx, nz, scratch);
  for (let i = 0; i < under.length; i++) {
    const b = under[i];
    if (FLOOR_KINDS[b.k] && b.y1 > ty && b.y1 <= v.y + 0.8 && nx >= b.x0 && nx <= b.x1 && nz >= b.z0 && nz <= b.z1) ty = b.y1;
  }
  v.y = ty;
  return lost;
}
