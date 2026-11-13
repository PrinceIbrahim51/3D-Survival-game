// Puts connected clients into matches: public quick matches, solo practice
// against bots, and private rooms shared by a code.

import { Match } from './match.js';

const ROOM_RE = /^[A-Z0-9]{3,12}$/;

export class Matchmaker {
  constructor(config = {}) {
    this.config = {
      maxPlayers: 16,
      fillTo: 12,
      lobbySeconds: 20,
      roomLobbySeconds: 90,
      zoneScale: 1,
      bots: true,
      maxMatches: 40,
      ...config,
    };
    this.matches = new Set();
    this.rooms = new Map();
    this.open = new Map(); // team size -> public match currently accepting players
  }

  base() {
    const c = this.config;
    return { maxPlayers: c.maxPlayers, fillTo: c.fillTo, zoneScale: c.zoneScale, bots: c.bots };
  }

  // Returns an error string, or null on success.
  join(client, req) {
    if (client.match) client.match.removeClient(client);
    const mode = ['practice', 'room', 'watch'].includes(req.mode) ? req.mode : 'quick';
    const teamSize = req.team === 2 || req.team === 4 ? req.team : 1;
    let match;
    if (mode === 'watch') {
      // Spectate the busiest match in progress.
      let best = null;
      for (const m of this.matches) {
        if (m.state === 'playing' && (!best || m.aliveCount > best.aliveCount)) best = m;
      }
      if (!best) return 'No match is being played right now. Start one!';
      best.addWatcher(client);
      return null;
    }
    if (mode === 'practice') {
      if (this.matches.size >= this.config.maxMatches) return 'Server is full, try again in a minute.';
      match = new Match({ ...this.base(), mode, teamSize, maxPlayers: 1, bots: true, lobbySeconds: 3 });
      this.matches.add(match);
    } else if (mode === 'room') {
      const code = String(req.room || '').trim().toUpperCase();
      if (!ROOM_RE.test(code)) return 'Room codes are 3-12 letters or digits.';
      match = this.rooms.get(code);
      if (match && match.state !== 'waiting') return 'That room is already in a match. Try again when it ends.';
      if (match && !match.canJoin()) return 'That room is full.';
      if (!match) {
        if (this.matches.size >= this.config.maxMatches) return 'Server is full, try again in a minute.';
        match = new Match({
          ...this.base(), mode, room: code, teamSize, lobbySeconds: this.config.roomLobbySeconds,
          bots: this.config.bots && req.bots !== false,
        });
        this.matches.add(match);
        this.rooms.set(code, match);
      }
    } else {
      match = this.open.get(teamSize);
      if (!match || !match.canJoin()) {
        if (this.matches.size >= this.config.maxMatches) return 'Server is full, try again in a minute.';
        match = new Match({ ...this.base(), mode, teamSize, lobbySeconds: this.config.lobbySeconds });
        this.matches.add(match);
        this.open.set(teamSize, match);
      }
    }
    if (this.onMatch) match.onResult = this.onMatch;
    match.addClient(client);
    return null;
  }

  leave(client) {
    if (client.match) client.match.removeClient(client);
  }

  // Advances every match by one tick and forgets finished ones.
  update() {
    for (const m of this.matches) {
      m.update();
      if (m.state === 'closed') {
        this.matches.delete(m);
        if (this.open.get(m.teamSize) === m) this.open.delete(m.teamSize);
        if (m.opts.room && this.rooms.get(m.opts.room) === m) this.rooms.delete(m.opts.room);
      } else if (m.state !== 'waiting') {
        if (this.open.get(m.teamSize) === m) this.open.delete(m.teamSize);
      }
    }
  }

  stats() {
    let players = 0;
    for (const m of this.matches) players += m.humanCount;
    return { matches: this.matches.size, players };
  }
}
