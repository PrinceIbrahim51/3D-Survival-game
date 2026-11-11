// Application shell: renderer, menus, lobby, and the hand-off to a Game for
// the duration of each match.

import * as THREE from 'three';
import { getWorld } from '/shared/world.js';
import { buildWorldScene } from './scene.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { GameAudio } from './audio.js';
import { Game } from './game.js';
import { causeText } from './hud.js';

const $ = (id) => document.getElementById(id);
const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// ------------------------------------------------------------------ settings
const defaults = { sens: 1, vol: 0.7, quality: isTouch ? 'low' : 'medium', invert: false, name: '', room: '' };
let settings = { ...defaults };
try {
  settings = { ...defaults, ...JSON.parse(localStorage.getItem('pls-settings') || '{}') };
} catch { /* private mode: keep defaults */ }
function saveSettings() {
  try {
    localStorage.setItem('pls-settings', JSON.stringify(settings));
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ renderer
const canvas = $('view');
const quality = ['low', 'medium', 'high'].includes(settings.quality) ? settings.quality : 'medium';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance' });
const pixelRatio = () => Math.min(window.devicePixelRatio || 1, quality === 'low' ? 1 : quality === 'medium' ? 1.5 : 2);
renderer.setPixelRatio(pixelRatio());
renderer.shadowMap.enabled = quality !== 'low';
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcfe6ef, quality === 'low' ? 90 : 130, quality === 'low' ? 380 : 520);
const camera = new THREE.PerspectiveCamera(68, 1, 0.1, 2000);

const world = getWorld();
const worldView = buildWorldScene(world, renderer, quality);
scene.add(worldView.group);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
resize();

// ------------------------------------------------------------------- systems
const net = new Net();
const input = new Input(canvas, settings);
const hud = new Hud(worldView.mapCanvas);
const audio = new GameAudio();
audio.setVolume(settings.vol);

const app = {
  scene, camera, renderer, world, worldView, net, input, hud, audio, settings,
  game: null,
  screen: 'menu',
  mode: 'quick',
  showPause,
};
window.__pls = app; // handy for debugging and automated smoke tests

document.body.classList.toggle('touch', isTouch);

function setScreen(name) {
  app.screen = name;
  $('menu').classList.toggle('hidden', name !== 'menu');
  $('lobby').classList.toggle('hidden', name !== 'lobby');
  $('result').classList.toggle('hidden', name !== 'result');
  $('death').classList.add('hidden');
  $('pause').classList.add('hidden');
  $('banner').classList.add('hidden');
  const playing = name === 'game';
  hud.show(playing);
  $('touch').classList.toggle('hidden', !(playing && isTouch));
  document.body.classList.toggle('ingame', playing);
  input.enabled = playing;
  if (!playing) input.unlock();
}

function endGame() {
  if (app.game) {
    app.game.dispose();
    app.game = null;
  }
}

function toMenu(error) {
  endGame();
  setScreen('menu');
  $('menu-error').textContent = error || '';
}

function leaveMatch() {
  net.send({ t: 'leave' });
  toMenu();
}

function showPause(on) {
  if (app.screen !== 'game') return;
  if (on && !$('death').classList.contains('hidden')) return;
  $('pause').classList.toggle('hidden', !on);
  if (on) input.unlock();
  else input.lock();
}

function join(mode) {
  audio.unlock();
  audio.ui('click');
  if (!net.connected) {
    $('menu-error').textContent = 'Not connected to the server yet. Please wait a moment.';
    return;
  }
  settings.name = $('name').value.trim();
  settings.room = $('room').value.trim().toUpperCase();
  saveSettings();
  if (mode === 'room' && !/^[A-Z0-9]{3,12}$/.test(settings.room)) {
    $('menu-error').textContent = 'Enter a room code of 3-12 letters or digits and share it with friends.';
    return;
  }
  $('menu-error').textContent = '';
  app.mode = mode;
  // ?spawn=x,z,yaw only has an effect on servers started with DEBUG_SPAWN=1.
  const dbg = new URLSearchParams(location.search).get('spawn');
  net.send({ t: 'join', name: settings.name, mode, room: settings.room, spawn: dbg ? dbg.split(',').map(Number) : undefined });
  if (isTouch) {
    // Phones: go fullscreen landscape when the browser allows it.
    const el = document.documentElement;
    const p = el.requestFullscreen ? el.requestFullscreen() : null;
    if (p && p.catch) p.catch(() => {});
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  }
}

// ------------------------------------------------------------- menu wiring
$('name').value = settings.name;
$('room').value = settings.room;
$('play-quick').addEventListener('click', () => join('quick'));
$('play-practice').addEventListener('click', () => join('practice'));
$('play-room').addEventListener('click', () => join('room'));
$('name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join('quick');
});
$('room').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join('room');
});

