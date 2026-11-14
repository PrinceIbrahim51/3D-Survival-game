// Ranked points per player, kept by the server (which decides match results).
// Players are identified by a random id their browser generated, hashed here.
// Without DATA_DIR the table lives in memory and resets when the server
// restarts; with DATA_DIR it is saved to a JSON file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { matchXp } from '../shared/cosmetics.js';

export class Leaderboard {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'leaderboard.json') : null;
    this.rows = new Map();
    this.saveTimer = null;
    if (this.file) {
      try {
        for (const r of JSON.parse(fs.readFileSync(this.file, 'utf8'))) this.rows.set(r.key, r);
      } catch { /* no file yet */ }
    }
  }

  key(pid) {
    return crypto.createHash('sha256').update(String(pid)).digest('hex').slice(0, 16);
  }

  // Records a finished match. Only humans who sent a player id are ranked.
  record(match) {
    const total = match.teams.size;
    let changed = false;
    for (const p of match.players.values()) {
      if (p.bot || !p.pid) continue;
      const key = this.key(p.pid);
      const row = this.rows.get(key) || { key, name: p.name, points: 0, matches: 0, wins: 0, kills: 0 };
      const won = p.place === 1;
      row.name = p.name;
      row.points += matchXp({ place: p.place || total, total, kills: p.kills, damage: p.damage, won });
      row.matches++;
      row.kills += p.kills;
      if (won) row.wins++;
      this.rows.set(key, row);
      changed = true;
    }
    if (changed && this.file && !this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.save();
      }, 2000);
    }
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Array.from(this.rows.values())));
    } catch { /* read-only file system: keep going in memory */ }
  }

  top(n = 20) {
    return Array.from(this.rows.values())
      .sort((a, b) => b.points - a.points)
      .slice(0, n)
      .map((r, i) => ({ rank: i + 1, name: r.name, points: r.points, matches: r.matches, wins: r.wins, kills: r.kills }));
  }

  close() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
  }
}
