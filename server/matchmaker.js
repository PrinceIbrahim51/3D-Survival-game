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
    this.open = null; // the public match currently accepting players
  }

  base() {
    const c = this.config;
    return { maxPlayers: c.maxPlayers, fillTo: c.fillTo, zoneScale: c.zoneScale, bots: c.bots };
  }

  // Returns an error string, or null on success.
  join(client, req) {
    if (client.match) client.match.removeClient(client);
    const mode = req.mode === 'practice' || req.mode === 'room' ? req.mode : 'quick';
    let match;
    if (mode === 'practice') {
      if (this.matches.size >= this.config.maxMatches) return 'Server is full, try again in a minute.';
      match = new Match({ ...this.base(), mode, maxPlayers: 1, bots: true, lobbySeconds: 3 });
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
          ...this.base(), mode, room: code, lobbySeconds: this.config.roomLobbySeconds,
          bots: this.config.bots && req.bots !== false,
        });
        this.matches.add(match);
        this.rooms.set(code, match);
      }
    } else {
      if (!this.open || !this.open.canJoin()) {
        if (this.matches.size >= this.config.maxMatches) return 'Server is full, try again in a minute.';
        this.open = new Match({ ...this.base(), mode, lobbySeconds: this.config.lobbySeconds });
        this.matches.add(this.open);
      }
      match = this.open;
    }
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
        if (this.open === m) this.open = null;
        if (m.opts.room && this.rooms.get(m.opts.room) === m) this.rooms.delete(m.opts.room);
      } else if (m.state !== 'waiting') {
        if (this.open === m) this.open = null;
      }
    }
  }

  stats() {
    let players = 0;
    for (const m of this.matches) players += m.humanCount;
    return { matches: this.matches.size, players };
  }
}
