// Balance data for weapons and loot. Editing this table is all that is needed to
// retune combat; both the server and the client read it.

export const AMMO_TYPES = ['light', 'rifle', 'shell', 'sniper'];

export const AMMO = {
  light: { name: '9mm', cap: 150, pack: 30, color: 0xf2c14e },
  rifle: { name: '5.56', cap: 150, pack: 30, color: 0x4caf50 },
  shell: { name: '12 Gauge', cap: 30, pack: 8, color: 0xe2543e },
  sniper: { name: '7.62', cap: 25, pack: 6, color: 0x4a90e2 },
};

// spread values are in degrees; falloff is [startDist, endDist, minMultiplier].
export const WEAPONS = {
  pistol: {
    name: 'Minnal P9', ammo: 'light', dmg: 22, pellets: 1, rpm: 330, mag: 12, reload: 1.5,
    spread: 1.3, spreadAds: 0.45, bloom: 0.45, bloomMax: 2.6, movePen: 0.9,
    range: 150, falloff: [20, 60, 0.6], head: 1.8, recoil: 1.1, zoom: 1.2, scope: false,
  },
  smg: {
    name: 'Kathir SMG', ammo: 'light', dmg: 17, pellets: 1, rpm: 820, mag: 30, reload: 2.0,
    spread: 1.7, spreadAds: 0.8, bloom: 0.26, bloomMax: 3.0, movePen: 0.7,
    range: 150, falloff: [18, 50, 0.55], head: 1.6, recoil: 0.55, zoom: 1.25, scope: false,
  },
  ar: {
    name: 'Vel-7 Rifle', ammo: 'rifle', dmg: 25, pellets: 1, rpm: 600, mag: 30, reload: 2.3,
    spread: 1.2, spreadAds: 0.3, bloom: 0.28, bloomMax: 2.8, movePen: 1.3,
    range: 300, falloff: [45, 120, 0.7], head: 2.0, recoil: 0.8, zoom: 1.5, scope: false,
  },
  shotgun: {
    name: 'Idi-12 Shotgun', ammo: 'shell', dmg: 12, pellets: 8, rpm: 75, mag: 5, reload: 2.8,
    spread: 4.0, spreadAds: 3.2, bloom: 0, bloomMax: 0, movePen: 0.5,
    range: 60, falloff: [8, 30, 0.3], head: 1.3, recoil: 3.2, zoom: 1.2, scope: false,
  },
  sniper: {
    name: 'Garuda LR', ammo: 'sniper', dmg: 80, pellets: 1, rpm: 42, mag: 5, reload: 3.2,
    spread: 4.5, spreadAds: 0.04, bloom: 0, bloomMax: 0, movePen: 2.5,
    range: 400, falloff: [150, 400, 0.85], head: 2.5, recoil: 4.0, zoom: 4.5, scope: true,
  },
};
export const WEAPON_KINDS = Object.keys(WEAPONS);

export const MELEE = { name: 'Fists', dmg: 24, range: 2.3, interval: 0.5 };
export const SWAP_TIME = 0.35; // seconds before a newly drawn weapon can fire
export const BLOOM_DECAY = 6; // degrees of bloom recovered per second
export const AIR_SPREAD = 2.5; // extra degrees of spread while airborne

export const ARMOR = {
  1: { name: 'Light Vest', points: 50 },
  2: { name: 'Heavy Vest', points: 100 },
};
export const ARMOR_ABSORB = 0.5; // fraction of bullet damage soaked by armour

export const HEAL = {
  bandage: { name: 'Bandage', hp: 20, upTo: 75, time: 2.5, cap: 6, pack: 2 },
  medkit: { name: 'Med Kit', hp: 100, upTo: 100, time: 5.5, cap: 2, pack: 1 },
};

export const PACK_MULT = [1, 1.5, 2]; // carrying-capacity multiplier per backpack level
export const PACK_NAMES = ['No backpack', 'Small Backpack', 'Large Backpack'];

// Every lootable kind. `type` drives pickup rules.
export const ITEMS = {
  pistol: { type: 'weapon', name: WEAPONS.pistol.name },
  smg: { type: 'weapon', name: WEAPONS.smg.name },
  ar: { type: 'weapon', name: WEAPONS.ar.name },
  shotgun: { type: 'weapon', name: WEAPONS.shotgun.name },
  sniper: { type: 'weapon', name: WEAPONS.sniper.name },
  a_light: { type: 'ammo', ammo: 'light', name: '9mm Ammo' },
  a_rifle: { type: 'ammo', ammo: 'rifle', name: '5.56 Ammo' },
  a_shell: { type: 'ammo', ammo: 'shell', name: '12 Gauge Shells' },
  a_sniper: { type: 'ammo', ammo: 'sniper', name: '7.62 Ammo' },
  bandage: { type: 'heal', heal: 'bandage', name: 'Bandage' },
  medkit: { type: 'heal', heal: 'medkit', name: 'Med Kit' },
  armor1: { type: 'armor', level: 1, name: ARMOR[1].name },
  armor2: { type: 'armor', level: 2, name: ARMOR[2].name },
  pack1: { type: 'pack', level: 1, name: PACK_NAMES[1] },
  pack2: { type: 'pack', level: 2, name: PACK_NAMES[2] },
};

export function ammoItemKind(ammoType) {
  return 'a_' + ammoType;
}

// Loot table. Weights are relative; tier 2 spawns (outpost, harbour, towers)
// lean toward stronger gear.
export const LOOT_TABLE = {
  1: [
    ['pistol', 9], ['smg', 9], ['ar', 7], ['shotgun', 6], ['sniper', 2],
    ['a_light', 9], ['a_rifle', 8], ['a_shell', 5], ['a_sniper', 3],
    ['bandage', 14], ['medkit', 4], ['armor1', 9], ['armor2', 2], ['pack1', 6], ['pack2', 2],
  ],
  2: [
    ['pistol', 2], ['smg', 8], ['ar', 12], ['shotgun', 6], ['sniper', 6],
    ['a_light', 6], ['a_rifle', 9], ['a_shell', 4], ['a_sniper', 5],
    ['bandage', 9], ['medkit', 8], ['armor1', 5], ['armor2', 8], ['pack1', 3], ['pack2', 5],
  ],
};

export function rollLoot(tier, rnd) {
  const table = LOOT_TABLE[tier] || LOOT_TABLE[1];
  let total = 0;
  for (const row of table) total += row[1];
  let r = rnd() * total;
  for (const row of table) {
    r -= row[1];
    if (r < 0) return row[0];
  }
  return table[table.length - 1][0];
}

// Amount carried by a freshly spawned loot item of this kind.
export function defaultAmount(kind) {
  const it = ITEMS[kind];
  switch (it.type) {
    case 'weapon': return WEAPONS[kind].mag;
    case 'ammo': return AMMO[it.ammo].pack;
    case 'heal': return HEAL[it.heal].pack;
    case 'armor': return ARMOR[it.level].points;
    default: return 1;
  }
}

export function damageFalloff(def, dist) {
  const [a, b, min] = def.falloff;
  if (dist <= a) return 1;
  if (dist >= b) return min;
  return 1 + (min - 1) * ((dist - a) / (b - a));
}
