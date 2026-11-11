// End-to-end smoke test: a real server, real HTTP requests and two real
// WebSocket clients playing a private room match.

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer, sanitizeName } from '../server/index.js';
import { BTN } from '../shared/constants.js';

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const c = { ws, msgs: [], waiters: [] };
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      c.msgs.push(msg);
      c.waiters = c.waiters.filter((w) => !w(msg));
    });
    c.send = (o) => ws.send(JSON.stringify(o));
    c.wait = (pred, ms = 5000) => new Promise((res, rej) => {
      const found = c.msgs.find(pred);
      if (found) return res(found);
      const timer = setTimeout(() => rej(new Error('timed out waiting for message')), ms);
      c.waiters.push((m) => {
        if (!pred(m)) return false;
        clearTimeout(timer);
        res(m);
        return true;
      });
      return undefined;
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

test('names are sanitised', () => {
  assert.equal(sanitizeName('  <b>Ravi</b>  '), 'bRavi/b');
  assert.equal(sanitizeName('a'.repeat(50)).length, 16);
  assert.match(sanitizeName(''), /^Player\d+$/);
  assert.match(sanitizeName(null), /^Player\d+$/);
});

test('HTTP serves the client and refuses to leave its folders', async () => {
  const app = createServer({ env: {} });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${port}`;
    const index = await fetch(base + '/');
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Project Last Stand/i);
    assert.equal((await fetch(base + '/shared/constants.js')).status, 200);
    assert.equal((await fetch(base + '/vendor/three/build/three.module.js')).status, 200);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    for (const bad of ['/../package.json', '/shared/../package.json', '/%2e%2e/package.json', '/shared/%2e%2e%2fserver/index.js', '/server/index.js']) {
      const res = await fetch(base + bad);
      assert.equal(res.status, 404, bad);
    }
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
  } finally {
    await app.close();
  }
});

test('two clients play a private room match from lobby to result', async () => {
  const app = createServer({ env: { BOTS: '0', ZONE_SCALE: '0.05' } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const a = await connect(port);
    const b = await connect(port);
    await a.wait((m) => m.t === 'hello');

    a.send({ t: 'join', name: 'Asha', mode: 'room', room: 'test1' });
    b.send({ t: 'join', name: 'Bala', mode: 'room', room: 'TEST1' });
    const lobby = await b.wait((m) => m.t === 'lobby' && m.players.length === 2);
    assert.deepEqual(lobby.players.map((p) => p.name).sort(), ['Asha', 'Bala']);
    assert.equal(lobby.room, 'TEST1');

    // A bad room code is rejected without disturbing anyone.
    const c = await connect(port);
    c.send({ t: 'join', name: 'x', mode: 'room', room: '!!' });
    assert.match((await c.wait((m) => m.t === 'error')).msg, /Room codes/);
    c.ws.close();

    a.send({ t: 'ready' });
    b.send({ t: 'ready' });
    const startA = await a.wait((m) => m.t === 'start', 8000);
    const startB = await b.wait((m) => m.t === 'start', 8000);
    assert.equal(startA.total, 2);
    assert.notEqual(startA.you, startB.you);
    assert.deepEqual(startA.loot, startB.loot, 'both clients see the same loot');

    // Inputs are acknowledged in snapshots.
    a.send({ t: 'i', a: [[1, 0, 1, 0, 0, BTN.SPRINT], [2, 0, 1, 0, 0, BTN.SPRINT]] });
    const snap = await a.wait((m) => m.t === 's' && m.a === 2);
    assert.equal(snap.me.length, 7);
    assert.equal(snap.p.length, 2);
    assert.ok(snap.st && snap.st.hp === 100);

    // Garbage must not crash the server.
    a.ws.send('not json');
    a.ws.send(JSON.stringify({ t: 'i', a: { nope: true } }));
    a.ws.send(JSON.stringify({ t: 'act', a: 'pickup', id: { $gt: '' } }));
    a.ws.send(Buffer.from([1, 2, 3]));
    a.send({ t: 'ping', c: 42 });
    assert.equal((await a.wait((m) => m.t === 'pong')).c, 42);

    // b disconnects: a is the last one standing.
    b.ws.close();
    const end = await a.wait((m) => m.t === 'end', 8000);
    assert.equal(end.winner.name, 'Asha');
    assert.equal(end.you.place, 1);
    assert.deepEqual(end.rows.map((r) => r.name), ['Asha', 'Bala']);
    a.ws.close();
  } finally {
    await app.close();
  }
});

test('practice mode fills the match with bots and starts on its own', async () => {
  const app = createServer({ env: { BOT_FILL: '6' } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const a = await connect(port);
    a.send({ t: 'join', name: 'Solo', mode: 'practice' });
    a.send({ t: 'ready' });
    const start = await a.wait((m) => m.t === 'start', 8000);
    assert.equal(start.total, 6);
    assert.equal(start.players.filter((p) => p[2] === 1).length, 5);
    const snap = await a.wait((m) => m.t === 's' && m.n > 5);
    assert.equal(snap.al, 6);
    a.ws.close();
  } finally {
    await app.close();
  }
});
