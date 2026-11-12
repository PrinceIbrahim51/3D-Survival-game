import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorld, FIELDS } from '../shared/world.js';
import { stepPlayer, makeMoveState, raycastWorld, rayPlayer, floorAt } from '../shared/physics.js';
import {
  BTN, INPUT_DT, WALK_SPEED, SPRINT_SPEED, CROUCH_SPEED, JUMP_SPEED, GRAVITY, PLAYER_RADIUS, WORLD_HALF,
  WORLD_MARGIN, CHUTE_FALL,
} from '../shared/constants.js';

const world = getWorld();
// The paddy fields are flat and empty: a clean place for movement tests.
const FX = FIELDS.x1 - 8;
const FZ = (FIELDS.z0 + FIELDS.z1) / 2 + 6;

function grounded(x = FX, z = FZ) {
  const s = makeMoveState(x, world.heightAt(x, z), z);
  s.ground = true;
  return s;
}
function run(s, inp, seconds) {
  const n = Math.round(seconds / INPUT_DT);
  for (let i = 0; i < n; i++) stepPlayer(world, s, inp, INPUT_DT);
  return s;
}
const idle = { mx: 0, mz: 0, yaw: 0, b: 0 };

test('a falling player lands on the terrain and stays there', () => {
  const s = makeMoveState(FX, 30, FZ);
  run(s, idle, 4);
  assert.equal(s.ground, true);
  assert.ok(Math.abs(s.y - world.heightAt(FX, FZ)) < 1e-6);
  assert.equal(s.vy, 0);
});

test('walk, sprint and crouch reach their configured speeds', () => {
  for (const [b, speed] of [[0, WALK_SPEED], [BTN.SPRINT, SPRINT_SPEED], [BTN.CROUCH, CROUCH_SPEED]]) {
    const s = grounded();
    run(s, { mx: 0, mz: 1, yaw: 0, b }, 0.5);
    const z0 = s.z;
    run(s, { mx: 0, mz: 1, yaw: 0, b }, 1);
    // yaw 0 faces -Z.
    const dist = z0 - s.z;
    assert.ok(Math.abs(dist - speed) < 0.05, `moved ${dist} at speed ${speed}`);
  }
});

test('diagonal input is not faster than straight input', () => {
  const s = grounded();
  run(s, { mx: 1, mz: 1, yaw: 0, b: 0 }, 1);
  assert.ok(Math.hypot(s.vx, s.vz) <= WALK_SPEED + 1e-6);
});

test('yaw rotates the movement direction', () => {
  const s = grounded();
  const x0 = s.x;
  run(s, { mx: 0, mz: 1, yaw: Math.PI / 2, b: 0 }, 0.5); // facing -X
  assert.ok(s.x < x0 - 1.5);
});

test('jump height follows v^2 / 2g and the player comes back down', () => {
  const s = grounded();
  const y0 = s.y;
  let peak = 0;
  stepPlayer(world, s, { ...idle, b: BTN.JUMP }, INPUT_DT);
  for (let i = 0; i < 120; i++) {
    stepPlayer(world, s, idle, INPUT_DT);
    peak = Math.max(peak, s.y - y0);
  }
  const expected = (JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY);
  assert.ok(Math.abs(peak - expected) < 0.15, `peak ${peak} vs ${expected}`);
  assert.equal(s.ground, true);
});

test('walls stop the player and never let them through', () => {
  const wall = world.boxes.find((b) => b.k === 'compound' && b.x1 - b.x0 > 10 && b.z1 - b.z0 < 1);
  assert.ok(wall, 'found a long wall along X');
  const x = (wall.x0 + wall.x1) / 2 + 8;
  const s = makeMoveState(x, world.heightAt(x, wall.z1 + 3), wall.z1 + 3);
  s.ground = true;
  run(s, { mx: 0, mz: 1, yaw: 0, b: BTN.SPRINT }, 3); // run north into the wall
  assert.ok(s.z >= wall.z1 + PLAYER_RADIUS - 1e-6, `stopped at z=${s.z}, wall ends ${wall.z1}`);
  assert.ok(s.z < wall.z1 + PLAYER_RADIUS + 0.05);
});

