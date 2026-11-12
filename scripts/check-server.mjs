// Checks a running game server from the outside over real WebSockets:
// connect, join a practice match, send inputs, receive snapshots, and move the
// session to a second connection.
//
//   node scripts/check-server.mjs https://your-game.example.com
//   node scripts/check-server.mjs http://localhost:3000

import { runSelfTest } from '../server/selftest.js';

const base = process.argv[2] || 'http://localhost:3000';
const url = base.replace(/^http/, 'ws').replace(/\/+$/, '') + '/api/ws';
const result = await runSelfTest(url, { full: true, timeoutMs: 15000 });
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
