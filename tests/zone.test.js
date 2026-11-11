import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZONE_PHASES, ZONE_START_RADIUS, createZone, startZone, updateZone, zoneCircleAt, insideCircle, pickNextCircle,
} from '../shared/zone.js';
import { mulberry32 } from '../shared/rng.js';
import { getWorld } from '../shared/world.js';

test('every next circle lies completely inside the current one', () => {
  const rnd = mulberry32(42);
  for (let i = 0; i < 300; i++) {
    const cur = { x: rnd() * 100 - 50, z: rnd() * 100 - 50, r: 20 + rnd() * 150 };
    const next = pickNextCircle(cur, 0.3 + rnd() * 0.5, rnd);
    const d = Math.hypot(next.x - cur.x, next.z - cur.z);
    assert.ok(d + next.r <= cur.r + 1e-9);
  }
});

test('circle centres can be restricted to reachable terrain', () => {
  const world = getWorld();
  const rnd = mulberry32(7);
  for (let i = 0; i < 50; i++) {
    const c = pickNextCircle({ x: 0, z: 0, r: ZONE_START_RADIUS }, 0.55, rnd, world.isLand);
    assert.ok(world.isLand(c.x, c.z), 'centre is on land');
  }
});

test('the zone waits, shrinks, and finally closes', () => {
  const rnd = mulberry32(3);
  const zone = createZone();
  startZone(zone, 0, rnd);
  assert.equal(zone.mode, 'wait');
  let t = 0;
  let lastR = ZONE_START_RADIUS;
  const seen = [];
  for (let guard = 0; guard < 100 && zone.mode !== 'closed'; guard++) {
    t = zone.t1;
    assert.equal(updateZone(zone, t - 1, rnd), false, 'nothing changes before the deadline');
    assert.equal(updateZone(zone, t, rnd), true);
    seen.push(zone.mode);
    const c = zoneCircleAt(zone, t);
    assert.ok(c.r <= lastR + 1e-9, 'radius never grows');
    lastR = c.r;
  }
  assert.equal(zone.mode, 'closed');
  assert.equal(zoneCircleAt(zone, t + 1000).r, 0);
  assert.equal(seen.filter((m) => m === 'shrink').length, ZONE_PHASES.length);
  const total = ZONE_PHASES.reduce((s, p) => s + p.wait + p.shrink, 0) * 1000;
  assert.equal(t, total);
});

test('the circle interpolates smoothly while shrinking', () => {
  const rnd = mulberry32(9);
  const zone = createZone();
  startZone(zone, 0, rnd);
  updateZone(zone, zone.t1, rnd);
  assert.equal(zone.mode, 'shrink');
  const a = zoneCircleAt(zone, zone.t0);
  const m = zoneCircleAt(zone, (zone.t0 + zone.t1) / 2);
  const b = zoneCircleAt(zone, zone.t1);
  assert.equal(a.r, zone.from.r);
  assert.equal(b.r, zone.to.r);
  assert.ok(Math.abs(m.r - (a.r + b.r) / 2) < 1e-9);
  assert.equal(zoneCircleAt(zone, zone.t1 + 5000).r, zone.to.r, 'clamped after the end');
});

test('damage per second rises with each phase', () => {
  for (let i = 1; i < ZONE_PHASES.length; i++) assert.ok(ZONE_PHASES[i].dps > ZONE_PHASES[i - 1].dps);
});

test('time scale shortens every phase (used for fast test matches)', () => {
  const zone = createZone(0.1);
  startZone(zone, 0, mulberry32(1));
  assert.equal(zone.t1, ZONE_PHASES[0].wait * 100);
});

test('insideCircle includes the edge', () => {
  const c = { x: 10, z: -5, r: 20 };
  assert.ok(insideCircle(c, 30, -5));
  assert.ok(!insideCircle(c, 30.01, -5));
});