test('players can climb stairs but not walls of the same height', () => {
  const steps = world.boxes.filter((b) => b.k === 'stairs');
  assert.ok(steps.length > 10);
  // First staircase: steps are generated in climbing order.
  const first = steps[0];
  const run1 = [first];
  for (let i = 1; i < steps.length && steps[i].z0 === first.z0 && steps[i].z1 === first.z1; i++) run1.push(steps[i]);
  const top = run1[run1.length - 1];
  const dirX = Math.sign((top.x0 + top.x1) / 2 - (first.x0 + first.x1) / 2);
  const z = (first.z0 + first.z1) / 2;
  const startX = (first.x0 + first.x1) / 2 - dirX * 1.2;
  const s = makeMoveState(startX, world.heightAt(startX, z), z);
  s.ground = true;
  const ground = s.y;
  const inp = { mx: 0, mz: 1, yaw: dirX > 0 ? -Math.PI / 2 : Math.PI / 2, b: 0 };
  let peak = 0;
  for (let i = 0; i < 90; i++) {
    stepPlayer(world, s, inp, INPUT_DT);
    peak = Math.max(peak, s.y - ground);
  }
  assert.ok(Math.abs(peak - (top.y1 - ground)) < 0.01, `climbed ${peak} m of ${top.y1 - ground}`);
  // The same height as a sheer wall cannot be walked up.
  const crate = world.boxes.find((b) => b.k === 'crate' && b.y1 - world.heightAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) > 0.9);
  const cz = (crate.z0 + crate.z1) / 2;
  const c = makeMoveState(crate.x0 - 1.5, world.heightAt(crate.x0 - 1.5, cz), cz);
  c.ground = true;
  run(c, { mx: 0, mz: 1, yaw: -Math.PI / 2, b: 0 }, 1.5);
  assert.ok(c.y < crate.y1 - 0.5, 'did not walk up the crate');
  assert.ok(c.x <= crate.x0 - PLAYER_RADIUS + 1e-6, 'and was stopped by its side');
});

test('the map edge is a hard boundary', () => {
  const s = makeMoveState(WORLD_HALF - 6, -1.3, 0);
  run(s, { mx: 1, mz: 0, yaw: 0, b: 0 }, 6);
  assert.ok(s.x <= WORLD_HALF - WORLD_MARGIN + 1e-9);
});

test('parachute limits fall speed and closes on landing', () => {
  const s = makeMoveState(FX, world.heightAt(FX, FZ) + 40, FZ);
  s.chute = true;
  run(s, idle, 1);
  assert.ok(Math.abs(s.vy + CHUTE_FALL) < 1e-6);
  assert.equal(s.chute, true);
  run(s, idle, 6);
  assert.equal(s.chute, false);
  assert.equal(s.ground, true);
});

test('movement is deterministic for identical inputs', () => {
  const a = grounded();
  const b = grounded();
  for (let i = 0; i < 400; i++) {
    const inp = { mx: Math.sin(i * 0.1), mz: Math.cos(i * 0.07), yaw: i * 0.02, b: i % 90 === 0 ? BTN.JUMP : i % 50 < 20 ? BTN.SPRINT : 0 };
    stepPlayer(world, a, inp, INPUT_DT);
    stepPlayer(world, b, inp, INPUT_DT);
  }
  assert.deepEqual(a, b);
});

test('rays hit walls, terrain, and nothing in open sky', () => {
  const wall = world.boxes.find((b) => b.k === 'compound' && b.x1 - b.x0 > 10 && b.z1 - b.z0 < 1);
  const x = (wall.x0 + wall.x1) / 2 + 8;
  const y = wall.y0 + 1.6;
  const t = raycastWorld(world, x, y, wall.z1 + 5, 0, 0, -1, 100);
  assert.ok(Math.abs(t - 5) < 1e-6, `wall at ${t}`);
  // Straight down from above the fields.
  const g = world.heightAt(FX, FZ);
  assert.ok(Math.abs(raycastWorld(world, FX, g + 10, FZ, 0, -1, 0, 100) - 10) < 0.02);
  // Straight up.
  assert.equal(raycastWorld(world, FX, g + 2, FZ, 0, 1, 0, 100), 100);
});

