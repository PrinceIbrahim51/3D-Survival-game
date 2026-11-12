// Protocol-level check of a running game server over real WebSockets.
// Used by GET /api/ws?selftest=1 (a deployment testing itself through its own
// public address) and by scripts/check-server.mjs (testing any server).

import WebSocket from 'ws';

function open(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const c = { ws, msgs: [], waiters: [], bytes: 0 };
    const timer = setTimeout(() => reject(new Error('timed out connecting')), timeoutMs);
    ws.on('message', (data) => {
      c.bytes += data.length;
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      c.msgs.push(m);
      c.waiters = c.waiters.filter((w) => !w(m));
    });
    c.send = (o) => ws.send(JSON.stringify(o));
    c.wait = (pred, ms = timeoutMs, label = 'message') => new Promise((res, rej) => {
      const found = c.msgs.find(pred);
      if (found) return res(found);
      const t = setTimeout(() => rej(new Error('timed out waiting for ' + label)), ms);
      c.waiters.push((m) => {
        if (!pred(m)) return false;
        clearTimeout(t);
        res(m);
        return true;
      });
      return undefined;
    });
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(c);
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error('HTTP ' + res.statusCode + ' instead of a WebSocket upgrade'));
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Plays the start of a practice match. `full` also checks inputs, snapshots
// and moving the session to a second socket.
export async function runSelfTest(url, { full = false, timeoutMs = 9000 } = {}) {
  const t0 = Date.now();
  const steps = [];
  const out = { ok: false, url, steps };
  const socks = [];
  try {
    const a = await open(url, timeoutMs);
    socks.push(a);
    const hello = await a.wait((m) => m.t === 'hello', timeoutMs, 'hello');
    steps.push('hello');
    out.instance = hello.inst;
    out.ttl = hello.ttl;
    a.send({ t: 'join', name: 'selftest', mode: 'practice' });
    const lobby = await a.wait((m) => m.t === 'lobby', timeoutMs, 'lobby');
    steps.push('lobby');
    out.lobbyPlayers = lobby.players.length;
    if (full) {
      a.send({ t: 'ready' });
      const start = await a.wait((m) => m.t === 'start', timeoutMs, 'match start');
      steps.push('start');
      out.players = start.total;
      out.loot = start.loot.length;
      // Half a second of input, sent the way a client does.
      for (let seq = 1; seq <= 30; seq += 2) {
        a.send({ t: 'i', a: [[seq, 0, 1, 0, 0, 0], [seq + 1, 0, 1, 0, 0, 0]] });
        await new Promise((r) => setTimeout(r, 33));
      }
      const acked = await a.wait((m) => m.t === 's' && m.a >= 30, timeoutMs, 'acknowledged input');
      steps.push('input');
      out.tick = acked.n;
      const first = a.msgs.find((m) => m.t === 's');
      out.snapshotsPerSecond = Math.round(((acked.n - first.n) / Math.max(1, acked.tm - first.tm)) * 1000);

      // Planned hand-over: a second connection takes the session.
      const b = await open(url, timeoutMs);
      socks.push(b);
      const hello2 = await b.wait((m) => m.t === 'hello', timeoutMs, 'second hello');
      out.secondSocketSameInstance = hello2.inst === hello.inst;
      b.send({ t: 'resume', sid: hello.sid, soft: true });
      const answer = await b.wait((m) => m.t === 'resumed' || m.t === 'gone', timeoutMs, 'resume answer');
      if (answer.t !== 'resumed') throw new Error('the second connection reached a different server instance');
      steps.push('handover');
      const later = await b.wait((m) => m.t === 's' && m.n > acked.n, timeoutMs, 'snapshot on the new socket');
      steps.push('snapshots-continue');
      out.tickAfterHandover = later.n;
      b.send({ t: 'leave' });
    } else {
      a.send({ t: 'leave' });
    }
    out.ok = true;
  } catch (err) {
    out.error = String(err.message || err);
  }
  for (const s of socks) {
    try {
      s.ws.close();
    } catch { /* already closed */ }
  }
  out.ms = Date.now() - t0;
  return out;
}
