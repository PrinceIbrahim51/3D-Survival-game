import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorld, FIELDS } from '../shared/world.js';
import { VEHICLES, makeVehicleState, stepVehicle, seatPosition, vehicleCircles } from '../shared/vehicle.js';
import { stepPlayer, makeMoveState } from '../shared/physics.js';
import { BTN, INPUT_DT, PF, PLAYER_RADIUS } from '../shared/constants.js';
import { startMatch, hold, parkNear, input } from './helpers.js';

const world = getWorld();
const FX = (FIELDS.x0 + FIELDS.x1) / 2;
const FZ = FIELDS.z1 - 6;
const drive = (def, v, inp, seconds) => {
  let lost = 0;
  for (let i = 0; i < Math.round(seconds / INPUT_DT); i++) lost = Math.max(lost, stepVehicle(world, def, v, inp, INPUT_DT));
  return lost;
};

test('the map has vehicles to drive', () => {
  assert.ok(world.vehicleSpawns.length >= 10);
  assert.ok(world.vehicleSpawns.some((v) => v.type === 'auto') && world.vehicleSpawns.some((v) => v.type === 'lorry'));
  for (const sp of world.vehicleSpawns) assert.ok(world.heightAt(sp.x, sp.z) > 1, 'parked on dry land');
});

test('a vehicle accelerates to its top speed, brakes and reverses', () => {
  const def = VEHICLES.auto;
  const v = makeVehicleState(FX, world.heightAt(FX, FZ), FZ, 0); // facing -Z across the fields
  drive(def, v, { mx: 0, mz: 1, b: 0 }, 1.9);
  assert.equal(v.speed, def.maxSpeed);
  assert.ok(v.z < FZ - 10, 'moved forward');
  drive(def, v, { mx: 0, mz: 0, b: BTN.JUMP }, 1);
  assert.equal(v.speed, 0, 'handbrake stops it');
  drive(def, v, { mx: 0, mz: -1, b: 0 }, 1.5);
  assert.equal(v.speed, -def.reverse);
  drive(def, v, { mx: 0, mz: 0, b: 0 }, 3);
  assert.equal(v.speed, 0, 'rolls to a stop on its own');
});

test('steering turns the vehicle only while it moves', () => {
  const def = VEHICLES.auto;
  const v = makeVehicleState(FX, world.heightAt(FX, FZ), FZ, 0);
  drive(def, v, { mx: 1, mz: 0, b: 0 }, 1);
  assert.equal(v.yaw, 0, 'no turning on the spot');
  drive(def, v, { mx: 1, mz: 1, b: 0 }, 0.8);
  assert.ok(v.yaw < -0.3, 'steering right turns clockwise');
  assert.ok(v.x > FX + 0.3, 'and carries it to the right');
});

test('walls stop vehicles, and the crash is reported', () => {
  const def = VEHICLES.auto;
  const wall = world.boxes.find((b) => b.k === 'compound' && b.x1 - b.x0 > 10 && b.z1 - b.z0 < 1);
  const x = (wall.x0 + wall.x1) / 2 + 8;
  const v = makeVehicleState(x, world.heightAt(x, wall.z1 + 14), wall.z1 + 14, 0);
  const lost = drive(def, v, { mx: 0, mz: 1, b: 0 }, 3);
  assert.ok(lost > 3, `crash lost ${lost} m/s`);
  assert.ok(v.z - def.offset - def.radius >= wall.z1 - 0.05, 'the nose did not go through the wall');
});

test('driving is deterministic', () => {
  const def = VEHICLES.lorry;
  const a = makeVehicleState(FX, world.heightAt(FX, FZ), FZ, 0.4);
  const b = makeVehicleState(FX, world.heightAt(FX, FZ), FZ, 0.4);
  for (let i = 0; i < 500; i++) {
    const inp = { mx: Math.sin(i * 0.05), mz: i % 200 < 150 ? 1 : -1, b: i % 97 === 0 ? BTN.JUMP : 0 };
    stepVehicle(world, def, a, inp, INPUT_DT);
    stepVehicle(world, def, b, inp, INPUT_DT);
  }
  assert.deepEqual(a, b);
});

test('people on foot cannot walk through a vehicle', () => {
  const def = VEHICLES.auto;
  const v = makeVehicleState(FX, world.heightAt(FX, FZ), FZ - 6, Math.PI / 2);
  const circles = [];
  circles.length = vehicleCircles(def, v, circles, 0);
  const s = makeMoveState(FX, world.heightAt(FX, FZ), FZ);
  s.ground = true;
  for (let i = 0; i < 240; i++) stepPlayer(world, s, { mx: 0, mz: 1, yaw: 0, b: 0 }, INPUT_DT, circles);
  assert.ok(s.z > v.z + 0.9 && s.z < v.z + def.radius + PLAYER_RADIUS + 0.01, `stopped at z=${s.z}`);
  const free = makeMoveState(FX, world.heightAt(FX, FZ), FZ);
  free.ground = true;
  for (let i = 0; i < 240; i++) stepPlayer(world, free, { mx: 0, mz: 1, yaw: 0, b: 0 }, INPUT_DT);
  assert.ok(free.z < v.z - 5, 'without the vehicle the way is clear');
});

