import test from 'node:test';
import assert from 'node:assert/strict';
import * as Inv from '../server/inventory.js';
import { AMMO, HEAL, WEAPONS, ATT, THROW, magSize, adsZoom } from '../shared/items.js';

test('first weapon goes to an empty slot and is drawn', () => {
  const inv = Inv.newInventory();
  const res = Inv.pickup(inv, { kind: 'ar', n: 30 }, true);
  assert.equal(res.taken, true);
  assert.equal(res.left, 0);
  assert.deepEqual(inv.weapons[0], { kind: 'ar', mag: 30, att: 0 });
  assert.equal(inv.active, 0);
});

test('walk-over pickup never swaps or duplicates a weapon', () => {
  const inv = Inv.newInventory();
  Inv.pickup(inv, { kind: 'ar', n: 30 }, true);
  assert.equal(Inv.pickup(inv, { kind: 'ar', n: 30 }, true).taken, false, 'duplicate ignored');
  Inv.pickup(inv, { kind: 'smg', n: 30 }, true);
  assert.equal(Inv.pickup(inv, { kind: 'sniper', n: 5 }, true).taken, false, 'slots full');
  assert.deepEqual(inv.weapons.map((w) => w.kind), ['ar', 'smg']);
});

test('manual pickup with full slots swaps the weapon in hand and drops the old one', () => {
  const inv = Inv.newInventory();
  Inv.pickup(inv, { kind: 'ar', n: 12 });
  Inv.pickup(inv, { kind: 'smg', n: 30 });
  inv.active = 0;
  const res = Inv.pickup(inv, { kind: 'sniper', n: 5 }, false);
  assert.equal(res.taken, true);
  assert.deepEqual(res.drops, [{ kind: 'ar', n: 12, a: 0 }]);
  assert.equal(inv.weapons[0].kind, 'sniper');
});

test('weapon magazines cannot exceed the weapon capacity', () => {
  const inv = Inv.newInventory();
  Inv.pickup(inv, { kind: 'pistol', n: 9999 });
  assert.equal(inv.weapons[0].mag, WEAPONS.pistol.mag);
});

test('ammo stacks up to the cap and leaves the rest on the ground', () => {
  const inv = Inv.newInventory();
  inv.ammo.rifle = AMMO.rifle.cap - 10;
  const res = Inv.pickup(inv, { kind: 'a_rifle', n: 30 }, true);
  assert.equal(res.taken, true);
  assert.equal(res.left, 20);
  assert.equal(inv.ammo.rifle, AMMO.rifle.cap);
  assert.equal(Inv.pickup(inv, { kind: 'a_rifle', n: 20 }, true).taken, false);
});

test('a backpack raises carrying capacity', () => {
  const inv = Inv.newInventory();
  const base = Inv.ammoCap(inv, 'light');
  assert.equal(Inv.pickup(inv, { kind: 'pack2', n: 1 }, true).taken, true);
  assert.equal(Inv.ammoCap(inv, 'light'), base * 2);
  assert.equal(Inv.healCap(inv, 'bandage'), HEAL.bandage.cap * 2);
  assert.equal(Inv.pickup(inv, { kind: 'pack1', n: 1 }, true).taken, false, 'no downgrade');
});

test('armour is only replaced by something better', () => {
  const inv = Inv.newInventory();
  Inv.pickup(inv, { kind: 'armor2', n: 100 }, true);
  inv.armor = 40;
  assert.equal(Inv.pickup(inv, { kind: 'armor1', n: 30 }, true).taken, false);
  const res = Inv.pickup(inv, { kind: 'armor1', n: 50 }, true);
  assert.equal(res.taken, true);
  assert.deepEqual(res.drops, [{ kind: 'armor2', n: 40 }]);
  assert.equal(inv.armorLvl, 1);
});

test('healing items respect their stack limit', () => {
  const inv = Inv.newInventory();
  for (let i = 0; i < 10; i++) Inv.pickup(inv, { kind: 'medkit', n: 1 }, true);
  assert.equal(inv.medkit, HEAL.medkit.cap);
});

test('reload moves rounds from reserve to magazine and never creates ammo', () => {
  const inv = Inv.newInventory();
  Inv.pickup(inv, { kind: 'ar', n: 5 });
  inv.ammo.rifle = 10;
  assert.equal(Inv.reload(inv), 10);
  assert.equal(inv.weapons[0].mag, 15);
  assert.equal(inv.ammo.rifle, 0);
  assert.equal(Inv.reload(inv), 0);
  assert.equal(Inv.canReload(inv), false);
});

