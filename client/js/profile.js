// The player's profile: stats, experience and chosen outfit. It lives in this
// browser's local storage; there are no accounts or passwords.

import { OUTFITS, HATS, levelOf, matchXp } from '/shared/cosmetics.js';

const KEY = 'pls-profile';

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function loadProfile() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch { /* private mode or corrupt data: start fresh */ }
  const p = { xp: 0, matches: 0, wins: 0, kills: 0, damage: 0, best: 0, outfit: 0, hat: 0, ...saved };
  // A random id lets the server keep a leaderboard row without knowing who we are.
  if (!/^[a-f0-9]{24}$/.test(p.pid || '')) p.pid = randomId();
  return p;
}

export function saveProfile(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch { /* ignore */ }
}

// Adds a finished match to the profile. Returns what was earned.
export function recordMatch(p, { place, total, kills, damage, won }) {
  const before = levelOf(p.xp).level;
  const gained = matchXp({ place, total, kills, damage, won });
  p.xp += gained;
  p.matches++;
  p.kills += kills;
  p.damage += damage;
  if (won) p.wins++;
  if (!p.best || place < p.best) p.best = place;
  saveProfile(p);
  const after = levelOf(p.xp).level;
  const unlocked = [];
  if (after > before) {
    for (const o of OUTFITS) if (o.level > before && o.level <= after) unlocked.push(o.name);
    for (const h of HATS) if (h.level > before && h.level <= after) unlocked.push(h.name);
  }
  return { gained, level: after, leveledUp: after > before, unlocked };
}

export { OUTFITS, HATS, levelOf };
