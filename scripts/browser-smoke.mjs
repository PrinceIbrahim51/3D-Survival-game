// Two-client browser smoke test.
//
// Starts a private server, opens two real browser tabs, has them join the same
// room, checks that each sees the other move, then lets one leave and checks
// that the other is shown the victory screen.
//
// Needs Playwright, which is not a dependency of the game itself:
//   npm install --no-save playwright && npx playwright install chromium
//   node scripts/browser-smoke.mjs

import { createServer } from '../server/index.js';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

const app = createServer({ env: { BOTS: '0', DEBUG_SPAWN: '1' } });
const { port } = await app.listen(0, '127.0.0.1');
// Software rendering flags let this run on machines without a GPU (CI).
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
let failed = false;
const check = (ok, label) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) failed = true;
};

async function open(name, spawn) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.addInitScript(() => localStorage.setItem('pls-settings', JSON.stringify({ quality: 'low' })));
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/?spawn=${spawn}`);
  await page.waitForFunction(() => window.__pls && window.__pls.net.connected);
  await page.fill('#name', name);
  await page.fill('#room', 'smoke');
  await page.click('#play-room');
  await page.waitForSelector('#lobby:not(.hidden)');
  return page;
}

try {
  // Two players facing each other on the paddy fields, 8 m apart.
  const a = await open('Asha', '-50,52,0');
  const b = await open('Bala', '-50,44,3.14159');
  await a.click('#lobby-ready');
  await b.click('#lobby-ready');
  const inGame = () => window.__pls.game && window.__pls.game.st && window.__pls.game.players.size === 1;
  await a.waitForFunction(inGame, null, { timeout: 30000 });
  await b.waitForFunction(inGame, null, { timeout: 30000 });
  check(true, 'both clients joined the same match');

  const seenBefore = await a.evaluate(() => [...window.__pls.game.players.values()][0].x);
  await b.keyboard.down('KeyD');
  await b.waitForTimeout(1500);
  await b.keyboard.up('KeyD');
  await a.waitForTimeout(600);
  const seenAfter = await a.evaluate(() => [...window.__pls.game.players.values()][0].x);
  const actual = await b.evaluate(() => window.__pls.game.s.x);
  check(Math.abs(seenAfter - seenBefore) > 1, `A saw B move (${seenBefore.toFixed(2)} -> ${seenAfter.toFixed(2)})`);
  check(Math.abs(seenAfter - actual) < 0.3, 'A and B agree on where B is');

  const hp = await a.evaluate(() => window.__pls.game.st.hp);
  check(hp === 100, 'HUD state arrives from the server');

  await b.close();
  await a.waitForSelector('#result:not(.hidden)', { timeout: 30000 });
  check((await a.textContent('#result-title')) === 'VICTORY', 'the remaining player wins when the other leaves');
  check(errors.length === 0, 'no browser errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  await browser.close();
  await app.close();
}
process.exit(failed ? 1 : 0);
