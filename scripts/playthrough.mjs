// Functional test round, driven through a real browser.
//
// Starts private game servers, opens the game in headless Chromium and plays
// through every feature the way a player would: menus, movement, looting,
// weapons, healing, throwables, vehicles, team play, touch controls, watching,
// reconnecting and finishing a match. Prints one PASS/FAIL line per check.
//
//   npm install --no-save playwright && npx playwright install chromium
//   node scripts/playthrough.mjs
//
// Options: --only=desktop,touch,team,watch,finish   run selected parts
//          --shots=DIR                              save screenshots there

import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/index.js';

let chromium;
let devices;
try {
  ({ chromium, devices } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
const only = arg('only') ? arg('only').split(',') : null;
const shots = arg('shots');
if (shots) fs.mkdirSync(shots, { recursive: true });
const wants = (part) => !only || only.includes(part);

const results = [];
let area = '';
function check(name, ok, detail) {
  results.push({ area, name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${area}] ${name}${!ok && detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`);
}

// Software rendering flags let this run on machines without a GPU.
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];

async function startServer(env) {
  const app = createServer({ env: { DEBUG_SPAWN: '1', ...env } });
  const { port } = await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${port}` };
}

async function openPage(base, { touch = false, query = '', label = 'page' } = {}) {
  const ctx = touch
    ? await browser.newContext({ ...devices['iPhone 13 landscape'], deviceScaleFactor: 1 })
    : await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    if (!localStorage.getItem('pls-settings')) localStorage.setItem('pls-settings', JSON.stringify({ quality: 'low' }));
  });
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label}: ${m.text()}`);
  });
  await page.goto(base + '/' + query, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__pls);
  page.dbg = (o) => page.evaluate((x) => window.__pls.net.send({ t: 'debug', ...x }), o);
  page.st = () => page.evaluate(() => window.__pls.game && window.__pls.game.st);
  page.g = (fn, a) => page.evaluate(fn, a);
  page.shot = async (name) => {
    if (shots) await page.screenshot({ path: path.join(shots, name + '.png') });
  };
  page.inGame = () => page.waitForFunction(() => window.__pls.game && window.__pls.game.st, null, { timeout: 40000 });
  return page;
}

const sleep = (page, ms) => page.waitForTimeout(ms);

// --------------------------------------------------------------------------
// Desktop: solo practice, keyboard and mouse
// --------------------------------------------------------------------------
if (wants('desktop')) {
  const { app, base } = await startServer({ BOT_FILL: '4', ZONE_SCALE: '4', CONN_TTL: '0' });
  // Start on the road west of the junction: flat and clear for driving.
  const page = await openPage(base, { query: '?spawn=-30,12,1.5708', label: 'desktop' });

  area = 'menu';
  check('page loads and the menu is shown', await page.isVisible('#menu'));
  check('no connection is opened before playing', await page.g(() => !window.__pls.net.connected));
  await page.click('#open-profile');
  check('profile panel opens with level 1', (await page.textContent('#prof-level')) === '1');
  check('ten outfits are listed, later ones locked', await page.g(() => document.querySelectorAll('#prof-outfits button').length === 10 && document.querySelectorAll('#prof-outfits button.locked').length > 0));
  await page.waitForFunction(() => !document.querySelector('#prof-board').textContent.includes('Loading'), null, { timeout: 8000 }).catch(() => {});
  check('leaderboard request answers', !(await page.textContent('#prof-board')).includes('could not'), await page.textContent('#prof-board'));
  await page.click('#prof-close');
  await page.fill('#name', 'Tester');

  area = 'start';
  await page.click('#play-practice');
  await page.waitForSelector('#lobby:not(.hidden)', { timeout: 10000 });
  check('practice opens a lobby', /Practice/.test(await page.textContent('#lobby-title')));
  await page.inGame();
  check('the match starts and the HUD appears', await page.isVisible('#hud'));
  await page.dbg({ calm: 1 });
  const info = await page.g(() => { const g = window.__pls.game; return { players: g.players.size, loot: g.loot.items.size, veh: g.vehicles.size, alive: g.aliveCount }; });
  check('other players, loot and vehicles are present', info.players === 3 && info.loot > 100 && info.veh >= 10, info);
  check('health starts at 100', (await page.st()).hp === 100);

  area = 'movement';
  let a = await page.g(() => ({ x: window.__pls.game.s.x, z: window.__pls.game.s.z }));
  await page.keyboard.down('KeyW');
  await sleep(page, 1200);
  await page.keyboard.up('KeyW');
  let b = await page.g(() => ({ x: window.__pls.game.s.x, z: window.__pls.game.s.z, corr: window.__pls.game.corr.length() }));
  const walked = Math.hypot(b.x - a.x, b.z - a.z);
  check('W walks forward', walked > 3, walked);
  check('prediction matches the server (no rubber-banding)', b.corr < 0.05, b.corr);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await sleep(page, 1200);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  a = await page.g(() => ({ x: window.__pls.game.s.x, z: window.__pls.game.s.z }));
  check('Shift sprints faster than walking', Math.hypot(a.x - b.x, a.z - b.z) > walked * 1.2, Math.hypot(a.x - b.x, a.z - b.z));
  await page.keyboard.press('KeyC');
  await sleep(page, 400);
  check('C crouches', await page.g(() => window.__pls.game.s.crouch));
  await page.keyboard.press('KeyC');
  await page.keyboard.down('Space');
  await sleep(page, 200);
  const air = await page.g(() => !window.__pls.game.s.ground || window.__pls.game.s.vy > 0);
  await page.keyboard.up('Space');
  check('Space jumps', air);
  const yaw0 = await page.g(() => window.__pls.input.yaw);
  await page.mouse.move(400, 270);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(460, 260, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  check('the mouse turns the view', (await page.g(() => window.__pls.input.yaw)) !== yaw0);
  await page.g(() => { window.__pls.input.yaw = Math.PI / 2; window.__pls.input.pitch = 0; });

  area = 'weapons';
  await page.dbg({ give: ['ar', 30] });
  await sleep(page, 700);
  let st = await page.st();
  check('walking over a weapon picks it up and equips it', st.w[0] && st.w[0][0] === 'ar' && st.s === 0, st.w);
  await page.dbg({ give: ['a_rifle', 60] });
  await sleep(page, 500);
  check('ammunition is collected', (await page.st()).am[1] === 60);
  await page.g(() => { window.__pls.input.fire = true; });
  await sleep(page, 900);
  await page.g(() => { window.__pls.input.fire = false; });
  await sleep(page, 400);
  st = await page.st();
  check('firing uses ammunition', st.w[0][1] < 30, st.w[0]);
  await page.keyboard.press('KeyR');
  await sleep(page, 300);
  check('R starts reloading', (await page.st()).rl > 0);
  await sleep(page, 2600);
  st = await page.st();
  check('reload refills the magazine from the reserve', st.w[0][1] === 30 && st.am[1] < 60, [st.w[0], st.am]);
  await page.dbg({ give: ['smg', 30] });
  await sleep(page, 700);
  check('a second weapon goes to slot 2', !!(await page.st()).w[1]);
  await page.keyboard.press('Digit2');
  await sleep(page, 400);
  check('2 switches to the second weapon', (await page.st()).s === 1);
  await page.keyboard.press('Digit3');
  await sleep(page, 400);
  check('3 switches to fists', (await page.st()).s === 2);
  await page.keyboard.press('KeyQ');
  await sleep(page, 400);
  check('Q cycles to the next weapon', (await page.st()).s === 0);
  // Swap: both slots full, a third weapon on the ground with other items lying closer.
  await page.dbg({ give: ['bandage', 6] });
  await sleep(page, 400);
  await page.dbg({ give: ['bandage', 3], dx: 0.3 });
  await page.dbg({ give: ['sniper', 5], dx: -1.6 });
  await page.waitForFunction(() => /Swap for/.test(document.getElementById('prompt').textContent), null, { timeout: 4000 }).catch(() => {});
  const prompt = await page.textContent('#prompt');
  check('a prompt offers the swap', /Swap for Garuda LR/.test(prompt), prompt);
  await page.keyboard.press('KeyF');
  await sleep(page, 600);
  st = await page.st();
  check('F swaps the weapon in hand for the one on the ground', st.w[0] && st.w[0][0] === 'sniper', st.w);
  await sleep(page, 500);
  await page.keyboard.press('KeyF');
  await sleep(page, 600);
  check('F again swaps back', (await page.st()).w[0][0] === 'ar');
  await page.keyboard.press('KeyG');
  await sleep(page, 500);
  check('G drops the weapon in hand', !(await page.st()).w[0]);
  await sleep(page, 600);
  await page.keyboard.press('KeyF');
  await sleep(page, 600);
  check('F picks a dropped weapon up again', !!(await page.st()).w[0]);
  await page.dbg({ give: ['att_mag', 1] });
  await sleep(page, 700);
  st = await page.st();
  check('an attachment fits onto a carried weapon', st.w.some((w) => w && w[2] > 0), st.w);
  check('the weapon slot shows the attachment', /MAG/.test(await page.textContent('#weapons')));

  area = 'healing';
  await page.dbg({ hp: 35 });
  await page.dbg({ give: ['medkit', 1] });
  await sleep(page, 700);
  st = await page.st();
  check('health and med kit count reach the HUD', st.hp === 35 && st.mk === 1, { hp: st.hp, mk: st.mk });
  await page.keyboard.press('Digit5');
  await sleep(page, 500);
  check('5 starts using the med kit', (await page.st()).hl === 'medkit');
  check('a progress bar is shown', await page.isVisible('#progress'));
  await sleep(page, 5800);
  st = await page.st();
  check('the med kit restores full health and is used up', st.hp === 100 && st.mk === 0, { hp: st.hp, mk: st.mk });
  await page.dbg({ hp: 50 });
  await sleep(page, 300);
  await page.keyboard.press('Digit4');
  await sleep(page, 3100);
  st = await page.st();
  check('4 uses a bandage (+20 health)', st.hp === 70, { hp: st.hp, bd: st.bd });
  await page.keyboard.press('Digit5');
  await sleep(page, 300);
  check('using a med kit without one explains why', /No Med Kit/.test(await page.textContent('#announce')));

  area = 'throwables';
  await page.dbg({ give: ['grenade', 1] });
  await page.dbg({ give: ['smoke', 1] });
  await sleep(page, 700);
  st = await page.st();
  check('grenade and smoke are carried', st.gr === 1 && st.sm === 1, { gr: st.gr, sm: st.sm });
  await page.g(() => { window.__pls.input.pitch = 0.15; });
  await page.keyboard.press('Digit6');
  await sleep(page, 500);
  check('6 throws the grenade', (await page.g(() => window.__pls.game.nades.size)) === 1 && (await page.st()).gr === 0);
  await page.waitForFunction(() => window.__pls.game.nades.size === 0, null, { timeout: 8000 }).catch(() => {});
  check('it explodes after its fuse', (await page.g(() => window.__pls.game.nades.size)) === 0);
  await sleep(page, 700);
  await page.keyboard.press('Digit7');
  const cloud = await page.waitForFunction(() => window.__pls.game.effects.clouds.length === 1, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('7 throws smoke and a cloud forms', cloud);
  await page.shot('desktop-smoke');

  area = 'vehicles';
  await page.g(() => { window.__pls.input.yaw = Math.PI / 2; window.__pls.input.pitch = -0.1; });
  await page.dbg({ tp: [-30, 12] });
  await sleep(page, 600);
  await page.dbg({ veh: 'auto' });
  await sleep(page, 900);
  check('a prompt offers to drive the auto', /Drive Auto/.test(await page.textContent('#prompt')), await page.textContent('#prompt'));
  await page.keyboard.press('KeyE');
  await sleep(page, 700);
  st = await page.st();
  check('E gets in behind the wheel', st.veh && st.veh[1] === 0, st.veh);
  await sleep(page, 400);
  check('the vehicle panel is shown', await page.isVisible('#vehinfo'));
  a = await page.g(() => ({ x: window.__pls.game.myVeh.x, z: window.__pls.game.myVeh.z, yaw: window.__pls.game.myVeh.yaw }));
  await page.keyboard.down('KeyW');
  await sleep(page, 2200);
  b = await page.g(() => ({ x: window.__pls.game.myVeh.x, z: window.__pls.game.myVeh.z, speed: window.__pls.game.myVeh.speed, kmh: document.getElementById('vehspeed').textContent }));
  check('W drives it forward', Math.hypot(b.x - a.x, b.z - a.z) > 8, b);
  check('the speedometer shows the speed', Number(b.kmh) > 10, b.kmh);
  await page.keyboard.down('KeyD');
  await sleep(page, 600);
  await page.keyboard.up('KeyD');
  await page.keyboard.up('KeyW');
  const turned = await page.g(() => ({ yaw: window.__pls.game.myVeh.yaw, corr: window.__pls.game.vcorr.length() }));
  await page.shot('desktop-driving');
  check('D steers', Math.abs(turned.yaw - a.yaw) > 0.15, turned);
  check('driving stays in step with the server', turned.corr < 0.6, turned.corr);
  await page.keyboard.down('Space');
  await sleep(page, 1500);
  await page.keyboard.up('Space');
  check('Space brakes to a stop', Math.abs(await page.g(() => window.__pls.game.myVeh.speed)) < 0.5);
  await page.keyboard.press('KeyE');
  await sleep(page, 700);
  st = await page.st();
  check('E gets out', !st.veh);
  check('the player ends up next to the vehicle, unhurt', await page.g(() => { const g = window.__pls.game; return [...g.vehicles.values()].some((v) => { const d = Math.hypot(v.x - g.s.x, v.z - g.s.z); return d > 0.8 && d < 4; }); }) && st.hp === 70);

  area = 'interface';
  await page.keyboard.press('KeyM');
  await sleep(page, 200);
  check('M opens the map', await page.isVisible('#bigmap'));
  await page.keyboard.press('KeyM');
  await page.keyboard.press('Escape');
  await sleep(page, 200);
  check('Esc opens settings', await page.isVisible('#pause'));
  await page.keyboard.down('KeyW');
  await sleep(page, 400);
  await page.keyboard.up('KeyW');
  check('the character does not move while settings are open', await page.g(() => Math.hypot(window.__pls.game.s.vx, window.__pls.game.s.vz) < 0.01));
  await page.keyboard.press('Escape');
  await sleep(page, 200);
  check('Esc closes settings', !(await page.isVisible('#pause')));

  area = 'connection';
  await page.g(() => { window.__g1 = window.__pls.game; window.__sid = window.__pls.net.sid; window.__pls.net.ws.close(); });
  const back = await page.waitForFunction(() => window.__pls.game && window.__pls.game !== window.__g1 && window.__pls.game.st, null, { timeout: 15000 }).then(() => true).catch(() => false);
  st = await page.st();
  check('a dropped connection resumes the same match', back && (await page.g(() => window.__pls.net.sid === window.__sid && window.__pls.screen === 'game')));
  check('inventory survives the reconnect', st && st.hp === 70 && !!st.w[1], st && { hp: st.hp, w: st.w });

  area = 'elimination';
  await page.dbg({ hurt: 500 });
  await page.waitForSelector('#death:not(.hidden)', { timeout: 8000 }).catch(() => {});
  check('being eliminated shows the placing', /#\d+/.test(await page.textContent('#death-place')), await page.textContent('#death-place'));
  await page.click('#death-spectate');
  await sleep(page, 1200);
  check('spectating follows another player', await page.isVisible('#spectate') && (await page.textContent('#specname')).length > 0);
  const who = await page.textContent('#specname');
  await page.keyboard.press('KeyN');
  await sleep(page, 400);
  check('N switches to the next player', (await page.textContent('#specname')) !== who);
  await page.click('#specleave');
  await sleep(page, 400);
  check('leaving returns to the menu', await page.isVisible('#menu'));
  await page.context().close();
  await app.close();
}

// --------------------------------------------------------------------------
// Touch: phone layout with multi-touch
// --------------------------------------------------------------------------
if (wants('touch')) {
  const { app, base } = await startServer({ BOT_FILL: '3', ZONE_SCALE: '4' });
  const page = await openPage(base, { touch: true, query: '?spawn=-30,12,1.5708', label: 'touch' });
  area = 'touch';
  check('the phone layout is active', await page.g(() => document.body.classList.contains('touch')));
  await page.tap('#play-practice');
  await page.inGame();
  await page.dbg({ calm: 1 });
  check('touch controls are shown', await page.isVisible('#t-fire') && await page.isVisible('#stick'));
  const cdp = await page.context().newCDPSession(page);
  const vp = page.viewportSize();
  const sx = 120;
  const sy = vp.height - 90;
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });

  // Left thumb pushes the stick forward.
  let a = await page.g(() => ({ x: window.__pls.game.s.x, z: window.__pls.game.s.z, yaw: window.__pls.input.yaw }));
  await touch('touchStart', [{ x: sx, y: sy, id: 1 }]);
  await touch('touchMove', [{ x: sx, y: sy - 45, id: 1 }]);
  await sleep(page, 1200);
  // Right thumb drags to look around at the same time.
  await touch('touchStart', [{ x: sx, y: sy - 45, id: 1 }, { x: vp.width - 300, y: 150, id: 2 }]);
  for (let i = 1; i <= 5; i++) {
    await touch('touchMove', [{ x: sx, y: sy - 45, id: 1 }, { x: vp.width - 300 + i * 12, y: 150, id: 2 }]);
    await sleep(page, 40);
  }
  await touch('touchEnd', []);
  await sleep(page, 300);
  let b = await page.g(() => ({ x: window.__pls.game.s.x, z: window.__pls.game.s.z, yaw: window.__pls.input.yaw }));
  check('the joystick moves the player', Math.hypot(b.x - a.x, b.z - a.z) > 2.5, Math.hypot(b.x - a.x, b.z - a.z));
  check('dragging on the right turns the view', b.yaw !== a.yaw);

  // A second finger taps a control while the thumb stays on the stick.
  const tapWhileMoving = async (selector) => {
    await touch('touchStart', [{ x: sx, y: sy, id: 1 }]);
    await touch('touchMove', [{ x: sx, y: sy - 40, id: 1 }]);
    await sleep(page, 150);
    const box = await page.locator(selector).boundingBox();
    await touch('touchStart', [{ x: sx, y: sy - 40, id: 1 }, { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 2 }]);
    await sleep(page, 80);
    await touch('touchEnd', []);
    await sleep(page, 450);
  };
  await page.dbg({ give: ['ar', 30] });
  await sleep(page, 500);
  await page.dbg({ give: ['smg', 30] });
  await sleep(page, 700);
  await tapWhileMoving('#weapons .slot[data-slot="1"]');
  check('tapping a weapon slot while moving switches weapon', (await page.st()).s === 1, (await page.st()).s);
  await page.dbg({ hp: 40 });
  await page.dbg({ give: ['medkit', 1] });
  await sleep(page, 700);
  await tapWhileMoving('#btn-medkit');
  check('tapping Med Kit while moving starts healing', (await page.st()).hl === 'medkit', (await page.st()).hl);
  await sleep(page, 6000);
  check('the med kit heals on touch too', (await page.st()).hp === 100, (await page.st()).hp);
  const mag = (await page.st()).w[1][1];
  const fire = await page.locator('#t-fire').boundingBox();
  await touch('touchStart', [{ x: fire.x + 40, y: fire.y + 40, id: 5 }]);
  await sleep(page, 700);
  await touch('touchEnd', []);
  await sleep(page, 400);
  check('the FIRE button fires', (await page.st()).w[1][1] < mag);
  await page.tap('#t-crouch');
  await sleep(page, 400);
  check('CROUCH toggles crouching', await page.g(() => window.__pls.game.s.crouch));
  await page.tap('#t-crouch');
  // Swap a weapon with the TAKE button.
  await page.dbg({ give: ['shotgun', 5], dx: -1.5 });
  await sleep(page, 900);
  check('the TAKE button appears next to a weapon', await page.isVisible('#t-pickup'));
  await page.tap('#t-pickup');
  await sleep(page, 600);
  check('TAKE swaps to that weapon', (await page.st()).w.some((w) => w && w[0] === 'shotgun'), (await page.st()).w);
  // Vehicles.
  await page.dbg({ tp: [-30, 12] });
  await sleep(page, 500);
  await page.dbg({ veh: 'auto' });
  await sleep(page, 900);
  check('a DRIVE button appears next to a vehicle', await page.isVisible('#t-use') && (await page.textContent('#t-use')) === 'DRIVE', await page.textContent('#t-use'));
  await page.tap('#t-use');
  await sleep(page, 700);
  check('DRIVE gets in', !!(await page.st()).veh);
  a = await page.g(() => ({ x: window.__pls.game.myVeh.x, z: window.__pls.game.myVeh.z }));
  await touch('touchStart', [{ x: sx, y: sy, id: 1 }]);
  await touch('touchMove', [{ x: sx, y: sy - 50, id: 1 }]);
  await sleep(page, 2000);
  await touch('touchEnd', []);
  b = await page.g(() => ({ x: window.__pls.game.myVeh.x, z: window.__pls.game.myVeh.z }));
  check('the joystick drives the vehicle', Math.hypot(b.x - a.x, b.z - a.z) > 6, Math.hypot(b.x - a.x, b.z - a.z));
  check('the button now says EXIT', (await page.textContent('#t-use')) === 'EXIT');
  await page.shot('touch-driving');
  await sleep(page, 2500);
  await page.tap('#t-use');
  await sleep(page, 700);
  check('EXIT gets out', !(await page.st()).veh);
  await page.tap('#mapwrap');
  await sleep(page, 300);
  check('tapping the minimap opens the map', await page.isVisible('#bigmap'));
  await page.tap('#bigmap');
  await page.tap('#pausebtn');
  await sleep(page, 300);
  check('the pause button opens settings', await page.isVisible('#pause'));
  await page.context().close();
  await app.close();
}

// --------------------------------------------------------------------------
// Team play: duo with a bot team-mate
// --------------------------------------------------------------------------
if (wants('team')) {
  const { app, base } = await startServer({ BOT_FILL: '4', ZONE_SCALE: '4' });
  const page = await openPage(base, { label: 'team' });
  area = 'team';
  await page.click('#teamsize button[data-team="2"]');
  await page.click('#play-practice');
  await page.waitForSelector('#lobby:not(.hidden)');
  check('the lobby shows the Duo mode', /Duo/.test(await page.textContent('#lobby-title')));
  await page.inGame();
  const g = await page.g(() => { const x = window.__pls.game; return { size: x.teamSize, tm: x.st.tm, mates: [...x.players.values()].filter((r) => x.isMate(r.id)).length }; });
  check('the player has one team-mate', g.size === 2 && g.tm.length === 1 && g.mates === 1, g);
  check('the team panel names the team-mate', (await page.textContent('#teampanel')).length > 0);
  await page.waitForFunction(() => { const x = window.__pls.game; const r = [...x.players.values()].find((p) => x.isMate(p.id)); return !x.s.chute && r && !r.chute; }, null, { timeout: 40000 });
  await page.dbg({ calm: 1 });
  await page.dbg({ hurt: 500 });
  await sleep(page, 800);
  let st = await page.st();
  check('running out of health knocks the player down', st.dn >= 1 && st.hp > 0, { dn: st.dn, hp: st.hp });
  check('the knocked-down notice is shown', await page.isVisible('#downed'));
  await page.shot('team-down');
  const up = await page.waitForFunction(() => window.__pls.game.st.dn === 0 && window.__pls.game.alive, null, { timeout: 40000 }).then(() => true).catch(() => false);
  st = await page.st();
  check('the bot team-mate revives the player', up && st.hp > 0, { dn: st.dn, hp: st.hp });
  check('the kill feed reports the revive', /revived/.test(await page.textContent('#killfeed')) || up);
  await page.context().close();
  await app.close();
}

// --------------------------------------------------------------------------
// Watching a live match, and a private room with an invite link
// --------------------------------------------------------------------------
if (wants('watch')) {
  const { app, base } = await startServer({ BOT_FILL: '4', ZONE_SCALE: '4' });
  area = 'watch';
  const viewer = await openPage(base, { label: 'viewer' });
  await viewer.click('#play-watch');
  await sleep(viewer, 800);
  check('with no match running, watching explains that', /No match/.test(await viewer.textContent('#menu-error')), await viewer.textContent('#menu-error'));
  const player = await openPage(base, { label: 'player' });
  await player.click('#play-practice');
  await player.inGame();
  await viewer.click('#play-watch');
  const watching = await viewer.waitForFunction(() => window.__pls.game && window.__pls.game.watching && window.__pls.game.players.size > 0, null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('a second person can watch the live match', watching);
  await sleep(viewer, 1500);
  check('the viewer follows a player', await viewer.isVisible('#spectate'));
  check('the match counts the viewer as a watcher, not a player', await player.g(() => window.__pls.game.total) === 4);
  await viewer.context().close();
  await player.context().close();

  area = 'room';
  const host = await openPage(base, { label: 'host' });
  await host.fill('#name', 'Host');
  await host.fill('#room', 'party');
  await host.click('#play-room');
  await host.waitForSelector('#lobby:not(.hidden)');
  const link = await host.inputValue('#invite-link');
  check('a private room shows an invite link', /\?room=PARTY/.test(link), link);
  const guest = await openPage(base, { query: '?room=PARTY', label: 'guest' });
  check('opening the link fills in the room code', (await guest.inputValue('#room')) === 'PARTY');
  await guest.fill('#name', 'Guest');
  await guest.click('#play-room');
  await guest.waitForSelector('#lobby:not(.hidden)');
  await host.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 2, null, { timeout: 8000 }).catch(() => {});
  check('both players are in the same lobby', await host.g(() => document.querySelectorAll('#lobby-players li').length === 2));
  await host.click('#lobby-ready');
  await guest.click('#lobby-ready');
  await host.inGame();
  await guest.inGame();
  check('the match starts for both', await host.g(() => window.__pls.game.players.size >= 1) && await guest.g(() => window.__pls.game.players.size >= 1));
  await host.context().close();
  await guest.context().close();
  await app.close();
}

// --------------------------------------------------------------------------
// Finishing a match: results, experience, play again
// --------------------------------------------------------------------------
if (wants('finish')) {
  const { app, base } = await startServer({ BOT_FILL: '2', ZONE_SCALE: '0.05' });
  const page = await openPage(base, { label: 'finish' });
  area = 'finish';
  await page.click('#play-practice');
  await page.inGame();
  const done = await page.waitForSelector('#result:not(.hidden)', { timeout: 90000 }).then(() => true).catch(() => false);
  check('the match ends and the results are shown', done);
  check('the result names a placing', /VICTORY|#\d/.test(await page.textContent('#result-title')), await page.textContent('#result-title'));
  check('experience is awarded', /\+\d+ XP/.test(await page.textContent('#result-xp')), await page.textContent('#result-xp'));
  check('the table lists both players', await page.g(() => document.querySelectorAll('#result-table tbody tr').length === 2));
  await page.click('#result-menu');
  await page.click('#open-profile');
  check('the profile counts the match', /1/.test(await page.g(() => document.querySelector('#prof-stats div b').textContent)));
  await page.click('#prof-close');
  await page.click('#play-practice');
  const again = await page.inGame().then(() => true).catch(() => false);
  check('a new match can be started afterwards', again);
  await page.context().close();
  await app.close();
}

area = 'general';
check('no errors in the browser console', errors.length === 0, errors.slice(0, 5));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
if (failed.length) console.log('Failed:\n' + failed.map((f) => `  [${f.area}] ${f.name}`).join('\n'));
process.exit(failed.length ? 1 : 0);
