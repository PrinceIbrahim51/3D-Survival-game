// End-to-end smoke test: a real server, real HTTP requests and two real
// WebSocket clients playing a private room match.

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer, sanitizeName } from '../server/index.js';
import { BTN } from '../shared/constants.js';

function connect(port, path = '/api/ws') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
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
    const health = await (await fetch(base + '/api/ws')).json();
    assert.equal(health.ok, true);
    // The built-in self test connects back to the server over a real WebSocket.
    const self = await (await fetch(base + '/api/ws?selftest=1')).json();
    assert.equal(self.ok, true, JSON.stringify(self));
    assert.equal(self.sameInstance, true);
    assert.deepEqual(self.steps.slice(0, 2), ['hello', 'lobby']);
    const full = await (await fetch(base + '/api/ws?selftest=full')).json();
    assert.equal(full.ok, true, JSON.stringify(full));
    assert.deepEqual(full.steps, ['hello', 'lobby', 'start', 'input', 'handover', 'snapshots-continue']);
    assert.equal(full.secondSocketSameInstance, true);
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
  const app = createServer({ env: { BOTS: '0', ZONE_SCALE: '0.05', RESUME_GRACE: '0.2' } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const a = await connect(port, '/ws'); // the old path keeps working
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

test('finished matches are ranked on the leaderboard', async () => {
  const app = createServer({ env: { BOTS: '0', RESUME_GRACE: '0.1' } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const a = await connect(port);
    const b = await connect(port);
    a.send({ t: 'join', name: 'Asha', mode: 'room', room: 'rank', pid: 'a'.repeat(24), skin: [3, 1] });
    b.send({ t: 'join', name: 'Bala', mode: 'room', room: 'rank', pid: 'not valid', skin: [99, 0] });
    await b.wait((m) => m.t === 'lobby' && m.players.length === 2);
    a.send({ t: 'ready' });
    b.send({ t: 'ready' });
    const start = await a.wait((m) => m.t === 'start', 8000);
    const rowA = start.players.find((p) => p[1] === 'Asha');
    const rowB = start.players.find((p) => p[1] === 'Bala');
    assert.deepEqual(rowA[4], [3, 1], 'a valid outfit choice is passed on');
    assert.equal(rowB[4], null, 'an invalid one is dropped');
    b.send({ t: 'leave' });
    await a.wait((m) => m.t === 'end', 8000);
    const board = await (await fetch(`http://127.0.0.1:${port}/api/ws?leaderboard=1`)).json();
    assert.equal(board.top.length, 1, 'only players with a valid id are ranked');
    assert.equal(board.top[0].name, 'Asha');
    assert.equal(board.top[0].wins, 1);
    assert.ok(board.top[0].points > 100);
    assert.equal(JSON.stringify(board).includes('aaaa'), false, 'player ids are never exposed');
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

test('a dropped connection can rejoin the match in progress', async () => {
  const app = createServer({ env: { BOTS: '0', ZONE_SCALE: '0.2', RESUME_GRACE: '5' } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const a = await connect(port);
    const b = await connect(port);
    const helloA = await a.wait((m) => m.t === 'hello');
    assert.match(helloA.sid, /^[0-9a-f]{32}$/);
    a.send({ t: 'join', name: 'Asha', mode: 'room', room: 'back' });
    b.send({ t: 'join', name: 'Bala', mode: 'room', room: 'back' });
    await b.wait((m) => m.t === 'lobby' && m.players.length === 2);
    a.send({ t: 'ready' });
    b.send({ t: 'ready' });
    const start = await a.wait((m) => m.t === 'start', 8000);
    a.send({ t: 'i', a: [[1, 0, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0]] });
    await a.wait((m) => m.t === 's' && m.a === 2);

    // The connection dies without a goodbye.
    a.ws.terminate();
    await new Promise((r) => setTimeout(r, 300));
    const still = await b.wait((m) => m.t === 's' && m.n > 12);
    assert.equal(still.al, 2, 'the disconnected player is still in the match');

    // A new socket takes the session over.
    const a2 = await connect(port);
    a2.send({ t: 'resume', sid: helloA.sid });
    const resumed = await a2.wait((m) => m.t === 'resumed');
    assert.equal(resumed.sid, helloA.sid);
    assert.equal(resumed.soft, false);
    const again = await a2.wait((m) => m.t === 'start');
    assert.equal(again.resume, true);
    assert.equal(again.you, start.you);
    assert.equal(again.seq, 2);
    assert.equal(again.alive, true);
    a2.send({ t: 'i', a: [[3, 0, 1, 0, 0, 0]] });
    const snap = await a2.wait((m) => m.t === 's' && m.a === 3);
    assert.ok(snap.st, 'private state is sent again after a resume');

    // Planned hand-over to a third socket: no state resend, old socket is closed.
    const a3 = await connect(port);
    const closed = new Promise((r) => a2.ws.once('close', (code) => r(code)));
    a3.send({ t: 'resume', sid: helloA.sid, soft: true });
    assert.equal((await a3.wait((m) => m.t === 'resumed')).soft, true);
    assert.equal(await closed, 4000);
    await a3.wait((m) => m.t === 's');
    assert.equal(a3.msgs.some((m) => m.t === 'start'), false);

    // Unknown or stale sessions are refused.
    const c = await connect(port);
    c.send({ t: 'resume', sid: 'f'.repeat(32) });
    await c.wait((m) => m.t === 'gone');
    c.send({ t: 'resume', sid: 12345 });
    await c.wait((m) => m.t === 'gone' && c.msgs.filter((x) => x.t === 'gone').length === 2);
    for (const x of [a3, b, c]) x.ws.close();
  } finally {
    await app.close();
  }
});

test('a player who does not come back in time is eliminated', async () => {
  const app = createServer({ env: { BOTS: '0', RESUME_GRACE: '0.3' } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const a = await connect(port);
    const b = await connect(port);
    const c = await connect(port);
    for (const [x, name] of [[a, 'A'], [b, 'B'], [c, 'C']]) x.send({ t: 'join', name, mode: 'room', room: 'gone' });
    await c.wait((m) => m.t === 'lobby' && m.players.length === 3);
    for (const x of [a, b, c]) x.send({ t: 'ready' });
    await a.wait((m) => m.t === 'start', 8000);
    c.ws.terminate();
    const kill = await a.wait((m) => m.t === 's' && (m.e || []).some((e) => e[0] === 'kill' && e[3] === 'left'), 5000);
    assert.equal(kill.al, 2);
    assert.equal(app.sessions.size, 2, 'the abandoned session is forgotten');
    a.ws.close();
    b.ws.close();
  } finally {
    await app.close();
  }
});
