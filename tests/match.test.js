import test from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../server/match.js';
import { mulberry32 } from '../shared/rng.js';
import { BTN, INPUT_DT, TICK_RATE, SPRINT_SPEED, INTERACT_RADIUS } from '../shared/constants.js';
import { WEAPONS } from '../shared/items.js';
import { FIELDS } from '../shared/world.js';

function fakeClient(id, name = 'P' + id) {
  return {
    id, name, msgs: [], raw: [],
    send(o) { this.msgs.push(o); },
    sendRaw(s) { this.raw.push(s); },
    events() {
      const out = [];
      for (const r of this.raw) for (const e of JSON.parse(r).e || []) out.push(e);
      return out;
    },
  };
}

// Starts a match with the given human clients standing on the flat paddy fields.
function startMatch(nHumans, opts = {}) {
  const m = new Match({ bots: false, lobbySeconds: 0, rnd: mulberry32(opts.seed ?? 11), ...opts });
  const clients = [];
  for (let i = 1; i <= nHumans; i++) {
    const c = fakeClient(i);
    clients.push(c);
    m.addClient(c);
  }
  m.update(); // lobby deadline has passed -> start
  assert.equal(m.state, 'playing');
  const y = m.world.heightAt(FIELDS.x1 - 10, FIELDS.z0 + 20);
  clients.forEach((c, i) => {
    const s = c.player.s;
    s.x = FIELDS.x1 - 10 - i * 3;
    s.z = FIELDS.z0 + 20;
    s.y = y;
    s.vy = 0;
    s.chute = false;
    s.ground = true;
  });
  return { m, clients };
}

function input(seq, o = {}) {
  return [seq, o.mx ?? 0, o.mz ?? 0, o.yaw ?? 0, o.pitch ?? 0, o.b ?? 0, o.ay, o.ap, o.rt];
}