test('player hit zones: head, body, legs and misses', () => {
  const hit = (oy, dy = 0) => {
    const l = Math.hypot(1, dy);
    return rayPlayer(-10, oy, 0, 1 / l, dy / l, 0, 50, 0, 0, 0, false);
  };
  assert.equal(hit(1.62).part, 'head');
  assert.equal(hit(1.1).part, 'body');
  assert.equal(hit(0.3).part, 'legs');
  assert.equal(hit(2.2), null, 'over the head');
  assert.equal(rayPlayer(-10, 1.1, 2, 1, 0, 0, 50, 0, 0, 0, false), null, 'wide');
  assert.equal(rayPlayer(-10, 1.1, 0, -1, 0, 0, 50, 0, 0, 0, false), null, 'facing away');
  assert.equal(rayPlayer(-10, 1.1, 0, 1, 0, 0, 5, 0, 0, 0, false), null, 'out of range');
  // Crouching lowers the head.
  assert.equal(rayPlayer(-10, 1.62, 0, 1, 0, 0, 50, 0, 0, 0, true), null);
  assert.equal(rayPlayer(-10, 1.08, 0, 1, 0, 0, 50, 0, 0, 0, true).part, 'head');
});

test('floorAt finds roofs only when the player is above them', () => {
  const roof = world.boxes.find((b) => b.k === 'roof' && b.x1 - b.x0 > 5 && b.z1 - b.z0 > 5);
  const x = (roof.x0 + roof.x1) / 2;
  const z = (roof.z0 + roof.z1) / 2;
  assert.equal(floorAt(world, x, z, roof.y1 + 1), roof.y1);
  assert.ok(floorAt(world, x, z, roof.y0 - 2.5) < roof.y0);
});

test('holding jump vaults onto obstacles within reach, but not over tall walls', () => {
  // A stacked pair of crates is too high for a plain jump.
  const lower = world.boxes.find((b) => b.k === 'crate' && world.boxes.some((u) => u.k === 'crate' && u !== b && Math.abs(u.y0 - b.y1) < 1e-6 && u.x0 >= b.x0 && u.x1 <= b.x1));
  assert.ok(lower, 'found stacked crates');
  const upper = world.boxes.find((u) => u.k === 'crate' && u !== lower && Math.abs(u.y0 - lower.y1) < 1e-6 && u.x0 >= lower.x0 && u.x1 <= lower.x1);
  const cz = (upper.z0 + upper.z1) / 2;
  const startX = lower.x0 - 1.2;
  const ground = world.heightAt(startX, cz);
  assert.ok(upper.y1 - ground > 1.6 && upper.y1 - ground < 2.3, `stack height ${upper.y1 - ground}`);

  const walker = makeMoveState(startX, ground, cz);
  walker.ground = true;
  run(walker, { mx: 0, mz: 1, yaw: -Math.PI / 2, b: 0 }, 2);
  assert.ok(walker.y < lower.y1 - 0.5, 'walking alone does not get up there');

  const vaulter = makeMoveState(startX, ground, cz);
  vaulter.ground = true;
  let top = -Infinity;
  for (let i = 0; i < 150; i++) {
    stepPlayer(world, vaulter, { mx: 0, mz: 1, yaw: -Math.PI / 2, b: BTN.JUMP }, INPUT_DT);
    top = Math.max(top, vaulter.y);
  }
  assert.ok(top >= upper.y1 - 1e-6, `vaulted to ${top - ground} m`);

  // The outpost wall (2.7 m) stays out of reach.
  const wall = world.boxes.find((b) => b.k === 'compound' && b.x1 - b.x0 > 10 && b.z1 - b.z0 < 1);
  const wx = (wall.x0 + wall.x1) / 2 + 8;
  const climber = makeMoveState(wx, world.heightAt(wx, wall.z1 + 2), wall.z1 + 2);
  climber.ground = true;
  for (let i = 0; i < 240; i++) stepPlayer(world, climber, { mx: 0, mz: 1, yaw: 0, b: BTN.JUMP | BTN.SPRINT }, INPUT_DT);
  assert.ok(climber.z > wall.z1, 'still on the near side of the wall');
});
