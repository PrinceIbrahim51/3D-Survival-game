// Authoritative inventory rules. Every function here is a pure transaction on
// an inventory object so it can be unit-tested without a running match.

import { ITEMS, AMMO, HEAL, WEAPONS, ARMOR, PACK_MULT, THROW, ATTACHMENTS, magSize } from '../shared/items.js';

export const SLOT_MELEE = 2;

export function newInventory() {
  return {
    weapons: [null, null], // each: { kind, mag, att } (att = attachment bit flags)
    active: SLOT_MELEE,
    ammo: { light: 0, rifle: 0, shell: 0, sniper: 0 },
    bandage: 0,
    medkit: 0,
    grenade: 0,
    smoke: 0,
    armor: 0, // remaining armour points
    armorLvl: 0,
    pack: 0, // backpack level
  };
}

export function ammoCap(inv, type) {
  return Math.round(AMMO[type].cap * PACK_MULT[inv.pack]);
}

export function healCap(inv, kind) {
  return Math.round(HEAL[kind].cap * PACK_MULT[inv.pack]);
}

export function throwCap(inv, kind) {
  return Math.round(THROW[kind].cap * PACK_MULT[inv.pack]);
}

export function activeWeapon(inv) {
  return inv.active === SLOT_MELEE ? null : inv.weapons[inv.active];
}

// Tries to move a ground item { kind, n } into the inventory.
// auto = true for walk-over pickups, which never replace equipped gear with
// something the player did not ask for.
// Returns { taken, left, drops } where `taken` says whether anything changed,
// `left` is the amount that stays on the ground (0 removes the item) and
// `drops` lists items the player put down in exchange.
export function pickup(inv, item, auto = false) {
  const info = ITEMS[item.kind];
  const none = { taken: false, left: item.n, drops: [] };
  if (!info || !(item.n > 0)) return none;

  switch (info.type) {
    case 'weapon': {
      const empty = inv.weapons.indexOf(null);
      if (empty !== -1) {
        // Walking over a duplicate of a weapon you already carry does nothing.
        if (auto && inv.weapons.some((w) => w && w.kind === item.kind)) return none;
        inv.weapons[empty] = makeWeapon(item);
        if (inv.active === SLOT_MELEE) inv.active = empty;
        return { taken: true, left: 0, drops: [] };
      }
      if (auto) return none;
      const slot = inv.active === SLOT_MELEE ? 0 : inv.active;
      const old = inv.weapons[slot];
      inv.weapons[slot] = makeWeapon(item);
      inv.active = slot;
      return { taken: true, left: 0, drops: [{ kind: old.kind, n: old.mag, a: old.att }] };
    }
    case 'throw': {
      const room = throwCap(inv, info.throw) - inv[info.throw];
      const take = Math.min(room, item.n);
      if (take <= 0) return none;
      inv[info.throw] += take;
      return { taken: true, left: item.n - take, drops: [] };
    }
    case 'att': {
      // Fits the weapon in hand first, then the other one.
      const def = ATTACHMENTS[item.kind];
      for (const slot of [inv.active, 0, 1]) {
        const w = slot < 2 ? inv.weapons[slot] : null;
        if (w && def.fits.includes(w.kind) && !(w.att & def.bit)) {
          w.att |= def.bit;
          return { taken: true, left: 0, drops: [] };
        }
      }
      return none;
    }
    case 'ammo': {
      const room = ammoCap(inv, info.ammo) - inv.ammo[info.ammo];
      const take = Math.min(room, item.n);
      if (take <= 0) return none;
      inv.ammo[info.ammo] += take;
      return { taken: true, left: item.n - take, drops: [] };
    }
    case 'heal': {
      const room = healCap(inv, info.heal) - inv[info.heal];
      const take = Math.min(room, item.n);
      if (take <= 0) return none;
      inv[info.heal] += take;
      return { taken: true, left: item.n - take, drops: [] };
    }
    case 'armor': {
      if (item.n <= inv.armor) return none;
      const drops = inv.armor > 0 ? [{ kind: 'armor' + inv.armorLvl, n: inv.armor }] : [];
      inv.armor = Math.min(item.n, ARMOR[info.level].points);
      inv.armorLvl = info.level;
      return { taken: true, left: 0, drops };
    }
    case 'pack': {
      if (info.level <= inv.pack) return none;
      inv.pack = info.level;
      return { taken: true, left: 0, drops: [] };
    }
    default:
      return none;
  }
}

// A weapon as carried, from a ground item { kind, n: rounds, a: attachments }.
function makeWeapon(item) {
  const att = item.a | 0;
  return { kind: item.kind, mag: Math.min(item.n, magSize(item.kind, att)), att };
}

// Removes the weapon in hand and returns it as a ground item (or null).
export function dropActive(inv) {
  const w = activeWeapon(inv);
  if (!w) return null;
  inv.weapons[inv.active] = null;
  const other = inv.weapons.findIndex((x) => x !== null);
  inv.active = other === -1 ? SLOT_MELEE : other;
  return { kind: w.kind, n: w.mag, a: w.att };
}

export function setActive(inv, slot) {
  if (slot !== 0 && slot !== 1 && slot !== SLOT_MELEE) return false;
  if (slot !== SLOT_MELEE && !inv.weapons[slot]) return false;
  if (inv.active === slot) return false;
  inv.active = slot;
  return true;
}

// Moves rounds from the reserve into the magazine of the active weapon.
export function reload(inv) {
  const w = activeWeapon(inv);
  if (!w) return 0;
  const def = WEAPONS[w.kind];
  const n = Math.min(magSize(w.kind, w.att) - w.mag, inv.ammo[def.ammo]);
  if (n <= 0) return 0;
  w.mag += n;
  inv.ammo[def.ammo] -= n;
  return n;
}

export function canReload(inv) {
  const w = activeWeapon(inv);
  if (!w) return false;
  const def = WEAPONS[w.kind];
  return w.mag < magSize(w.kind, w.att) && inv.ammo[def.ammo] > 0;
}

// Everything a player carries, as ground items, for dropping on elimination.
export function allItems(inv) {
  const out = [];
  for (const w of inv.weapons) if (w) out.push({ kind: w.kind, n: w.mag, a: w.att });
  for (const type of Object.keys(inv.ammo)) {
    if (inv.ammo[type] > 0) out.push({ kind: 'a_' + type, n: inv.ammo[type] });
  }
  if (inv.bandage > 0) out.push({ kind: 'bandage', n: inv.bandage });
  if (inv.medkit > 0) out.push({ kind: 'medkit', n: inv.medkit });
  if (inv.grenade > 0) out.push({ kind: 'grenade', n: inv.grenade });
  if (inv.smoke > 0) out.push({ kind: 'smoke', n: inv.smoke });
  if (inv.armor > 0) out.push({ kind: 'armor' + inv.armorLvl, n: Math.ceil(inv.armor) });
  if (inv.pack > 0) out.push({ kind: 'pack' + inv.pack, n: 1 });
  return out;
}