test('a full match of bots ends with one winner and a complete ranking', () => {
  const c = fakeClient(1);
  const m = new Match({ mode: 'practice', maxPlayers: 1, fillTo: 10, lobbySeconds: 0, zoneScale: 0.25, rnd: mulberry32(4) });
  m.addClient(c);
  m.update();
  assert.equal(m.players.size, 10);
  const start = c.msgs.find((x) => x.t === 'start');
  assert.ok(start && start.loot.length > 100 && start.players.length === 10);
  for (let i = 0; i < TICK_RATE * 60 * 6 && m.state === 'playing'; i++) m.step();
  assert.equal(m.state, 'ended');
  const end = c.msgs.find((x) => x.t === 'end');
  assert.ok(end.winner);
  assert.deepEqual(end.rows.map((r) => r.place), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(end.rows[0].id, end.winner.id);
  assert.equal([...m.players.values()].filter((p) => p.alive).length <= 1, true);
});

test('fire rate is enforced by the server no matter how fast the client asks', () => {
  const { m, clients } = startMatch(2);
  const p = clients[0].player;
  p.inv.weapons[0] = { kind: 'ar', mag: 30 };
  p.inv.active = 0;
  let seq = 1;
  for (let tick = 0; tick < TICK_RATE; tick++) {
    m.onInput(clients[0], [input(seq++, { b: BTN.FIRE }), input(seq++, { b: BTN.FIRE })]);
    m.step();
  }
  const shots = clients[1].events().filter((e) => e[0] === 'shot' && e[1] === p.id).length;
  const max = Math.ceil(WEAPONS.ar.rpm / 60) + 1;
  assert.ok(shots >= max - 2 && shots <= max, `${shots} shots in one second`);
  assert.equal(p.inv.weapons[0].mag, 30 - shots);
});

test('a weapon cannot fire without ammunition and reloads from reserve only', () => {
  const { m, clients } = startMatch(2);
  const p = clients[0].player;
  p.inv.weapons[0] = { kind: 'pistol', mag: 1 };
  p.inv.active = 0;
  let seq = 1;
  for (let tick = 0; tick < TICK_RATE * 3; tick++) {
    m.onInput(clients[0], [input(seq++, { b: BTN.FIRE }), input(seq++, { b: BTN.FIRE })]);
    m.step();
  }
  assert.equal(clients[1].events().filter((e) => e[0] === 'shot').length, 1);
  assert.equal(p.inv.weapons[0].mag, 0);
  // With rounds in reserve the empty weapon reloads itself, then fires again.
  p.inv.ammo.light = 5;
  for (let tick = 0; tick < TICK_RATE * 3; tick++) {
    m.onInput(clients[0], [input(seq++, { b: BTN.FIRE }), input(seq++, { b: BTN.FIRE })]);
    m.step();
  }
  assert.equal(clients[1].events().filter((e) => e[0] === 'shot').length, 6);
  assert.equal(p.inv.ammo.light, 0);
});

test('flooding inputs does not make a player faster (speed-hack guard)', () => {
  const { m, clients } = startMatch(2);
  const p = clients[0].player;
  const z0 = p.s.z;
  let seq = 1;
  for (let tick = 0; tick < TICK_RATE; tick++) {
    // Ten times the legitimate input rate, split over several messages.
    for (let k = 0; k < 2; k++) {
      const batch = [];
      for (let i = 0; i < 10; i++) batch.push(input(seq++, { mz: 1, yaw: Math.PI, b: BTN.SPRINT }));
      m.onInput(clients[0], batch);
    }
    m.step();
  }
  const moved = Math.abs(p.s.z - z0);
  assert.ok(moved <= SPRINT_SPEED * 1.6, `moved ${moved.toFixed(2)} m in one second`);
  assert.ok(moved > SPRINT_SPEED * 0.5, 'but legitimate movement still works');
});

test('malformed inputs are ignored and out-of-range values are clamped', () => {
  const { m, clients } = startMatch(2);
  const p = clients[0].player;
  const before = { ...p.s };
  m.onInput(clients[0], 'nope');
  m.onInput(clients[0], [null, 5, [1, NaN, 0, 0, 0, 0], [2, 0, 0, Infinity, 0, 0], [3, 0, 0, 0, 'x', 0]]);
  assert.equal(p.queue.length, 0);
  m.onInput(clients[0], [[4, 99, -99, 0, 9, 0xffff]]);
  assert.deepEqual([p.queue[0].mx, p.queue[0].mz, p.queue[0].pitch, p.queue[0].b], [1, -1, 1.55, 63]);
  // Replayed sequence numbers are dropped.
  m.onInput(clients[0], [[4, 0, 1, 0, 0, 0], [2, 0, 1, 0, 0, 0]]);
  assert.equal(p.queue.length, 1);
  m.step();
  assert.ok(Math.abs(p.s.x - before.x) < 1 && Number.isFinite(p.s.x));
});

test('two players grabbing the same item: only one gets it', () => {
  const { m, clients } = startMatch(2);
  const [a, b] = clients.map((c) => c.player);
  b.s.x = a.s.x + 1;
  const it = m.addLoot('sniper', a.s.x + 0.5, a.s.y, a.s.z + 2, 5);
  m.onAction(clients[0], { a: 'pickup', id: it.id });
  m.onAction(clients[1], { a: 'pickup', id: it.id });
  m.step();
  const owners = [a, b].filter((p) => p.inv.weapons.some((w) => w && w.kind === 'sniper'));
  assert.equal(owners.length, 1);
  assert.equal(owners[0], a);
  assert.equal(m.loot.has(it.id), false);
});

test('pickups out of reach are refused', () => {
  const { m, clients } = startMatch(2);
  const p = clients[0].player;
  const it = m.addLoot('medkit', p.s.x + INTERACT_RADIUS + 1, p.s.y, p.s.z, 1);
  m.onAction(clients[0], { a: 'pickup', id: it.id });
  m.onAction(clients[0], { a: 'pickup', id: 999999 });
  m.onAction(clients[0], { a: 'pickup', id: 'abc' });
  assert.equal(p.inv.medkit, 0);
  assert.equal(m.loot.has(it.id), true);
});

test('walking over loot picks it up and a death drops everything', () => {
  const { m, clients } = startMatch(2);
  const [a, b] = clients.map((c) => c.player);
  m.addLoot('ar', a.s.x, a.s.y, a.s.z, 30);
  m.addLoot('a_rifle', a.s.x + 0.3, a.s.y, a.s.z, 30);
  m.addLoot('armor1', a.s.x, a.s.y, a.s.z + 0.3, 50);
  m.step();
  assert.equal(a.inv.weapons[0].kind, 'ar');
  assert.equal(a.inv.ammo.rifle, 30);
  assert.equal(a.inv.armor, 50);
  const before = m.loot.size;
  m.damage(a, 500, b, 'ar', false);
  m.step();
  assert.equal(a.alive, false);
  assert.equal(m.loot.size, before + 2, 'weapon and ammo are on the ground (the vest was shot to pieces)');
  assert.equal(m.state, 'ended');
  assert.equal(m.winner, b);
  assert.equal(b.kills, 1);
  assert.equal(clients[0].msgs.find((x) => x.t === 'dead').place, 2);
});

test('shooting another player deals damage through the server ray cast', () => {
  const { m, clients } = startMatch(2);
  const [a, b] = clients.map((c) => c.player);
  // b stands 10 m in front of a (a looks down -Z at yaw 0).
  b.s.x = a.s.x;
  b.s.z = a.s.z - 10;
  a.inv.weapons[0] = { kind: 'sniper', mag: 5 };
  a.inv.active = 0;
  m.step();
  m.onInput(clients[0], [input(1, { b: BTN.FIRE | BTN.ADS | BTN.CROUCH }), input(2, { b: BTN.ADS | BTN.CROUCH })]);
  m.step();
  assert.ok(b.hp < 100, `hp ${b.hp}`);
  const evA = clients[0].events();
  assert.ok(evA.some((e) => e[0] === 'hit' && e[1] === b.id));
  assert.ok(clients[1].events().some((e) => e[0] === 'dmg'));
  // Aiming away misses.
  const hp = b.hp;
  a.nextFire = 0;
  m.onInput(clients[0], [input(3, { yaw: Math.PI, b: BTN.FIRE | BTN.ADS })]);
  m.step();
  assert.equal(b.hp, hp);
});

test('lag compensation rewinds targets to where the shooter saw them', () => {
  const { m, clients } = startMatch(2);
  const [a, b] = clients.map((c) => c.player);
  b.s.x = a.s.x;
  b.s.z = a.s.z - 12;
  for (let i = 0; i < 6; i++) m.step();
  const seenAt = m.time;
  // b now side-steps 4 m; a still fires at the old position with an old render time.
  b.s.x += 4;
  for (let i = 0; i < 3; i++) m.step();
  a.inv.weapons[0] = { kind: 'sniper', mag: 5 };
  a.inv.active = 0;
  m.onInput(clients[0], [input(1, { b: BTN.FIRE | BTN.ADS | BTN.CROUCH, rt: seenAt })]);
  m.step();
  assert.ok(b.hp < 100, 'hit registered at the rewound position');
  // Without a valid render time the shot at the stale position misses.
  const hp = b.hp;
  a.nextFire = 0;
  m.onInput(clients[0], [input(2, { b: BTN.FIRE | BTN.ADS | BTN.CROUCH, rt: m.time + TICK_RATE })]);
  m.step();
  assert.equal(b.hp, hp);
});

test('healing takes time, consumes the item and respects its ceiling', () => {
  const { m, clients } = startMatch(2);
  const p = clients[0].player;
  p.hp = 40;
  p.inv.bandage = 2;
  m.onAction(clients[0], { a: 'heal', k: 'bandage' });
  assert.ok(p.heal);
  let seq = 1;
  for (let tick = 0; tick < TICK_RATE * 3; tick++) {
    m.onInput(clients[0], [input(seq++), input(seq++)]);
    m.step();
  }
  assert.equal(p.hp, 60);
  assert.equal(p.inv.bandage, 1);
  p.hp = 80;
  m.onAction(clients[0], { a: 'heal', k: 'bandage' });
  assert.equal(p.heal, null, 'bandages do not work above their ceiling');
  m.onAction(clients[0], { a: 'heal', k: 'medkit' });
  assert.equal(p.heal, null, 'cannot use an item you do not have');
});

test('the zone hurts players outside it and simultaneous deaths still produce one winner', () => {
  const { m, clients } = startMatch(2);
  const [a, b] = clients.map((c) => c.player);
  m.zone.mode = 'closed';
  m.zone.from = { x: 150, z: 150, r: 1 };
  m.zone.dps = 3000;
  a.kills = 0;
  b.kills = 2;
  m.step();
  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
  assert.equal(m.state, 'ended');
  assert.equal(m.winner, b, 'more kills wins the tie');
  assert.deepEqual([a.place, b.place], [2, 1]);
  assert.equal(clients[1].msgs.some((x) => x.t === 'dead'), false, 'the winner is not told they lost');
  assert.equal(clients[0].msgs.find((x) => x.t === 'end').winner.id, b.id);
});

test('a disconnect counts as an elimination and can end the match', () => {
  const { m, clients } = startMatch(3);
  m.removeClient(clients[2]);
  m.step();
  assert.equal(m.aliveCount, 2);
  assert.equal(m.state, 'playing');
  m.removeClient(clients[1]);
  m.step();
  assert.equal(m.state, 'ended');
  assert.equal(m.winner, clients[0].player);
});

test('lobby: readying up starts the match early, leaving empties it', () => {
  const m = new Match({ bots: false, lobbySeconds: 600, readySeconds: 0 });
  const a = fakeClient(1);
  const b = fakeClient(2);
  m.addClient(a);
  m.addClient(b);
  m.update();
  assert.equal(m.state, 'waiting');
  m.setReady(a, true);
  m.update();
  assert.equal(m.state, 'waiting', 'everyone must be ready');
  m.setReady(b, true);
  m.update();
  assert.equal(m.state, 'playing');
  assert.equal(a.msgs.at(-1).t, 'start');

  const m2 = new Match({ bots: false, lobbySeconds: 600 });
  const c = fakeClient(3);
  m2.addClient(c);
  m2.removeClient(c);
  assert.equal(m2.state, 'closed');
});