$('lobby-ready').addEventListener('click', () => {
  audio.unlock();
  audio.ui('click');
  net.send({ t: 'ready', v: !app.ready });
});
$('lobby-leave').addEventListener('click', leaveMatch);
$('death-spectate').addEventListener('click', () => {
  $('death').classList.add('hidden');
  input.lock();
});
$('death-leave').addEventListener('click', leaveMatch);
$('result-again').addEventListener('click', () => join(app.mode));
$('result-menu').addEventListener('click', () => toMenu());
$('pause-resume').addEventListener('click', () => showPause(false));
$('pause-leave').addEventListener('click', leaveMatch);
$('pausebtn').addEventListener('click', () => showPause(true));
$('specnext').addEventListener('click', () => app.game && app.game.nextSpectate());
$('specleave').addEventListener('click', leaveMatch);
$('mapwrap').addEventListener('click', () => hud.toggleMap());
$('bigmap').addEventListener('click', () => hud.toggleMap(false));
for (const el of document.querySelectorAll('#weapons .slot')) {
  el.addEventListener('click', () => input.act('slot', { n: Number(el.dataset.slot) }));
}
for (const el of document.querySelectorAll('#belt [data-heal]')) {
  el.addEventListener('click', () => input.act('heal', { k: el.dataset.heal }));
}

$('set-sens').value = settings.sens;
$('set-vol').value = settings.vol;
$('set-quality').value = quality;
$('set-invert').checked = settings.invert;
$('set-sens').addEventListener('input', (e) => {
  settings.sens = Number(e.target.value);
  saveSettings();
});
$('set-vol').addEventListener('input', (e) => {
  settings.vol = Number(e.target.value);
  audio.setVolume(settings.vol);
  saveSettings();
});
$('set-invert').addEventListener('change', (e) => {
  settings.invert = e.target.checked;
  saveSettings();
});
$('set-quality').addEventListener('change', (e) => {
  settings.quality = e.target.value;
  saveSettings();
  hud.announce('Graphics quality will change the next time the page loads', 3500);
});

// --------------------------------------------------------------- networking
net.on('open', () => {
  $('conn').textContent = 'Connected to server';
  $('conn').classList.add('ok');
});
net.on('close', (was) => {
  $('conn').textContent = 'Connecting to server...';
  $('conn').classList.remove('ok');
  if (was && app.screen !== 'menu' && app.screen !== 'result') toMenu('Connection to the server was lost.');
});
net.on('error', (m) => {
  if (app.screen === 'menu' || app.screen === 'result') {
    setScreen('menu');
    $('menu-error').textContent = String(m.msg || 'Something went wrong.');
  }
});

net.on('lobby', (m) => {
  if (app.game) endGame();
  if (app.screen !== 'lobby') setScreen('lobby');
  app.ready = m.ready;
  const titles = { quick: 'Quick Match', practice: 'Practice', room: 'Private Room ' + (m.room || '') };
  $('lobby-title').textContent = titles[m.mode] || 'Lobby';
  const humans = m.players.length;
  $('lobby-sub').textContent = m.mode === 'practice'
    ? `You against ${m.fillTo - 1} bots.`
    : `${humans} of ${m.max} players${m.bots ? ', bots fill up to ' + m.fillTo : ''}. Ready up to start sooner.`;
  $('lobby-count').textContent = m.startsIn === null ? '' : m.startsIn > 0 ? 'Starts in ' + m.startsIn : 'Starting...';
  const list = $('lobby-players');
  list.textContent = '';
  let meMarked = false;
  for (const p of m.players) {
    const li = document.createElement('li');
    li.textContent = p.name;
    if (!meMarked && p.name === m.you && p.ready === m.ready) {
      li.classList.add('me');
      meMarked = true;
    }
    const em = document.createElement('em');
    em.textContent = p.ready ? 'READY' : '';
    li.append(em);
    list.append(li);
  }
  $('lobby-ready').textContent = m.ready ? 'Not ready' : 'Ready';
});

