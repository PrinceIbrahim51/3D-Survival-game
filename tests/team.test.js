import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, DOWN_HP, BLEED_SECONDS, REVIVE_SECONDS, REVIVE_HP } from '../server/match.js';
import { mulberry32 } from '../shared/rng.js';
import { BTN, PF, TICK_RATE, CROUCH_SPEED } from '../shared/constants.js';
import { startMatch, hold, fakeClient } from './helpers.js';

// Four humans in duos: players 1+2 are team 1, players 3+4 team 2.
function duos() {
  const r = startMatch(4, { teamSize: 2 });
  const [a, b, c, d] = r.players;
  // Keep the teams apart so nothing happens by accident.
  c.s.x = a.s.x;
  c.s.z = a.s.z - 20;
  d.s.x = a.s.x + 3;
  d.s.z = a.s.z - 20;
  b.s.x = a.s.x + 1.5;
  b.s.z = a.s.z;
  return { ...r, a, b, c, d };
}

test('players are grouped into teams in join order, bots fill the rest', () => {
  const { m, a, b, c, d } = duos();
  assert.deepEqual([a.team, b.team, c.team, d.team], [1, 1, 2, 2]);
  assert.equal(m.teamsAlive, 2);

  const solo = fakeClient(1);
  const sq = new Match({ mode: 'practice', maxPlayers: 1, fillTo: 12, lobbySeconds: 0, teamSize: 4, rnd: mulberry32(2) });
  sq.addClient(solo);
  sq.update();
  assert.equal(sq.teams.size, 3);
  for (const members of sq.teams.values()) assert.equal(members.length, 4);
  const start = solo.msgs.find((x) => x.t === 'start');
  assert.equal(start.teamSize, 4);
  assert.equal(start.team, solo.player.team);
  const mates = sq.teams.get(solo.player.team);
  const dist = Math.max(...mates.map((q) => Math.hypot(q.s.x - solo.player.s.x, q.s.z - solo.player.s.z)));
  assert.ok(dist < 12, 'team-mates drop together');
});

test('team-mates cannot hurt each other', () => {
  const { m, a, b, c } = duos();
  m.damage(b, 60, a, 'ar', false);
  assert.equal(b.hp, 100);
  m.damage(c, 60, a, 'ar', false);
  assert.equal(c.hp, 40);
  // Your own grenade still hurts you.
  m.damage(a, 30, a, 'grenade', false);
  assert.equal(a.hp, 70);
});

test('running out of health knocks a player down while a team-mate stands', () => {
  const { m, clients, a, b, c } = duos();
  a.inv.weapons[0] = { kind: 'ar', mag: 30, att: 0 };
  a.inv.active = 0;
  m.damage(a, 500, c, 'ar', false);
  assert.equal(a.alive, true);
  assert.equal(a.downed, true);
  assert.equal(a.hp, DOWN_HP);
  assert.equal(c.kills, 0, 'a knock is not a kill yet');
  m.step();
  assert.ok(clients[2].events().some((e) => e[0] === 'down' && e[1] === c.id && e[2] === a.id));
  assert.ok(clients[2].events().some((e) => e[0] === 'hit' && e[4] === 2));
  assert.ok(clients[0].snaps().pop().p.find((x) => x[0] === a.id)[6] & PF.DOWN);
  assert.equal(clients[0].state().dn, 1);
  assert.deepEqual(clients[1].state().tm[0], [a.id, DOWN_HP, 1]);

  // Downed players crawl slowly and cannot fight or loot.
  const z0 = a.s.z;
  hold(m, clients[0], 1, { mz: 1, b: BTN.FIRE | BTN.SPRINT });
  const moved = z0 - a.s.z;
  assert.ok(moved > 0.5 && moved < CROUCH_SPEED * 0.6, `crawled ${moved.toFixed(2)} m`);
  assert.equal(a.inv.weapons[0].mag, 30, 'no shooting');
  const it = m.addLoot('medkit', a.s.x, a.s.y, a.s.z, 1);
  m.onAction(clients[0], { a: 'pickup', id: it.id });
  m.step();
  assert.equal(a.inv.medkit, 0);
});