test('dropping the active weapon falls back to the other slot, then fists', () => {
  const inv = Inv.newInventory();
  Inv.pickup(inv, { kind: 'ar', n: 30 });
  Inv.pickup(inv, { kind: 'smg', n: 20 });
  assert.deepEqual(Inv.dropActive(inv), { kind: 'ar', n: 30, a: 0 });
  assert.equal(inv.active, 1);
  assert.deepEqual(Inv.dropActive(inv), { kind: 'smg', n: 20, a: 0 });
  assert.equal(inv.active, Inv.SLOT_MELEE);
  assert.equal(Inv.dropActive(inv), null);
});

test('setActive rejects empty or invalid slots', () => {
  const inv = Inv.newInventory();
  assert.equal(Inv.setActive(inv, 0), false);
  assert.equal(Inv.setActive(inv, 7), false);
  Inv.pickup(inv, { kind: 'ar', n: 30 });
  assert.equal(Inv.setActive(inv, Inv.SLOT_MELEE), true);
  assert.equal(Inv.setActive(inv, 0), true);
});

test('allItems lists everything carried, for the death drop', () => {
  const inv = Inv.newInventory();
  Inv.pickup(inv, { kind: 'ar', n: 30 });
  Inv.pickup(inv, { kind: 'a_rifle', n: 30 });
  Inv.pickup(inv, { kind: 'bandage', n: 2 });
  Inv.pickup(inv, { kind: 'armor1', n: 50 });
  const kinds = Inv.allItems(inv).map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['a_rifle', 'ar', 'armor1', 'bandage']);
});

test('unknown or empty items are rejected', () => {
  const inv = Inv.newInventory();
  assert.equal(Inv.pickup(inv, { kind: 'nuke', n: 1 }).taken, false);
  assert.equal(Inv.pickup(inv, { kind: 'a_rifle', n: 0 }).taken, false);
  assert.equal(Inv.pickup(inv, { kind: 'a_rifle', n: -5 }).taken, false);
});

test('attachments fit a compatible weapon, once, and travel with it', () => {
  const inv = Inv.newInventory();
  assert.equal(Inv.pickup(inv, { kind: 'att_scope', n: 1 }, true).taken, false, 'nothing to put it on');
  Inv.pickup(inv, { kind: 'sniper', n: 5 });
  assert.equal(Inv.pickup(inv, { kind: 'att_scope', n: 1 }, true).taken, false, 'a sniper has its own scope');
  Inv.pickup(inv, { kind: 'ar', n: 30 });
  assert.equal(Inv.pickup(inv, { kind: 'att_scope', n: 1 }, true).taken, true);
  assert.equal(inv.weapons[1].att, ATT.SCOPE);
  assert.equal(Inv.pickup(inv, { kind: 'att_scope', n: 1 }, true).taken, false, 'already fitted');
  assert.equal(adsZoom('ar', inv.weapons[1].att) > WEAPONS.ar.zoom, true);

  // An extended magazine holds more, and reloading fills it.
  assert.equal(Inv.pickup(inv, { kind: 'att_mag', n: 1 }, true).taken, true);
  assert.equal(inv.weapons[0].att, ATT.MAG, 'goes on the weapon in hand first');
  assert.equal(magSize('sniper', ATT.MAG), Math.round(WEAPONS.sniper.mag * 1.5));
  inv.ammo.sniper = 20;
  Inv.reload(inv);
  assert.equal(inv.weapons[0].mag, magSize('sniper', ATT.MAG));

  // Dropping and picking the weapon up again keeps what is on it.
  inv.active = 1;
  const dropped = Inv.dropActive(inv);
  assert.deepEqual(dropped, { kind: 'ar', n: 30, a: ATT.SCOPE });
  const other = Inv.newInventory();
  Inv.pickup(other, dropped);
  assert.equal(other.weapons[0].att, ATT.SCOPE);
  assert.ok(Inv.allItems(inv).some((i) => i.kind === 'sniper' && i.a === ATT.MAG));
});

test('grenades and smoke stack up to their limit and drop on death', () => {
  const inv = Inv.newInventory();
  for (let i = 0; i < 9; i++) Inv.pickup(inv, { kind: 'grenade', n: 1 }, true);
  assert.equal(inv.grenade, THROW.grenade.cap);
  const res = Inv.pickup(inv, { kind: 'smoke', n: 5 }, true);
  assert.equal(inv.smoke, THROW.smoke.cap);
  assert.equal(res.left, 5 - THROW.smoke.cap);
  const kinds = Inv.allItems(inv).map((i) => i.kind);
  assert.ok(kinds.includes('grenade') && kinds.includes('smoke'));
});
