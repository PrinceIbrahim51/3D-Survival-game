// Vercel Function: the game server.
//
// Vercel Functions accept WebSocket connections when the function's default
// export is a Node.js HTTP server with a `ws` server attached, which is exactly
// what createServer() builds. Static files (the game client) are served by
// Vercel's CDN from the `public/` folder produced by scripts/build-static.mjs.
//
// A function may only run for `maxDuration` seconds (see vercel.json), and an
// open WebSocket ends with it. CONN_TTL tells clients to move to a fresh
// connection a little before that, which they do without interrupting play.

import { createServer } from '../server/index.js';

const app = createServer({
  env: {
    CONN_TTL: '280',
    ...process.env,
  },
});

export default app.server;