test('getting in, driving and getting out', () => {
  const { m, clients, players } = startMatch(2);
  const [a, b] = players;
  const v = parkNear(m, a, 'auto');
  m.onAction(clients[0], { a: 'use' });
  assert.equal(a.veh, v);
  assert.equal(a.seat, 0, 'first in drives');
  b.s.x = v.s.x + 1.5;
  b.s.z = v.s.z;
  m.onAction(clients[1], { a: 'use' });
  assert.equal(b.seat, 1, 'second in rides');
  const z0 = v.s.z;
  hold(m, clients[0], 2, { mz: 1 });
  assert.ok(v.s.z < z0 - 10, 'the driver moved the vehicle');
  const seat = seatPosition(v.def, v.s, 1);
  assert.ok(Math.abs(b.s.x - seat.x) < 1e-9 && Math.abs(b.s.z - seat.z) < 1e-9, 'the passenger came along');
  const snap = clients[0].snaps().pop();
  assert.ok(snap.v.some((x) => x[0] === v.id), 'moving vehicles are in snapshots');
  assert.equal(snap.mv.length, 5, 'the driver gets the exact vehicle state');
  assert.ok(snap.p.find((x) => x[0] === a.id)[6] & PF.VEHICLE);
  assert.deepEqual(clients[0].state().veh.slice(0, 2), [v.id, 0]);
  assert.ok(clients[1].events().some((e) => e[0] === 'vin' && e[1] === v.id && e[2] === b.id && e[3] === 1));

  hold(m, clients[0], 1.5, { b: BTN.JUMP });
  m.onAction(clients[0], { a: 'use' });
  assert.equal(a.veh, null);
  const d = Math.hypot(a.s.x - v.s.x, a.s.z - v.s.z);
  assert.ok(d > v.def.radius && d < 4, `stepped out beside it (${d.toFixed(2)} m)`);
  m.step();
  assert.equal(v.seats[0], null);
  assert.equal(v.seats[1], b, 'the passenger is still aboard');
  // Whoever gets in next takes the wheel.
  m.onAction(clients[0], { a: 'use' });
  assert.equal(a.seat, 0);
});

test('drivers cannot shoot, passengers can', () => {
  const { m, clients, players } = startMatch(2);
  const [a, b] = players;
  for (const p of players) {
    p.inv.weapons[0] = { kind: 'ar', mag: 30, att: 0 };
    p.inv.active = 0;
  }
  const v = parkNear(m, a, 'auto');
  m.onAction(clients[0], { a: 'use' });
  b.s.x = v.s.x + 1.5;
  m.onAction(clients[1], { a: 'use' });
  hold(m, clients[0], 0.5, { b: BTN.FIRE });
  assert.equal(a.inv.weapons[0].mag, 30);
  hold(m, clients[1], 0.5, { b: BTN.FIRE, yaw: Math.PI });
  assert.ok(b.inv.weapons[0].mag < 30);
});

test('vehicles take bullet damage and blow up, throwing everyone out', () => {
  const { m, clients, players } = startMatch(2);
  const [a, b] = players;
  const v = parkNear(m, b, 'auto');
  m.onAction(clients[1], { a: 'use' });
  // a stands 12 m south of the vehicle and shoots north at its body.
  a.s.x = v.s.x;
  a.s.z = v.s.z + 12;
  a.inv.weapons[0] = { kind: 'ar', mag: 30, att: 0 };
  a.inv.ammo.rifle = 150;
  a.inv.active = 0;
  const hp0 = v.hp;
  hold(m, clients[0], 1, { b: BTN.FIRE | BTN.ADS | BTN.CROUCH, pitch: -0.07, ap: -0.07 });
  assert.ok(v.hp < hp0 || b.hp < 100, 'shots land on the vehicle or its driver');
  assert.ok(clients[1].events().some((e) => e[0] === 'shot' && e.includes(3)) || b.hp < 100);
  m.damageVehicle(v, 5000, a);
  assert.equal(v.dead, true);
  assert.equal(b.veh, null, 'thrown out');
  assert.ok(b.hp < 100 || !b.alive, 'and hurt by the blast');
  m.step();
  assert.ok(clients[0].events().some((e) => e[0] === 'vd' && e[1] === v.id));
  m.onAction(clients[1], { a: 'use' });
  assert.equal(b.veh, null, 'a wreck cannot be driven');
});

test('running someone over hurts them and is credited to the driver', () => {
  const { m, clients, players } = startMatch(3);
  const [a, b] = players;
  const v = parkNear(m, a, 'auto');
  m.onAction(clients[0], { a: 'use' });
  b.s.x = v.s.x;
  b.s.z = v.s.z - 14; // standing in the road ahead
  hold(m, clients[0], 2.2, { mz: 1 });
  assert.ok(b.hp < 100, `hit at speed, hp ${b.hp}`);
  assert.ok(clients[0].events().some((e) => e[0] === 'hit' && e[1] === b.id));
  if (!b.alive) assert.equal(b.cause, 'vehicle');
});
