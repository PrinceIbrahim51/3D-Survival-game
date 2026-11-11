// Project Last Stand - game server.
// Serves the browser client over HTTP and runs authoritative matches over
// WebSocket on the same port.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TICK_MS } from '../shared/constants.js';
import { getWorld } from '../shared/world.js';
import { getNav } from './nav.js';
import { Matchmaker } from './matchmaker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = [
  ['/shared/', path.join(ROOT, 'shared')],
  ['/vendor/three/', path.join(ROOT, 'node_modules', 'three')],
  ['/', path.join(ROOT, 'client')],
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

export function sanitizeName(raw) {
  // Strip control characters and markup-ish symbols; the client also renders
  // names with textContent, never innerHTML.
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || 'Player' + Math.floor(100 + Math.random() * 900);
}

export function createServer(options = {}) {
  const env = options.env ?? process.env;
  const maxPlayers = Math.max(1, Math.min(32, num(env.MAX_PLAYERS, 16)));
  const matchmaker = new Matchmaker({
    maxPlayers,
    fillTo: Math.max(1, Math.min(maxPlayers, num(env.BOT_FILL, 12))),
    lobbySeconds: num(env.LOBBY_SECONDS, 20),
    zoneScale: num(env.ZONE_SCALE, 1),
    bots: env.BOTS !== '0',
    ...options.matchmaking,
  });

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...matchmaker.stats() }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    for (const [prefix, dir] of STATIC) {
      if (!pathname.startsWith(prefix)) continue;
      const file = path.join(dir, pathname.slice(prefix.length));
      // Never serve anything outside the mapped directory.
      if (file !== dir && !file.startsWith(dir + path.sep)) break;
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404).end('Not found');
          return;
        }
        res.writeHead(200, {
          'content-type': MIME[path.extname(file)] || 'application/octet-stream',
          'content-length': st.size,
          'cache-control': prefix === '/vendor/three/' ? 'public, max-age=86400' : 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        if (req.method === 'HEAD') res.end();
        else fs.createReadStream(file).pipe(res);
      });
      return;
    }
    res.writeHead(404).end('Not found');
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  let nextClientId = 1;
  const maxClients = num(env.MAX_CLIENTS, 200);

  wss.on('connection', (ws) => {
    if (wss.clients.size > maxClients) {
      ws.close(1013, 'Server full');
      return;
    }
    const client = {
      id: nextClientId++,
      ws,
      name: 'Player',
      match: null,
      player: null,
      ready: false,
      // Simple flood protection: at most `burst` messages banked, refilled at
      // `rate` per second. Normal play sends about 60 small messages a second.
      tokens: 240,
      lastRefill: Date.now(),
      send(obj) {
        if (ws.readyState === 1) ws.send(JSON.stringify(obj));
      },
      sendRaw(str) {
        // Drop snapshots for clients that cannot keep up instead of buffering forever.
        if (ws.readyState === 1 && ws.bufferedAmount < 512 * 1024) ws.send(str);
      },
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      client.tokens = Math.min(240, client.tokens + ((now - client.lastRefill) / 1000) * 150);
      client.lastRefill = now;
      if (client.tokens < 1) return;
      client.tokens -= 1;

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 'i':
          if (client.match) client.match.onInput(client, msg.a);
          break;
        case 'act':
          if (client.match) client.match.onAction(client, msg);
          break;
        case 'join': {
          client.name = sanitizeName(msg.name);
          const err = matchmaker.join(client, msg);
          if (err) client.send({ t: 'error', msg: err });
          break;
        }
        case 'ready':
          if (client.match) client.match.setReady(client, msg.v !== false);
          break;
        case 'leave':
          matchmaker.leave(client);
          break;
        case 'ping':
          client.send({ t: 'pong', c: msg.c });
          break;
        default:
      }
    });
    ws.on('close', () => matchmaker.leave(client));
    ws.on('error', () => {});
    client.send({ t: 'hello', v: 1 });
  });

  // Fixed-rate simulation loop with drift correction.
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    let steps = 0;
    while (now - last >= TICK_MS && steps < 5) {
      matchmaker.update();
      last += TICK_MS;
      steps++;
    }
    if (now - last > TICK_MS * 5) last = now; // fell far behind: do not spiral
  }, 8);

  return {
    server,
    wss,
    matchmaker,
    listen(port = num(env.PORT, 3000), host = env.HOST || '0.0.0.0') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Build the world and navigation grid up front so the first match starts instantly.
  const t0 = performance.now();
  getNav(getWorld());
  const app = createServer();
  app.listen().then((addr) => {
    console.log(`Project Last Stand server ready in ${Math.round(performance.now() - t0)} ms`);
    console.log(`Open http://localhost:${addr.port} in a browser to play.`);
  });
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
