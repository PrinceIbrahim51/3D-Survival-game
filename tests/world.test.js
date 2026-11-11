import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, getWorld, POIS, BRIDGE } from '../shared/world.js';
import { getNav } from '../server/nav.js';
import { WORLD_HALF } from '../shared/constants.js';

function checksum(world) {
  let h = 0;
  for (let i = 0; i < world.heights.length; i += 7) h = (Math.imul(h, 31) + Math.round(world.heights[i] * 1000)) | 0;
  for (const b of world.boxes) h = (Math.imul(h, 31) + Math.round((b.x0 + b.y1 * 3 + b.z1 * 7) * 1000)) | 0;
  for (const s of world.lootSpawns) h = (Math.imul(h, 31) + Math.round((s.x + s.z * 5) * 1000)) | 0;
  return h;
}

test('world generation is deterministic', () => {
  const a = generateWorld(123);
  const b = generateWorld(123);
  assert.equal(a.boxes.length, b.boxes.length);
  assert.equal(checksum(a), checksum(b));
  assert.notEqual(checksum(a), checksum(generateWorld(124)));
});

test('the map has the expected landmarks and enough loot', () => {
  const w = getWorld();
  assert.equal(w.pois.length, POIS.length);
  for (const p of w.pois) assert.ok(w.heightAt(p.x, p.z) > 1, `${p.name} is on dry land`);
  assert.ok(w.lootSpawns.length >= 120, `loot spawns: ${w.lootSpawns.length}`);
  assert.ok(w.boxes.some((b) => b.k === 'bridge'));
  assert.ok(w.decor.filter((d) => d.t === 'palm' || d.t === 'tree').length > 200);
});

test('the sea surrounds the island', () => {
  const w = getWorld();
  for (let v = -WORLD_HALF; v <= WORLD_HALF; v += 10) {
    assert.ok(w.heightAt(v, -WORLD_HALF) < 0 && w.heightAt(v, WORLD_HALF) < 0);
    assert.ok(w.heightAt(-WORLD_HALF, v) < 0 && w.heightAt(WORLD_HALF, v) < 0);
  }
});

test('loot never spawns under water or inside a solid box', () => {
  const w = getWorld();
  for (const s of w.lootSpawns) {
    assert.ok(s.y >= w.heightAt(s.x, s.z) - 0.05, 'not buried');
    assert.ok(s.y > 0.3, 'not in the sea');
    for (const b of w.boxes) {
      const inside = s.x > b.x0 && s.x < b.x1 && s.z > b.z0 && s.z < b.z1 && s.y + 0.3 > b.y0 && s.y + 0.3 < b.y1;
      assert.ok(!inside, `loot at ${s.x.toFixed(1)},${s.z.toFixed(1)} is inside a ${b.k}`);
    }
  }
});

test('ground-level loot is reachable on foot from the town centre', () => {
  const w = getWorld();
  const nav = getNav(w);
  const start = w.pois[0];
  let ground = 0;
  let reached = 0;
  for (const s of w.lootSpawns) {
    if (Math.abs(s.y - w.heightAt(s.x, s.z)) > 0.9) continue; // roof and tower loot
    ground++;
    const path = nav.findPath(start.x + 6, start.z + 6, s.x, s.z, 60000);
    if (!path) continue;
    const end = path[path.length - 1];
    if (Math.hypot(end[0] - s.x, end[1] - s.z) < 1.5) reached++;
  }
  assert.ok(reached / ground > 0.97, `reachable ${reached}/${ground}`);
});

test('the bridge connects both banks of the creek', () => {
  const w = getWorld();
  const nav = getNav(w);
  const x = (BRIDGE.x0 + BRIDGE.x1) / 2;
  const path = nav.findPath(x, BRIDGE.z0 - 6, x, BRIDGE.z1 + 6);
  assert.ok(path, 'a path exists');
  assert.ok(path.length < 70, 'and it goes straight over the bridge');
  assert.ok(w.heightAt(x, (BRIDGE.z0 + BRIDGE.z1) / 2) < 0, 'there is water under it');
});
