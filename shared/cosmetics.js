// Outfits and hats players can unlock by levelling up. Purely cosmetic: they
// never change hitboxes or stats. Shared so the server can validate choices.

export const OUTFITS = [
  { name: 'Field Green', shirt: 0x7fb341, pants: 0x2f3a56, level: 1 },
  { name: 'Harbour Blue', shirt: 0x3d7ed9, pants: 0x3a3a3a, level: 1 },
  { name: 'Brick Red', shirt: 0xd94f3d, pants: 0x5a4632, level: 2 },
  { name: 'Saffron', shirt: 0xe0a030, pants: 0xe8e0c8, level: 3 },
  { name: 'Teal Coast', shirt: 0x2aa7a0, pants: 0x2f3a56, level: 4 },
  { name: 'Violet Dusk', shirt: 0x8e5bd0, pants: 0x3a3a3a, level: 5 },
  { name: 'White Veshti', shirt: 0xf0ede4, pants: 0xe8e0c8, level: 6 },
  { name: 'Slate', shirt: 0x596673, pants: 0x2e5a3a, level: 7 },
  { name: 'Rose', shirt: 0xd65a9c, pants: 0x6b3a3a, level: 8 },
  { name: 'Night Ops', shirt: 0x22262b, pants: 0x1c1f24, level: 10 },
];

export const HATS = [
  { name: 'No hat', level: 1 },
  { name: 'Cap', level: 2, color: 0xc0392b },
  { name: 'Headband', level: 4, color: 0xf2c14e },
  { name: 'Straw Hat', level: 6, color: 0xd9c48a },
  { name: 'Helmet', level: 9, color: 0x4f5a3c },
];

// Experience needed to go from level n to n + 1 grows by 100 each level.
export function levelOf(xp) {
  let level = 1;
  let need = 100;
  let left = Math.max(0, Math.floor(xp));
  while (left >= need) {
    left -= need;
    level++;
    need += 100;
  }
  return { level, into: left, need };
}

// Experience (and ranked points) earned for one match.
export function matchXp({ place, total, kills, damage, won }) {
  const placing = total > 1 ? Math.round(60 * (1 - (place - 1) / (total - 1))) : 0;
  return 15 + kills * 20 + Math.round(damage / 10) + placing + (won ? 100 : 0);
}

// Returns a valid [outfit, hat] pair, or null.
export function cleanSkin(skin) {
  if (!Array.isArray(skin)) return null;
  const o = skin[0] | 0;
  const h = skin[1] | 0;
  if (o < 0 || o >= OUTFITS.length || h < 0 || h >= HATS.length) return null;
  return [o, h];
}
