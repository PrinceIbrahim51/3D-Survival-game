// Pure combat maths: damage, armour and bullet spread.

import { ARMOR_ABSORB, AIR_SPREAD, damageFalloff } from '../shared/items.js';
import { WALK_SPEED } from '../shared/constants.js';

const PART_MULT = { body: 1, legs: 0.75 };

// Damage of one projectile before armour.
export function bulletDamage(def, dist, part) {
  const mult = part === 'head' ? def.head : PART_MULT[part] ?? 1;
  return def.dmg * damageFalloff(def, dist) * mult;
}

// Applies damage to { hp, armor }. Armour soaks part of bullet damage until it
// breaks; zone damage ignores armour. Returns the health actually lost.
export function applyDamage(target, amount, ignoreArmor = false) {
  if (!(amount > 0) || target.hp <= 0) return 0;
  let dmg = amount;
  if (!ignoreArmor && target.armor > 0) {
    const soak = Math.min(target.armor, dmg * ARMOR_ABSORB);
    target.armor -= soak;
    dmg -= soak;
    if (target.armor < 0.01) target.armor = 0;
  }
  const lost = Math.min(target.hp, dmg);
  target.hp -= lost;
  if (target.hp < 0.001) target.hp = 0;
  return lost;
}

// Cone half-angle (degrees) for the next shot.
export function spreadDegrees(def, { ads, bloom, speed, airborne, crouch }) {
  let s = ads ? def.spreadAds : def.spread;
  s += bloom;
  s += def.movePen * Math.min(1.5, speed / WALK_SPEED) * (ads ? 0.6 : 1);
  if (airborne) s += AIR_SPREAD;
  if (crouch) s *= 0.8;
  return s;
}

// Returns a unit vector inside a cone of `degrees` half-angle around dir.
export function spreadDirection(dir, degrees, rnd) {
  if (degrees <= 0) return { x: dir.x, y: dir.y, z: dir.z };
  // Orthonormal basis around dir.
  let ux;
  let uy;
  let uz;
  if (Math.abs(dir.y) < 0.99) {
    // u = normalize(cross(dir, up))
    ux = -dir.z;
    uy = 0;
    uz = dir.x;
  } else {
    ux = 1;
    uy = 0;
    uz = 0;
  }
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = dir.y * uz - dir.z * uy;
  const vy = dir.z * ux - dir.x * uz;
  const vz = dir.x * uy - dir.y * ux;
  const ang = rnd() * Math.PI * 2;
  const rad = Math.sqrt(rnd()) * Math.tan((degrees * Math.PI) / 180);
  const a = Math.cos(ang) * rad;
  const b = Math.sin(ang) * rad;
  let x = dir.x + ux * a + vx * b;
  let y = dir.y + uy * a + vy * b;
  let z = dir.z + uz * a + vz * b;
  const l = Math.sqrt(x * x + y * y + z * z);
  x /= l;
  y /= l;
  z /= l;
  return { x, y, z };
}

// Final ranking for players eliminated in the same tick: the one with more
// kills (then more damage dealt, then the lower id) places higher.
export function rankSimultaneous(players) {
  return players.slice().sort((a, b) => b.kills - a.kills || b.damage - a.damage || a.id - b.id);
}
