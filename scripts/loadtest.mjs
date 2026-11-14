// Load test: how does one server process cope with bigger matches?
//
// Starts a private server, connects N real WebSocket clients into one room,
// has each of them send movement input at the normal 60 commands a second, and
// measures the server's simulation time per tick and the data each client
// receives. Usage:
//
//   node scripts/loadtest.mjs            (16, 32, 50 and 100 players)
//   node scripts/loadtest.mjs 64 20      (64 players for 20 seconds)

import { WebSocket } from 'ws';
import { createServer } from '../server/index.js';

const sizes = process.argv[2] ? [Number(process.argv[2])] : [16, 32, 50, 100];
const seconds = Number(process.argv[3] || 12);

async function run(n, withBots) {
  const humans = withBots ? Math.max(1, Math.round(n / 4)) : n;
  const app = createServer({ env: { MAX_PLAYERS: String(n), BOT_FILL: String(n), BOTS: withBots ? '1' : '0', MAX_CLIENTS: '400' } });
  const { port } = await app.listen(0, '127.0.0.1');

  // Time every simulation tick.
  const mm = app.matchmaker;
  const update = mm.update.bind(mm);
  let ticks = 0;
  let total = 0;
  let worst = 0;
  let measuring = false;
  mm.update = () => {
    const t0 = performance.now();
    update();
    if (!measuring) return;
    const dt = performance.now() - t0;
    ticks++;
    total += dt;
    if (dt > worst) worst = dt;
  };

  const clients = [];
  for (let i = 0; i < humans; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    const c = { ws, started: false, seq: 0, yaw: Math.random() * 6.28, msgs: 0, chars: 0 };
    ws.on('message', (data) => {
      c.msgs++;
      c.chars += data.length;
      if (!c.started && data.length > 200 && data.toString().startsWith('{"t":"start"')) c.started = true;
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ t: 'join', name: 'Load' + i, mode: 'room', room: 'load' }));
    clients.push(c);
  }
  for (const c of clients) c.ws.send(JSON.stringify({ t: 'ready' }));
  const t0 = Date.now();
  while (!clients.every((c) => c.started)) {
    if (Date.now() - t0 > 15000) throw new Error('match did not start');
    await new Promise((r) => setTimeout(r, 50));
  }

  // Everyone runs around, turning now and then, like a busy match.
  const pump = setInterval(() => {
    for (const c of clients) {
      if (c.ws.readyState !== 1) continue;
      if (Math.random() < 0.02) c.yaw += (Math.random() - 0.5) * 2;
      const a = [++c.seq, 0, 1, Math.round(c.yaw * 1e5) / 1e5, 0, 2];
      const b = [++c.seq, 0, 1, Math.round(c.yaw * 1e5) / 1e5, 0, 2];
      c.ws.send(JSON.stringify({ t: 'i', a: [a, b] }));
    }
  }, 1000 / 30);

  await new Promise((r) => setTimeout(r, 1500)); // let it settle
  for (const c of clients) {
    c.msgs = 0;
    c.chars = 0;
    c.wire0 = c.ws._socket.bytesRead;
  }
  measuring = true;
  const lagStart = performance.now();
  let lagWorst = 0;
  let lagLast = lagStart;
  const lagTimer = setInterval(() => {
    const now = performance.now();
    lagWorst = Math.max(lagWorst, now - lagLast - 10);
    lagLast = now;
  }, 10);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  measuring = false;
  clearInterval(lagTimer);
  clearInterval(pump);

  const wire = clients.reduce((a, c) => a + (c.ws._socket.bytesRead - c.wire0), 0) / clients.length / seconds;
  const raw = clients.reduce((a, c) => a + c.chars, 0) / clients.length / seconds;
  const rate = clients.reduce((a, c) => a + c.msgs, 0) / clients.length / seconds;
  const match = [...mm.matches][0];
  const result = {
    players: n,
    humans,
    bots: n - humans,
    'tick avg ms': +(total / ticks).toFixed(2),
    'tick worst ms': +worst.toFixed(1),
    'budget used %': +(((total / ticks) / (1000 / 30)) * 100).toFixed(1),
    'loop lag worst ms': +lagWorst.toFixed(0),
    'snapshots/s': +rate.toFixed(1),
    'KB/s per client': +(wire / 1024).toFixed(1),
    'KB/s uncompressed': +(raw / 1024).toFixed(1),
    alive: match ? match.aliveCount : 0,
  };
  for (const c of clients) c.ws.terminate();
  await app.close();
  return result;
}

const rows = [];
for (const n of sizes) {
  rows.push(await run(n, false));
  rows.push(await run(n, true));
}
console.table(rows);
process.exit(0);