test('a downed player bleeds out, and the kill goes to whoever knocked them', () => {
  const { m, a, c } = duos();
  m.damage(a, 500, c, 'ar', false);
  for (let i = 0; i < TICK_RATE * (BLEED_SECONDS - 1); i++) m.step();
  assert.equal(a.alive, true);
  for (let i = 0; i < TICK_RATE * 1.2; i++) m.step();
  assert.equal(a.alive, false);
  assert.equal(c.kills, 1);
  assert.equal(a.killer, c.name);
  assert.equal(m.state, 'playing', 'their team-mate fights on');
});

test('a team-mate can revive, and it takes time and staying close', () => {
  const { m, clients, a, b, c } = duos();
  m.damage(a, 500, c, 'ar', false);
  m.onAction(clients[1], { a: 'use' });
  assert.ok(b.reviving && b.reviving.target === a);
  hold(m, clients[1], REVIVE_SECONDS - 0.5);
  assert.equal(a.downed, true);
  assert.equal(clients[0].state().dn, 2, 'the downed player sees help is coming');
  const hpMid = a.hp;
  hold(m, clients[1], 0.7);
  assert.equal(a.downed, false);
  assert.equal(a.hp, REVIVE_HP);
  assert.ok(hpMid > DOWN_HP - 5, 'bleeding pauses during a revive');
  assert.ok(clients[2].events().some((e) => e[0] === 'up' && e[1] === b.id && e[2] === a.id));

  // Walking away cancels.
  m.damage(a, 500, c, 'ar', false);
  m.onAction(clients[1], { a: 'use' });
  hold(m, clients[1], 1.5, { mz: 1, b: BTN.SPRINT });
  assert.equal(b.reviving, null);
  assert.equal(a.downed, true);
  // Enemies cannot revive.
  c.s.x = a.s.x + 1;
  c.s.z = a.s.z;
  m.onAction(clients[2], { a: 'use' });
  assert.equal(c.reviving, null);
});

test('a team is out when nobody is left standing; the last team wins', () => {
  const { m, clients, a, b, c, d } = duos();
  m.damage(a, 500, c, 'ar', false); // a down
  assert.equal(a.downed, true);
  m.damage(b, 500, d, 'smg', false); // b was the last one standing
  assert.equal(b.alive, false, 'no team-mate left to help: eliminated outright');
  assert.equal(a.alive, false, 'and the downed team-mate goes with them');
  assert.equal(c.kills, 1);
  assert.equal(d.kills, 1);
  m.step();
  assert.equal(m.state, 'ended');
  assert.equal(m.winTeam, 2);
  assert.deepEqual([a.place, b.place, c.place, d.place], [2, 2, 1, 1]);
  const end = clients[2].msgs.find((x) => x.t === 'end');
  assert.equal(end.you.place, 1);
  assert.deepEqual(end.winner.names.sort(), [c.name, d.name].sort());
  assert.equal(end.total, 2);
  const dead = clients[0].msgs.find((x) => x.t === 'dead');
  assert.equal(dead.place, 2);
  assert.equal(dead.teamMode, true);
  assert.equal(clients[2].msgs.some((x) => x.t === 'dead'), false);
});

test('a dead player whose team fights on is told so, then gets the final place', () => {
  const r = startMatch(6, { teamSize: 2 });
  const [a, b, c, d, e, f] = r.players;
  const { m, clients } = r;
  for (const [p, x] of [[c, 30], [d, 33], [e, 60], [f, 63]]) p.s.x = a.s.x + x;
  m.damage(a, 500, c, 'ar', false); // down
  m.damage(a, 500, c, 'ar', false); // finished off
  m.step();
  assert.equal(a.alive, false);
  let dead = clients[0].msgs.filter((x) => x.t === 'dead');
  assert.equal(dead.length, 1);
  assert.equal(dead[0].place, 0, 'team still in the match');
  m.damage(b, 500, e, 'ar', false);
  m.step();
  dead = clients[0].msgs.filter((x) => x.t === 'dead');
  assert.equal(dead.pop().place, 3, 'third of three teams');
  assert.equal(clients[1].msgs.find((x) => x.t === 'dead').place, 3);
  assert.equal(m.teamsAlive, 2);
  assert.equal(m.state, 'playing');
});

test('solo matches never knock anyone down', () => {
  const { m, players } = startMatch(3);
  const [a, b] = players;
  m.damage(a, 500, b, 'ar', false);
  assert.equal(a.alive, false);
  assert.equal(a.downed, false);
  assert.equal(b.kills, 1);
});
