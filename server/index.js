// Project Last Stand - game server.
// Serves the browser client over HTTP and runs authoritative matches over
// WebSocket on the same port.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
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
  const maxPlayers = Math.max(2, Math.min(100, num(env.MAX_PLAYERS, 16)));
  const matchmaker = new Matchmaker({
    maxPlayers,
    fillTo: Math.max(2, Math.min(maxPlayers, num(env.BOT_FILL, 12))),
    lobbySeconds: num(env.LOBBY_SECONDS, 20),
    zoneScale: num(env.ZONE_SCALE, 1),
    bots: env.BOTS !== '0',
    ...options.matchmaking,
  });

  const debugSpawn = env.DEBUG_SPAWN === '1'; // never enable on a public server
  // A disconnected player keeps their seat this long so they can rejoin.
  const resumeGraceMs = num(env.RESUME_GRACE, 20) * 1000;
  // Hosts that cut long connections (serverless functions) set CONN_TTL so
  // clients move to a fresh socket before the cut happens.
  const connTtl = num(env.CONN_TTL, 0);
  const instanceId = crypto.randomBytes(4).toString('hex');
  const sessions = new Map(); // session id -> client

  // Opens a WebSocket to our own public address and plays the first few
  // protocol steps. Lets a deployment be verified with a plain HTTP request.
  function selfTest(req) {
    return new Promise((resolve) => {
      const proto = String(req.headers['x-forwarded-proto'] || '').includes('https') ? 'wss' : 'ws';
      const url = `${proto}://${req.headers.host}/api/ws`;
      const t0 = Date.now();
      const steps = [];
      let done = false;
      const finish = (ok, extra) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          sock.close();
        } catch { /* already closed */ }
        resolve({ ok, url, ms: Date.now() - t0, steps, instance: instanceId, ...extra });
      };
      const sock = new WebSocket(url);
      const timer = setTimeout(() => finish(false, { error: 'timed out' }), 9000);
      sock.on('error', (err) => finish(false, { error: String(err.message || err) }));
      sock.on('unexpected-response', (_r, res) => finish(false, { error: 'HTTP ' + res.statusCode + ' instead of a WebSocket upgrade' }));
      sock.on('message', (data) => {
        let m;
        try {
          m = JSON.parse(data.toString());
        } catch {
          return;
        }
        steps.push(m.t);
        if (m.t === 'hello') {
          sock.send(JSON.stringify({ t: 'join', name: 'selftest', mode: 'practice' }));
          sock.helloInst = m.inst;
        } else if (m.t === 'lobby') {
          sock.send(JSON.stringify({ t: 'leave' }));
          finish(true, { sameInstance: sock.helloInst === instanceId, lobbyPlayers: m.players.length });
        }
      });
    });
  }

  const server = http.createServer((req, res) => {
    let url;
    let pathname;
    try {
      url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (pathname === '/healthz' || pathname === '/api/ws' || pathname === '/ws') {
      const reply = (body) => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      if (url.searchParams.has('selftest')) selfTest(req).then(reply);
      else reply({ ok: true, instance: instanceId, sessions: sessions.size, ...matchmaker.stats() });
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

  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
  let nextClientId = 1;
  const maxClients = num(env.MAX_CLIENTS, 200);

  // A client is a player's session. Its socket can be replaced: after a
  // dropped connection, or deliberately before a host's connection time limit.
  function newClient() {
    const client = {
      id: nextClientId++,
      sid: crypto.randomBytes(16).toString('hex'),
      ws: null,
      name: 'Player',
      match: null,
      player: null,
      ready: false,
      graceTimer: null,
      // Simple flood protection: at most `burst` messages banked, refilled at
      // `rate` per second. Normal play sends about 60 small messages a second.
      tokens: 240,
      lastRefill: Date.now(),
      send(obj) {
        const ws = client.ws;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
      },
      sendRaw(str) {
        const ws = client.ws;
        // Drop snapshots for clients that cannot keep up instead of buffering forever.
        if (ws && ws.readyState === 1 && ws.bufferedAmount < 512 * 1024) ws.send(str);
      },
    };
    sessions.set(client.sid, client);
    return client;
  }

  function drop(client) {
    clearTimeout(client.graceTimer);
    matchmaker.leave(client);
    sessions.delete(client.sid);
  }

  function attach(client, ws) {
    const old = client.ws;
    clearTimeout(client.graceTimer);
    client.ws = ws;
    ws.client = client;
    if (old && old !== ws) {
      try {
        old.close(4000, 'replaced');
      } catch { /* already closing */ }
    }
  }

  function detach(ws) {
    const client = ws.client;
    if (!client || client.ws !== ws) return; // an old socket that was already replaced
    client.ws = null;
    if (!client.match) drop(client);
    else client.graceTimer = setTimeout(() => drop(client), resumeGraceMs);
  }

  const hello = (client, t) => ({ t, v: 2, sid: client.sid, inst: instanceId, ttl: connTtl });

  wss.on('connection', (ws, req) => {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname !== '/ws' && pathname !== '/api/ws') {
      ws.close(1008, 'Unknown endpoint');
      return;
    }
    if (wss.clients.size > maxClients) {
      ws.close(1013, 'Server full');
      return;
    }
    attach(newClient(), ws);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let client = ws.client;
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
          client.debugSpawn = debugSpawn && Array.isArray(msg.spawn) && msg.spawn.slice(0, 3).every(Number.isFinite) ? msg.spawn.slice(0, 3) : null;
          const err = matchmaker.join(client, msg);
          if (err) client.send({ t: 'error', msg: err });
          break;
        }
        case 'resume': {
          // Take over an existing session with this new socket.
          const prev = typeof msg.sid === 'string' ? sessions.get(msg.sid) : null;
          if (!prev || prev === client) {
            client.send({ t: 'gone' });
            break;
          }
          sessions.delete(client.sid); // the placeholder session made for this socket
          client = prev;
          attach(client, ws);
          client.send({ ...hello(client, 'resumed'), soft: !!msg.soft });
          // A soft resume is a planned hand-over: nothing was missed, so the
          // game simply continues on the new socket.
          if (!msg.soft) {
            if (client.match) client.match.resync(client);
            else client.send({ t: 'idle' });
          }
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
    ws.on('close', () => detach(ws));
    ws.on('error', () => {});
    ws.client.send(hello(ws.client, 'hello'));
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
    sessions,
    instanceId,
    listen(port = num(env.PORT, 3000), host = env.HOST || '0.0.0.0') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      clearInterval(timer);
      for (const c of sessions.values()) clearTimeout(c.graceTimer);
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
