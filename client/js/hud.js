// Heads-up display: all DOM, updated only when values change.

import { WORLD_SIZE, WORLD_HALF, MAX_HP } from '/shared/constants.js';
import { WEAPONS, ARMOR, MELEE, ITEMS, ATTACHMENTS } from '/shared/items.js';
import { POIS } from '/shared/world.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor(mapCanvas) {
    this.mapCanvas = mapCanvas;
    this.el = $('hud');
    this.mini = $('minimap').getContext('2d');
    this.big = $('bigmapcanvas').getContext('2d');
    this.bigOpen = false;
    this.cache = {};
    this.slots = Array.from(document.querySelectorAll('#weapons .slot'));
    this.announceTimer = 0;
    this.hitTimer = 0;
    this.dmgTimer = 0;
    this.dmgAngle = 0;
    this.hurt = 0;
    this.progress = null; // { text, start, dur }
  }

  show(on) {
    this.el.classList.toggle('hidden', !on);
    if (!on) this.toggleMap(false);
  }

  set(id, prop, value) {
    const key = id + '.' + prop;
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    const el = $(id);
    if (prop === 'text') el.textContent = value;
    else if (prop === 'width') el.style.width = value;
    else if (prop === 'opacity') el.style.opacity = value;
    else el.classList.toggle(prop, !!value);
  }

  setCounts(alive, kills, ping) {
    this.set('alive', 'text', String(alive));
    this.set('kills', 'text', String(kills));
    this.set('ping', 'text', ping === null || ping === undefined ? '--' : String(Math.max(1, ping)));
  }

  // st is the private state sent by the server.
  setState(st) {
    this.set('hpbar', 'width', (st.hp / MAX_HP) * 100 + '%');
    this.set('hpbar', 'low', st.hp <= 30);
    this.set('hptext', 'text', String(st.hp));
    const maxArmor = st.al ? ARMOR[st.al].points : 100;
    this.set('armorbar', 'width', (st.ar / maxArmor) * 100 + '%');
    this.set('n-bandage', 'text', String(st.bd));
    this.set('n-medkit', 'text', String(st.mk));
    this.set('btn-bandage', 'empty', st.bd === 0);
    this.set('btn-medkit', 'empty', st.mk === 0);
    this.set('n-pack', 'text', st.bp ? 'L' + st.bp : '-');
    this.set('n-grenade', 'text', String(st.gr));
    this.set('n-smoke', 'text', String(st.sm));
    this.set('btn-grenade', 'empty', st.gr === 0);
    this.set('btn-smoke', 'empty', st.sm === 0);
    const ammo = { light: st.am[0], rifle: st.am[1], shell: st.am[2], sniper: st.am[3] };
    const key = JSON.stringify([st.w, st.s, st.am]);
    if (this.cache.weapons !== key) {
      this.cache.weapons = key;
      this.slots.forEach((el, i) => {
        const name = el.querySelector('.wname');
        const am = el.querySelector('.wammo');
        el.classList.toggle('active', st.s === i);
        if (i === 2) {
          name.textContent = MELEE.name;
          am.textContent = '';
          return;
        }
        const w = st.w[i];
        el.classList.toggle('empty', !w);
        if (!w) {
          name.textContent = 'Empty';
          am.textContent = '';
        } else {
          const def = WEAPONS[w[0]];
          name.textContent = def.name;
          // Fitted attachments, e.g. "MAG  SCOPE".
          const tags = Object.values(ATTACHMENTS).filter((a) => w[2] & a.bit).map((a) => a.tag).join('  ');
          if (tags) {
            const t = document.createElement('span');
            t.className = 'watt';
            t.textContent = tags;
            name.append(t);
          }
          am.textContent = '';
          am.append(String(w[1]));
          const small = document.createElement('small');
          small.textContent = ' / ' + ammo[def.ammo];
          am.append(small);
        }
      });
    }
  }

  setZone(text, frac, alert) {
    this.set('zonetext', 'text', text);
    this.set('zoneinfo', 'alert', alert);
    const w = Math.round(frac * 100) + '%';
    if (this.cache.zonebar !== w) {
      this.cache.zonebar = w;
      document.querySelector('#zonebar i').style.width = w;
    }
  }

  announce(text, ms = 2600) {
    const el = $('announce');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // parts: [killerName | null, victimName, causeText, mine]
  killFeed(killer, victim, cause, mine) {
    const feed = $('killfeed');
    const row = document.createElement('div');
    if (mine) row.classList.add('mine');
    const i = document.createElement('i');
    i.textContent = cause;
    if (killer) {
      const b = document.createElement('b');
      b.textContent = killer;
      row.append(b, ' ', i, ' ', victim);
    } else {
      row.append(victim, ' ', i);
    }
    feed.append(row);
    while (feed.children.length > 5) feed.firstChild.remove();
    setTimeout(() => row.remove(), 6200);
  }

  pickupLog(kind, n) {
    const info = ITEMS[kind];
    if (!info) return;
    const log = $('pickuplog');
    const row = document.createElement('div');
    row.textContent = '+ ' + info.name;
    log.append(row);
    while (log.children.length > 3) log.firstChild.remove();
    setTimeout(() => row.remove(), 2400);
  }

  hitMarker(kind) {
    const el = $('hitmarker');
    el.className = kind === 'hit' ? '' : kind;
    el.style.opacity = 1;
    this.hitTimer = kind === 'kill' ? 0.5 : 0.22;
  }

  damageFrom(angle) {
    this.dmgAngle = angle;
    this.dmgTimer = 1.2;
    this.hurt = 1;
  }

  setCrosshair(gap, visible) {
    const g = Math.round(gap);
    if (this.cache.gap !== g) {
      this.cache.gap = g;
      $('crosshair').style.setProperty('--gap', g + 'px');
    }
    this.set('crosshair', 'hidden', !visible);
  }

  setScope(on) {
    this.set('scope', 'opacity', on ? 1 : 0);
  }

  setOutside(on) {
    this.set('zonewarn', 'opacity', on ? 1 : 0);
  }

  setPrompt(text, key = 'F') {
    const el = $('prompt');
    const cacheKey = text ? key + text : '';
    if (this.cache.prompt === cacheKey) return;
    this.cache.prompt = cacheKey;
    el.classList.toggle('hidden', !text);
    const pick = $('t-pickup');
    if (pick) pick.classList.toggle('hidden', !text);
    if (!text) return;
    el.textContent = '';
    if (key) {
      const b = document.createElement('b');
      b.textContent = key;
      el.append(b);
    }
    el.append(text);
  }

  startProgress(text, seconds) {
    this.progress = { text, start: performance.now(), dur: seconds * 1000 };
    $('progresstext').textContent = text;
    $('progress').classList.remove('hidden');
  }

  stopProgress() {
    if (!this.progress) return;
    this.progress = null;
    $('progress').classList.add('hidden');
  }

  setSpectate(name) {
    this.set('spectate', 'hidden', !name);
    this.set('bottom', 'hidden', !!name);
    this.set('weapons', 'hidden', !!name);
    if (name) this.set('specname', 'text', name);
  }

  toggleMap(force) {
    this.bigOpen = force ?? !this.bigOpen;
    $('bigmap').classList.toggle('hidden', !this.bigOpen);
  }

  drawMap(ctx, size, view, labels) {
    const s = size / WORLD_SIZE;
    const px = (x) => (x + WORLD_HALF) * s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.mapCanvas, 0, 0, size, size);
    const { circle, next, me, others } = view;
    if (circle) {
      // Tint everything outside the safe circle.
      ctx.fillStyle = 'rgba(110, 70, 255, 0.34)';
      ctx.beginPath();
      ctx.rect(0, 0, size, size);
      ctx.arc(px(circle.x), px(circle.z), Math.max(0, circle.r * s), 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.lineWidth = Math.max(1.5, size / 150);
      ctx.strokeStyle = '#b79bff';
      ctx.beginPath();
      ctx.arc(px(circle.x), px(circle.z), Math.max(0, circle.r * s), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (next && next.r > 0.5) {
      ctx.lineWidth = Math.max(1, size / 220);
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([size / 60, size / 90]);
      ctx.beginPath();
      ctx.arc(px(next.x), px(next.z), next.r * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (labels) {
      ctx.font = `700 ${Math.round(size / 52)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      for (const p of POIS) {
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(p.name, px(p.x), px(p.z - p.r * 0.75));
        ctx.fillStyle = '#fff';
        ctx.fillText(p.name, px(p.x), px(p.z - p.r * 0.75));
      }
    }
    if (others) {
      ctx.fillStyle = '#ffd24a';
      for (const o of others) {
        ctx.beginPath();
        ctx.arc(px(o.x), px(o.z), size / 90, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (me) {
      const a = size / 34;
      ctx.translate(px(me.x), px(me.z));
      ctx.rotate(-me.yaw);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#111';
      ctx.lineWidth = Math.max(1, size / 200);
      ctx.beginPath();
      ctx.moveTo(0, -a);
      ctx.lineTo(a * 0.7, a * 0.8);
      ctx.lineTo(0, a * 0.4);
      ctx.lineTo(-a * 0.7, a * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  // Per-frame animation of timers plus map drawing (maps at a reduced rate).
  update(dt, view) {
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) $('hitmarker').style.opacity = 0;
    }
    if (this.dmgTimer > 0) {
      this.dmgTimer -= dt;
      const el = $('dmgdir');
      el.style.opacity = Math.max(0, Math.min(1, this.dmgTimer));
      el.style.transform = `rotate(${this.dmgAngle}rad)`;
    }
    if (this.hurt > 0) {
      this.hurt = Math.max(0, this.hurt - dt * 1.6);
      $('vignette').style.opacity = this.hurt;
    }
    if (this.progress) {
      const k = (performance.now() - this.progress.start) / this.progress.dur;
      document.querySelector('#progress i').style.width = Math.min(100, k * 100) + '%';
      if (k >= 1.15) this.stopProgress();
    }
    this.mapClock = (this.mapClock || 0) + dt;
    if (this.mapClock > 0.1) {
      this.mapClock = 0;
      this.drawMap(this.mini, 220, view, false);
      if (this.bigOpen) this.drawMap(this.big, 720, view, true);
    }
  }
}

export function causeText(cause) {
  if (cause === 'zone') return 'lost to the zone';
  if (cause === 'left') return 'left the match';
  if (cause === 'fists') return 'knocked out';
  if (cause === 'grenade') return 'blew up';
  const w = WEAPONS[cause];
  return w ? `[${w.name}]` : 'eliminated';
}

