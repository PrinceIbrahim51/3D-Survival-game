import test from 'node:test';
import assert from 'node:assert/strict';
import { bulletDamage, applyDamage, spreadDegrees, spreadDirection, rankSimultaneous } from '../server/combat.js';
import { WEAPONS, ARMOR_ABSORB, damageFalloff } from '../shared/items.js';
import { mulberry32 } from '../shared/rng.js';

test('headshots hurt more and leg shots hurt less', () => {
  const ar = WEAPONS.ar;
  const body = bulletDamage(ar, 10, 'body');
  assert.equal(body, ar.dmg);
  assert.equal(bulletDamage(ar, 10, 'head'), ar.dmg * ar.head);
  assert.ok(bulletDamage(ar, 10, 'legs') < body);
});

test('damage falls off with distance down to the minimum multiplier', () => {
  const smg = WEAPONS.smg;
  const [a, b, min] = smg.falloff;
  assert.equal(damageFalloff(smg, a - 1), 1);
  assert.equal(damageFalloff(smg, b + 50), min);
  const mid = damageFalloff(smg, (a + b) / 2);
  assert.ok(mid < 1 && mid > min);
});

test('armour soaks part of bullet damage until it breaks', () => {
  const t = { hp: 100, armor: 50 };
  const lost = applyDamage(t, 40);
  assert.equal(lost, 40 * (1 - ARMOR_ABSORB));
  assert.equal(t.armor, 50 - 40 * ARMOR_ABSORB);
  const t2 = { hp: 100, armor: 5 };
  applyDamage(t2, 40);
  assert.equal(t2.armor, 0);
  assert.equal(t2.hp, 65);
});

test('zone damage ignores armour, and health never goes below zero', () => {
  const t = { hp: 10, armor: 100 };
  assert.equal(applyDamage(t, 4, true), 4);
  assert.equal(t.armor, 100);
  assert.equal(applyDamage(t, 500, true), 6);
  assert.equal(t.hp, 0);
  assert.equal(applyDamage(t, 10), 0, 'no damage to the dead');
});

test('negative or NaN damage is ignored', () => {
  const t = { hp: 50, armor: 0 };
  assert.equal(applyDamage(t, -20), 0);
  assert.equal(applyDamage(t, NaN), 0);
  assert.equal(t.hp, 50);
});

test('aiming down sights tightens spread; moving and jumping widen it', () => {
  const ar = WEAPONS.ar;
  const still = { ads: false, bloom: 0, speed: 0, airborne: false, crouch: false };
  const hip = spreadDegrees(ar, still);
  assert.ok(spreadDegrees(ar, { ...still, ads: true }) < hip);
  assert.ok(spreadDegrees(ar, { ...still, speed: 6 }) > hip);
  assert.ok(spreadDegrees(ar, { ...still, airborne: true }) > hip);
  assert.ok(spreadDegrees(ar, { ...still, crouch: true }) < hip);
});

test('spread directions are unit vectors inside the cone', () => {
  const rnd = mulberry32(5);
  const dir = { x: 0.6, y: 0.0, z: -0.8 };
  const deg = 3;
  for (let i = 0; i < 500; i++) {
    const d = spreadDirection(dir, deg, rnd);
    assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-9);
    const angle = (Math.acos(Math.min(1, d.x * dir.x + d.y * dir.y + d.z * dir.z)) * 180) / Math.PI;
    assert.ok(angle <= deg + 1e-6, `angle ${angle}`);
  }
  // Straight up must not break the basis construction.
  const up = spreadDirection({ x: 0, y: 1, z: 0 }, 2, rnd);
  assert.ok(Number.isFinite(up.x) && up.y > 0.99);
});

test('simultaneous eliminations rank by kills, then damage, then id', () => {
  const a = { id: 1, kills: 1, damage: 50 };
  const b = { id: 2, kills: 3, damage: 10 };
  const c = { id: 3, kills: 1, damage: 90 };
  assert.deepEqual(rankSimultaneous([a, b, c]).map((p) => p.id), [2, 3, 1]);
  assert.deepEqual(rankSimultaneous([{ id: 9, kills: 0, damage: 0 }, { id: 4, kills: 0, damage: 0 }]).map((p) => p.id), [4, 9]);
});
