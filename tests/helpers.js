// Shared helpers for match-level tests.

import assert from 'node:assert/strict';
import { Match } from '../server/match.js';
import { mulberry32 } from '../shared/rng.js';
import { FIELDS } from '../shared/world.js';

export function fakeClient(id, name = 'P' + id) {
  return {
    id, name, msgs: [], raw: [],
    send(o) { this.msgs.push(o); },
    sendRaw(s) { this.raw.push(s); },
    snaps() { return this.raw.map((r) => JSON.parse(r)); },
    events() {
      const out = [];
      for (const r of this.raw) for (const e of JSON.parse(r).e || []) out.push(e);
      return out;
    },
    state() {
      const withSt = this.snaps().filter((x) => x.st);
      return withSt.length ? withSt[withSt.length - 1].st : null;
    },
  };
}

// Starts a match with n humans standing in a row on the flat paddy fields.
export function startMatch(nHumans, opts = {}) {
  const m = new Match({ bots: false, lobbySeconds: 0, rnd: mulberry32(opts.seed ?? 11), ...opts });
  const clients = [];
  for (let i = 1; i <= nHumans; i++) {
    const c = fakeClient(i);
    clients.push(c);
    m.addClient(c);
  }
  m.update();
  assert.equal(m.state, 'playing');
  const y = m.world.heightAt(FIELDS.x1 - 10, FIELDS.z0 + 20);
  let i = 0;
  for (const p of m.players.values()) {
    const s = p.s;
    s.x = FIELDS.x1 - 10 - i * 3;
    s.z = FIELDS.z0 + 20;
    s.y = y;
    s.vy = 0;
    s.chute = false;
    s.ground = true;
    i++;
  }
  return { m, clients, players: clients.map((c) => c.player) };
}

export function input(seq, o = {}) {
  return [seq, o.mx ?? 0, o.mz ?? 0, o.yaw ?? 0, o.pitch ?? 0, o.b ?? 0, o.ay, o.ap, o.rt];
}

// Feeds the same input for `seconds` of game time to one client.
export function hold(m, client, seconds, o = {}, seqRef = { n: client.player.lastSeq + 1 }) {
  const ticks = Math.round(seconds * 30);
  for (let t = 0; t < ticks; t++) {
    m.onInput(client, [input(seqRef.n++, o), input(seqRef.n++, o)]);
    m.step();
  }
  return seqRef;
}

// Moves a parked vehicle next to a player so tests do not depend on the map layout.
export function parkNear(m, p, type = 'auto', dx = 2.2) {
  const v = [...m.vehicles.values()].find((x) => x.type === type && !x.seats.some(Boolean));
  v.s.x = p.s.x + dx;
  v.s.z = p.s.z;
  v.s.y = m.world.heightAt(v.s.x, v.s.z);
  v.s.yaw = 0;
  v.s.speed = 0;
  m.rebuildObstacles();
  return v;
}