net.on('start', (m) => {
  endGame();
  app.mode = m.mode || app.mode;
  setScreen('game');
  app.game = new Game(app, m);
  if (!isTouch) hud.announce('Click to capture the mouse. Steer your parachute with WASD', 5000);
});

net.on('s', (m) => {
  if (app.game) app.game.onSnapshot(m);
});

net.on('dead', (m) => {
  if (!app.game) return;
  $('death-place').textContent = '';
  $('death-place').append('#' + m.place);
  const small = document.createElement('small');
  small.textContent = ' of ' + m.total;
  $('death-place').append(small);
  $('death-by').textContent = m.killer ? `${m.killer} got you ${causeText(m.cause)}` : m.cause === 'zone' ? 'The zone got you.' : 'You are out.';
  $('death-stats').textContent = `${m.kills} kill${m.kills === 1 ? '' : 's'}  -  ${m.damage} damage dealt`;
  $('pause').classList.add('hidden');
  hud.toggleMap(false);
  $('death').classList.remove('hidden');
  input.unlock();
});

net.on('end', (m) => {
  const game = app.game;
  if (!game) return;
  game.ended = true;
  const won = m.you && m.you.place === 1;
  $('death').classList.add('hidden');
  $('pause').classList.add('hidden');
  input.unlock();
  const banner = $('banner');
  banner.querySelector('h1').textContent = won ? 'VICTORY' : 'MATCH OVER';
  banner.querySelector('p').textContent = won ? 'You are the last one standing!' : (m.winner ? m.winner.name + ' is the last one standing' : '');
  banner.classList.remove('hidden');
  audio.ui(won ? 'win' : 'click');
  clearTimeout(app.resultTimer);
  app.resultTimer = setTimeout(() => {
    if (app.game !== game) return;
    endGame();
    setScreen('result');
    const title = $('result-title');
    title.textContent = won ? 'VICTORY' : m.you ? `#${m.you.place} of ${m.total}` : 'Match over';
    title.className = won ? 'good' : '';
    $('result-sub').textContent = m.you
      ? `${m.you.kills} kill${m.you.kills === 1 ? '' : 's'}  -  ${m.you.damage} damage dealt` + (won ? '' : m.winner ? `  -  winner: ${m.winner.name}` : '')
      : '';
    const body = document.querySelector('#result-table tbody');
    body.textContent = '';
    for (const r of m.rows) {
      const tr = document.createElement('tr');
      if (m.you && r.id === m.you.id) tr.classList.add('me');
      const cells = [r.place, r.name, r.kills, r.damage];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        td.textContent = c;
        if (i === 1 && r.bot) {
          const tag = document.createElement('i');
          tag.textContent = 'BOT';
          td.append(tag);
        }
        tr.append(td);
      });
      body.append(tr);
    }
  }, won ? 4200 : 2800);
});

net.connect();

// ------------------------------------------------------------------ main loop
let last = performance.now();
let menuAngle = 0.6;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (app.game) {
    app.game.frame(dt);
  } else {
    // Slow fly-around of the island behind the menus.
    menuAngle += dt * 0.035;
    const r = 215;
    camera.position.set(Math.cos(menuAngle) * r, 78, Math.sin(menuAngle) * r);
    camera.lookAt(0, 6, 0);
    worldView.follow(Math.cos(menuAngle) * 60, 4, Math.sin(menuAngle) * 60);
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// Keep the screen awake on phones while playing, where supported.
if (navigator.wakeLock) {
  const wake = () => navigator.wakeLock.request('screen').catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wake();
  });
  window.addEventListener('pointerdown', wake, { once: true });
}
