// One match: lobby -> playing -> ended. The match owns every piece of
// authoritative state (movement, health, ammunition, inventory, loot, the safe
// zone and the result). Clients only send inputs and requests.

import { getWorld, WORLD_SEED } from '../shared/world.js';
import {
  stepPlayer, makeMoveState, raycastWorld, rayPlayer, floorAt, stepProjectile, projectileBlocked,
} from '../shared/physics.js';
import {
  TICK_DT, TICK_MS, INPUT_DT, BTN, BTN_MASK, PF, MAX_HP, PICKUP_RADIUS, INTERACT_RADIUS,
  MAX_REWIND_MS, CHUTE_ALTITUDE, CHUTE_FALL, eyeHeight, dirFromAngles,
} from '../shared/constants.js';
import {
  WEAPONS, WEAPON_KINDS, MELEE, HEAL, ITEMS, SWAP_TIME, BLOOM_DECAY, rollLoot, defaultAmount,
  ammoItemKind, THROW, THROW_SPEED, THROW_COOLDOWN, bloomScale,
} from '../shared/items.js';
import { createZone, startZone, updateZone, zoneCircleAt, insideCircle } from '../shared/zone.js';
import * as Inv from './inventory.js';
import { bulletDamage, applyDamage, spreadDegrees, spreadDirection, rankSimultaneous } from './combat.js';
import { Bot, BOT_NAMES } from './bot.js';

let nextMatchId = 1;
const LOOT_CELL = 4;
const HISTORY_TICKS = 20;
const MAX_QUEUE = 30;

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

class Player {
  constructor(id, name, client) {
    this.id = id;
    this.name = name;
    this.client = client;
    this.bot = !client;
    this.ai = null;
    this.s = makeMoveState();
    this.yaw = 0;
    this.pitch = 0;
    this.btn = 0;
    this.alive = true;
    this.hp = MAX_HP;
    this.inv = Inv.newInventory();
    this.clock = 0; // seconds of simulated input for this player
    this.nextFire = 0;
    this.nextThrow = 0;
    this.reloadEnd = 0;
    this.heal = null; // { kind, end }
    this.bloom = 0;
    this.kills = 0;
    this.damage = 0;
    this.place = 0;
    this.killer = null;
    this.cause = null;
    this.queue = [];
    this.budget = 0;
    this.ack = 0;
    this.lastSeq = 0;
    this.hist = [];
    this.events = [];
    this.lastState = '';
  }
}

export class Match {
  constructor(opts = {}) {
    this.id = nextMatchId++;
    this.opts = {
      mode: 'quick',
      room: null,
      maxPlayers: 16,
      fillTo: 12,
      bots: true,
      lobbySeconds: 20,
      readySeconds: 3,
      endSeconds: 15,
      zoneScale: 1,
      lootChance: 0.92,
      seed: WORLD_SEED,
      rnd: Math.random,
      ...opts,
    };
    this.rnd = this.opts.rnd;
    this.world = getWorld(this.opts.seed);
    this.state = 'waiting'; // waiting | playing | ended | closed
    this.clients = new Map();
    this.players = new Map();
    this.nextPlayerId = 1;
    this.tick = 0;
    this.time = 0;
    this.deadline = null; // wall-clock ms when the lobby countdown ends
    this.lastLobbySend = 0;
    this.loot = new Map();
    this.lootGrid = new Map();
    this.nextLootId = 1;
    this.zone = createZone(this.opts.zoneScale);
    this.circle = { x: 0, z: 0, r: this.zone.from.r };
    this.events = [];
    this.projectiles = []; // thrown grenades in flight
    this.smokes = []; // active smoke clouds: { x, y, z, r, until }
    this.nextProjId = 1;
    this.deadThisTick = [];
    this.aliveCount = 0;
    this.total = 0;
    this.winner = null;
    this.endAt = 0;
  }

  // ------------------------------------------------------------------ lobby

  get humanCount() {
    return this.clients.size;
  }

  canJoin() {
    return this.state === 'waiting' && this.clients.size < this.opts.maxPlayers;
  }

  addClient(client) {
    client.match = this;
    client.player = null;
    client.ready = false;
    this.clients.set(client.id, client);
    if (this.deadline === null) this.deadline = Date.now() + this.opts.lobbySeconds * 1000;
    if (this.clients.size >= this.opts.maxPlayers) this.deadline = Math.min(this.deadline, Date.now() + 3000);
    this.checkReady();
    this.sendLobby();
  }

  removeClient(client) {
    if (!this.clients.delete(client.id)) return;
    const p = client.player;
    client.match = null;
    client.player = null;
    if (p) {
      p.client = null;
      if (this.state === 'playing' && p.alive) this.kill(p, null, 'left');
    }
    if (this.clients.size === 0) {
      this.state = 'closed';
      return;
    }
    if (this.state === 'waiting') {
      this.checkReady();
      this.sendLobby();
    }
  }

  setReady(client, ready) {
    if (this.state !== 'waiting') return;
    client.ready = !!ready;
    this.checkReady();
    this.sendLobby();
  }

  checkReady() {
    let all = this.clients.size > 0;
    for (const c of this.clients.values()) if (!c.ready) all = false;
    if (all) this.deadline = Math.min(this.deadline ?? Infinity, Date.now() + this.opts.readySeconds * 1000);
  }

  sendLobby() {
    this.lastLobbySend = Date.now();
    const players = [];
    for (const c of this.clients.values()) players.push({ name: c.name, ready: c.ready });
    const startsIn = this.deadline === null ? null : Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
    for (const c of this.clients.values()) {
      c.send({
        t: 'lobby', mode: this.opts.mode, room: this.opts.room, players, startsIn,
        max: this.opts.maxPlayers, bots: this.opts.bots, fillTo: this.opts.fillTo, you: c.name, ready: c.ready,
      });
    }
  }

  // Called by the server loop at TICK_RATE.
  update() {
    if (this.state === 'waiting') {
      const now = Date.now();
      if (this.deadline !== null && now >= this.deadline) {
        // A match needs at least two players (humans or bots) to mean anything.
        const total = this.opts.bots ? Math.max(this.clients.size, this.opts.fillTo) : this.clients.size;
        if (total >= 2) this.start();
        else {
          this.deadline = null;
          this.sendLobby();
        }
      } else if (now - this.lastLobbySend >= 1000) this.sendLobby();
    } else if (this.state === 'playing') {
      this.step();
    } else if (this.state === 'ended' && Date.now() >= this.endAt) {
      this.close();
    }
  }

  close() {
    for (const c of this.clients.values()) {
      c.match = null;
      c.player = null;
    }
    this.clients.clear();
    this.state = 'closed';
  }

  // ------------------------------------------------------------------ start

  start() {
    this.state = 'playing';
    this.tick = 0;
    this.time = 0;
    for (const c of this.clients.values()) {
      const p = new Player(this.nextPlayerId++, c.name, c);
      c.player = p;
      this.players.set(p.id, p);
    }
    if (this.opts.bots) {
      const names = BOT_NAMES.slice();
      while (this.players.size < this.opts.fillTo) {
        const i = Math.floor(this.rnd() * names.length);
        const name = names.splice(i, 1)[0] || 'Bot ' + this.nextPlayerId;
        const p = new Player(this.nextPlayerId++, name, null);
        this.players.set(p.id, p);
      }
    }
    this.total = this.players.size;
    this.aliveCount = this.total;

    const spawns = this.pickSpawns(this.total);
    let i = 0;
    for (const p of this.players.values()) {
      const sp = spawns[i++];
      p.s.x = sp.x;
      p.s.z = sp.z;
      p.s.y = Math.max(0, this.world.heightAt(sp.x, sp.z)) + CHUTE_ALTITUDE;
      p.s.vy = -CHUTE_FALL;
      p.s.chute = true;
      // Face the middle of the island.
      p.yaw = Math.atan2(sp.x, sp.z);
      // Development aid (server started with DEBUG_SPAWN=1): put a human
      // straight on the ground at a requested spot.
      const dbg = !p.bot && p.client.debugSpawn;
      if (dbg) {
        p.s.x = dbg[0];
        p.s.z = dbg[1];
        p.s.y = floorAt(this.world, dbg[0], dbg[1], 500);
        p.s.vy = 0;
        p.s.chute = false;
        p.yaw = dbg[2] || 0;
      }
      if (p.bot) p.ai = new Bot(this, p);
    }

    this.spawnLoot();
    startZone(this.zone, 0, this.rnd, this.world.isLand);
    zoneCircleAt(this.zone, 0, this.circle);

    for (const c of this.clients.values()) c.send(this.startMessage(c, false));
  }

  // Everything a client needs to (re)build the match on its side.
  startMessage(client, resume) {
    const p = client.player;
    const roster = [];
    for (const q of this.players.values()) roster.push([q.id, q.name, q.bot ? 1 : 0]);
    const loot = [];
    for (const it of this.loot.values()) loot.push([it.id, it.kind, r2(it.x), r2(it.y), r2(it.z), it.n, it.a]);
    const smokes = this.smokes.map((k) => [k.x, k.y, k.z, r2((k.until - this.time) / 1000)]);
    return {
      t: 'start', you: p.id, seed: this.opts.seed, total: this.total, players: roster, loot,
      zone: this.zone, spawn: [p.s.x, p.s.y, p.s.z, p.yaw], mode: this.opts.mode,
      resume, alive: p.alive, seq: p.lastSeq, chute: p.s.chute, smokes,
    };
  }

  // Brings a client that reconnected back up to date.
  resync(client) {
    if (this.state === 'waiting') {
      this.sendLobby();
    } else if (this.state === 'playing' && client.player) {
      client.player.lastState = '';
      client.send(this.startMessage(client, true));
      if (!client.player.alive) client.send(this.deadMessage(client.player));
    } else if (this.state === 'ended') {
      client.send(this.endMessage(client));
    } else {
      client.send({ t: 'idle' });
    }
  }

  pickSpawns(n) {
    const out = [];
    let minGap = 70;
    for (let attempts = 0; out.length < n && attempts < 4000; attempts++) {
      if (attempts % 400 === 399) minGap *= 0.7;
      const x = (this.rnd() * 2 - 1) * 135;
      const z = (this.rnd() * 2 - 1) * 135;
      if (x * x + z * z > 135 * 135 || this.world.heightAt(x, z) < 1) continue;
      if (out.some((o) => (o.x - x) ** 2 + (o.z - z) ** 2 < minGap * minGap)) continue;
      out.push({ x, z });
    }
    while (out.length < n) out.push({ x: (this.rnd() - 0.5) * 60, z: (this.rnd() - 0.5) * 60 });
    return out;
  }

  // ------------------------------------------------------------------- loot

  spawnLoot() {
    for (const sp of this.world.lootSpawns) {
      if (this.rnd() > this.opts.lootChance) continue;
      const kind = rollLoot(sp.tier, this.rnd);
      this.addLoot(kind, sp.x, sp.y, sp.z, defaultAmount(kind), null, true);
      if (ITEMS[kind].type === 'weapon') {
        const ammo = ammoItemKind(WEAPONS[kind].ammo);
        const x = sp.x + (this.rnd() - 0.5) * 1.2;
        const z = sp.z + (this.rnd() - 0.5) * 1.2;
        this.addLoot(ammo, x, floorAt(this.world, x, z, sp.y + 0.3), z, defaultAmount(ammo), null, true);
      }
    }
  }

  lootKey(x, z) {
    return (Math.floor(x / LOOT_CELL) + 512) * 1024 + (Math.floor(z / LOOT_CELL) + 512);
  }

  addLoot(kind, x, y, z, n, owner = null, silent = false, att = 0) {
    const it = {
      id: this.nextLootId++, kind, x, y, z, n, a: att | 0, by: owner ? owner.id : 0, until: owner ? this.time + 4000 : 0,
    };
    this.loot.set(it.id, it);
    const key = this.lootKey(x, z);
    let cell = this.lootGrid.get(key);
    if (!cell) this.lootGrid.set(key, (cell = new Set()));
    cell.add(it);
    if (!silent) this.events.push(['la', it.id, kind, r2(x), r2(y), r2(z), n, it.a]);
    return it;
  }

  removeLoot(it) {
    if (!this.loot.delete(it.id)) return;
    const cell = this.lootGrid.get(this.lootKey(it.x, it.z));
    if (cell) cell.delete(it);
    this.events.push(['lr', it.id]);
  }

  // Performs a pickup transaction. Returns true when the inventory changed.
  doPickup(p, it, auto) {
    if (!this.loot.has(it.id)) return false; // someone else got it first
    if (auto && it.by === p.id && this.time < it.until) return false;
    const before = Inv.activeWeapon(p.inv);
    const res = Inv.pickup(p.inv, it, auto);
    if (!res.taken) return false;
    if (res.left <= 0) this.removeLoot(it);
    else {
      it.n = res.left;
      this.events.push(['lu', it.id, it.n]);
    }
    for (const d of res.drops) {
      this.addLoot(d.kind, p.s.x, floorAt(this.world, p.s.x, p.s.z, p.s.y + 0.2), p.s.z, d.n, p, false, d.a);
    }
    if (Inv.activeWeapon(p.inv) !== before) {
      p.reloadEnd = 0;
      p.nextFire = Math.max(p.nextFire, p.clock + SWAP_TIME);
    }
    p.events.push(['pick', it.kind]);
    return true;
  }

  autoPickup(p) {
    const s = p.s;
    const cx = Math.floor(s.x / LOOT_CELL);
    const cz = Math.floor(s.z / LOOT_CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = this.lootGrid.get((cx + dx + 512) * 1024 + (cz + dz + 512));
        if (!cell || cell.size === 0) continue;
        for (const it of Array.from(cell)) {
          const ex = it.x - s.x;
          const ez = it.z - s.z;
          if (ex * ex + ez * ez > PICKUP_RADIUS * PICKUP_RADIUS || Math.abs(it.y - s.y) > 1.8) continue;
          this.doPickup(p, it, true);
        }
      }
    }
  }

  dropAll(p) {
    const items = Inv.allItems(p.inv);
    const n = items.length;
    items.forEach((d, i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      const rad = n > 1 ? 0.9 : 0;
      const x = p.s.x + Math.cos(a) * rad;
      const z = p.s.z + Math.sin(a) * rad;
      this.addLoot(d.kind, x, floorAt(this.world, x, z, p.s.y + 0.2), z, d.n, null, false, d.a);
    });
    p.inv = Inv.newInventory();
  }

  // ------------------------------------------------------------ client input

  // Queues validated input commands from a client.
  onInput(client, list) {
    const p = client.player;
    if (!p || !p.alive || this.state !== 'playing' || !Array.isArray(list)) return;
    for (let i = 0; i < list.length && i < 20; i++) {
      const a = list[i];
      if (!Array.isArray(a)) continue;
      const seq = a[0] | 0;
      const yaw = +a[3];
      const pitch = +a[4];
      const mx = +a[1];
      const mz = +a[2];
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(mx) || !Number.isFinite(mz)) continue;
      if (seq <= p.lastSeq) continue; // out of order or replayed
      p.lastSeq = seq;
      const inp = {
        seq,
        mx: clamp(mx, -1, 1),
        mz: clamp(mz, -1, 1),
        yaw,
        pitch: clamp(pitch, -1.55, 1.55),
        b: (a[5] | 0) & BTN_MASK,
        ay: Number.isFinite(a[6]) ? a[6] : yaw,
        ap: Number.isFinite(a[7]) ? clamp(a[7], -1.56, 1.56) : pitch,
        rt: Number.isFinite(a[8]) ? a[8] : this.time,
      };
      p.queue.push(inp);
    }
    // A client cannot bank more than half a second of movement.
    while (p.queue.length > MAX_QUEUE) {
      p.ack = p.queue.shift().seq;
    }
  }

  onAction(client, msg) {
    const p = client.player;
    if (!p || !p.alive || this.state !== 'playing') return;
    switch (msg.a) {
      case 'pickup': {
        const it = this.loot.get(msg.id | 0);
        if (!it || p.s.chute) return;
        const dx = it.x - p.s.x;
        const dz = it.z - p.s.z;
        if (dx * dx + dz * dz > INTERACT_RADIUS * INTERACT_RADIUS || Math.abs(it.y - p.s.y) > 2.5) return;
        this.doPickup(p, it, false);
        break;
      }
      case 'slot':
        this.switchSlot(p, msg.n | 0);
        break;
      case 'heal':
        this.startHeal(p, msg.k);
        break;
      case 'drop': {
        if (p.s.chute) return;
        const d = Inv.dropActive(p.inv);
        if (d) {
          this.addLoot(d.kind, p.s.x, floorAt(this.world, p.s.x, p.s.z, p.s.y + 0.2), p.s.z, d.n, p, false, d.a);
          p.reloadEnd = 0;
          p.nextFire = Math.max(p.nextFire, p.clock + SWAP_TIME);
        }
        break;
      }
      case 'cancel':
        p.heal = null;
        break;
      case 'throw':
        this.throwItem(p, msg.k, +msg.ay, +msg.ap);
        break;
      default:
    }
  }

  // Development and test helper, reachable only when the server allows it.
  onDebug(client, msg) {
    const p = client.player;
    if (!p || this.state !== 'playing') return;
    if (Array.isArray(msg.give) && ITEMS[msg.give[0]]) {
      const [kind, n, att] = msg.give;
      const x = p.s.x + (+msg.dx || 0);
      const z = p.s.z + (+msg.dz || 0);
      this.addLoot(kind, x, floorAt(this.world, x, z, p.s.y + 0.3), z, n ?? defaultAmount(kind), null, false, att | 0);
    }
    if (Number.isFinite(msg.hp)) p.hp = clamp(msg.hp, 1, MAX_HP);
    if (Array.isArray(msg.tp) && msg.tp.every(Number.isFinite)) {
      p.s.x = msg.tp[0];
      p.s.z = msg.tp[1];
      p.s.y = floorAt(this.world, p.s.x, p.s.z, 500);
      p.s.vx = p.s.vy = p.s.vz = 0;
      p.s.chute = false;
    }
    if (msg.calm) for (const q of this.players.values()) if (q.ai) q.ai.passive = true;
  }

  switchSlot(p, slot) {
    if (!Inv.setActive(p.inv, slot)) return false;
    p.reloadEnd = 0;
    p.heal = null;
    p.bloom = 0;
    p.nextFire = Math.max(p.nextFire, p.clock + SWAP_TIME);
    return true;
  }

  startHeal(p, kind) {
    const def = HEAL[kind];
    if (!def || !p.alive || p.s.chute || p.heal) return false;
    if (p.inv[kind] <= 0 || p.hp >= def.upTo) return false;
    p.heal = { kind, end: p.clock + def.time };
    p.reloadEnd = 0;
    return true;
  }

  // ------------------------------------------------------------- simulation

  applyInput(p, inp, dt) {
    p.yaw = inp.yaw;
    p.pitch = inp.pitch;
    p.btn = inp.b;
    stepPlayer(this.world, p.s, inp, dt);
    p.clock += dt;
    if (p.bloom > 0) p.bloom = Math.max(0, p.bloom - BLOOM_DECAY * dt);

    if (p.reloadEnd && p.clock >= p.reloadEnd) {
      Inv.reload(p.inv);
      p.reloadEnd = 0;
    }
    if (p.heal && p.clock >= p.heal.end) {
      const def = HEAL[p.heal.kind];
      if (p.inv[p.heal.kind] > 0 && p.hp < def.upTo) {
        p.inv[p.heal.kind]--;
        p.hp = Math.min(def.upTo, p.hp + def.hp);
      }
      p.heal = null;
    }
    if (p.s.chute) return;
    if (inp.b & BTN.RELOAD) this.tryReload(p);
    if (inp.b & BTN.FIRE) this.tryFire(p, inp);
  }

  tryReload(p) {
    if (p.reloadEnd || !Inv.canReload(p.inv)) return;
    const w = Inv.activeWeapon(p.inv);
    p.reloadEnd = p.clock + WEAPONS[w.kind].reload;
    p.heal = null;
  }

  tryFire(p, inp) {
    if (p.clock < p.nextFire) return;
    const w = Inv.activeWeapon(p.inv);
    if (!w) {
      p.nextFire = p.clock + MELEE.interval;
      p.heal = null;
      this.melee(p, inp);
      return;
    }
    if (p.reloadEnd) return;
    if (w.mag <= 0) {
      this.tryReload(p);
      return;
    }
    const def = WEAPONS[w.kind];
    w.mag--;
    p.nextFire = p.clock + 60 / def.rpm;
    p.heal = null;
    this.fire(p, w, def, inp);
  }

  // Position of q at server time t (lag compensation).
  rewound(q, t, out) {
    const h = q.hist;
    const n = h.length;
    if (n === 0 || t >= h[n - 1].t) {
      out.x = q.s.x; out.y = q.s.y; out.z = q.s.z; out.crouch = q.s.crouch;
      return out;
    }
    for (let i = n - 1; i > 0; i--) {
      const a = h[i - 1];
      if (t >= a.t) {
        const b = h[i];
        const k = (t - a.t) / (b.t - a.t);
        out.x = a.x + (b.x - a.x) * k;
        out.y = a.y + (b.y - a.y) * k;
        out.z = a.z + (b.z - a.z) * k;
        out.crouch = b.crouch;
        return out;
      }
    }
    const f = h[0];
    out.x = f.x; out.y = f.y; out.z = f.z; out.crouch = f.crouch;
    return out;
  }

  fire(p, w, def, inp) {
    const kind = w.kind;
    const s = p.s;
    const ox = s.x;
    const oy = s.y + eyeHeight(s.crouch);
    const oz = s.z;
    const dir = dirFromAngles(inp.ay ?? inp.yaw, inp.ap ?? inp.pitch);
    const deg = spreadDegrees(def, {
      ads: (inp.b & BTN.ADS) !== 0,
      bloom: p.bloom,
      speed: Math.sqrt(s.vx * s.vx + s.vz * s.vz),
      airborne: !s.ground,
      crouch: s.crouch,
      att: w.att,
    });
    p.bloom = Math.min(def.bloomMax, p.bloom + def.bloom * bloomScale(w.att));
    const rt = clamp(inp.rt ?? this.time, this.time - MAX_REWIND_MS, this.time);
    const ev = ['shot', p.id, WEAPON_KINDS.indexOf(kind)];
    const hits = new Map();
    const tmp = {};
    for (let i = 0; i < def.pellets; i++) {
      const d = spreadDirection(dir, deg, this.rnd);
      let t = raycastWorld(this.world, ox, oy, oz, d.x, d.y, d.z, def.range);
      let what = t < def.range ? 1 : 0;
      let victim = null;
      let part = null;
      for (const q of this.players.values()) {
        if (q === p || !q.alive) continue;
        this.rewound(q, rt, tmp);
        // Cheap reject: target further than the current hit distance.
        const ex = tmp.x - ox;
        const ez = tmp.z - oz;
        if (ex * ex + ez * ez > (t + 1) * (t + 1)) continue;
        const h = rayPlayer(ox, oy, oz, d.x, d.y, d.z, t, tmp.x, tmp.y, tmp.z, tmp.crouch);
        if (h && h.t < t) {
          t = h.t;
          victim = q;
          part = h.part;
        }
      }
      if (victim) {
        what = 2;
        const e = hits.get(victim) || { dmg: 0, head: false };
        e.dmg += bulletDamage(def, t, part);
        if (part === 'head') e.head = true;
        hits.set(victim, e);
      }
      ev.push(r2(ox + d.x * t), r2(oy + d.y * t), r2(oz + d.z * t), what);
    }
    this.events.push(ev);
    for (const [victim, e] of hits) this.damage(victim, e.dmg, p, kind, e.head);
  }

  // Throws a grenade or smoke along the given aim (with a slight upward arc).
  throwItem(p, kind, yaw, pitch) {
    const def = THROW[kind];
    if (!def || !p.alive || p.s.chute || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return false;
    if (p.inv[kind] <= 0 || p.clock < p.nextThrow) return false;
    p.inv[kind]--;
    p.nextThrow = p.clock + THROW_COOLDOWN;
    p.heal = null;
    const s = p.s;
    const dir = dirFromAngles(yaw, clamp(pitch + 0.18, -1.3, 1.3));
    const oy = s.y + eyeHeight(s.crouch) - 0.1;
    let ox = s.x + dir.x * 0.5;
    let oz = s.z + dir.z * 0.5;
    if (projectileBlocked(this.world, ox, oy, oz)) {
      ox = s.x; // hugging a wall: release from the body instead
      oz = s.z;
    }
    // Launch values are rounded exactly as they are sent, so clients that
    // simulate the same arc see the same bounces.
    const proj = {
      id: this.nextProjId++, kind, owner: p,
      x: r2(ox), y: r2(oy), z: r2(oz),
      vx: r2(dir.x * THROW_SPEED + s.vx * 0.5), vy: r2(dir.y * THROW_SPEED), vz: r2(dir.z * THROW_SPEED + s.vz * 0.5),
      at: this.time + def.fuse * 1000,
    };
    this.projectiles.push(proj);
    this.events.push(['nade', proj.id, kind, proj.x, proj.y, proj.z, proj.vx, proj.vy, proj.vz, def.fuse, p.id]);
    return true;
  }

  updateProjectiles() {
    if (this.smokes.length && this.smokes[0].until <= this.time) this.smokes = this.smokes.filter((k) => k.until > this.time);
    if (!this.projectiles.length) return;
    const live = [];
    for (const proj of this.projectiles) {
      stepProjectile(this.world, proj, TICK_DT);
      if (this.time < proj.at) {
        live.push(proj);
        continue;
      }
      if (proj.kind === 'grenade') this.explode(proj);
      else {
        const def = THROW.smoke;
        this.smokes.push({ x: proj.x, y: proj.y, z: proj.z, r: def.radius, until: this.time + def.duration * 1000 });
        this.events.push(['smoke', proj.id, r2(proj.x), r2(proj.y), r2(proj.z), def.duration]);
      }
    }
    this.projectiles = live;
  }

  explode(proj) {
    const def = THROW.grenade;
    this.events.push(['boom', proj.id, r2(proj.x), r2(proj.y), r2(proj.z)]);
    const ox = proj.x;
    const oy = proj.y + 0.3;
    const oz = proj.z;
    for (const q of this.players.values()) {
      if (!q.alive) continue;
      const dx = q.s.x - ox;
      const dy = q.s.y + (q.s.crouch ? 0.6 : 1.0) - oy;
      const dz = q.s.z - oz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > def.radius) continue;
      // Walls and terrain shield from the blast.
      if (d > 0.4 && raycastWorld(this.world, ox, oy, oz, dx / d, dy / d, dz / d, d) < d - 0.4) continue;
      this.damage(q, def.dmg * (1 - d / def.radius), proj.owner, 'grenade', false, proj);
    }
  }

  // True when a smoke cloud lies between two points (used for bot sight).
  smokeBlocks(ax, ay, az, bx, by, bz) {
    for (const k of this.smokes) {
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const len2 = dx * dx + dy * dy + dz * dz;
      let t = len2 > 0 ? ((k.x - ax) * dx + (k.y + 1 - ay) * dy + (k.z - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + dx * t - k.x;
      const cy = ay + dy * t - (k.y + 1);
      const cz = az + dz * t - k.z;
      if (cx * cx + cy * cy + cz * cz < k.r * k.r * 0.72) return true;
    }
    return false;
  }

  melee(p, inp) {
    this.events.push(['melee', p.id]);
    const dir = dirFromAngles(inp.yaw, 0);
    let best = null;
    let bestD = MELEE.range;
    for (const q of this.players.values()) {
      if (q === p || !q.alive) continue;
      const dx = q.s.x - p.s.x;
      const dz = q.s.z - p.s.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > bestD || Math.abs(q.s.y - p.s.y) > 1.7) continue;
      if (d > 0.8 && (dx * dir.x + dz * dir.z) / d < 0.5) continue;
      best = q;
      bestD = d;
    }
    if (best) this.damage(best, MELEE.dmg, p, 'fists', false);
  }

  // from: optional { x, z } the damage came from (defaults to the attacker).
  damage(victim, amount, attacker, cause, head, from = null) {
    if (!victim.alive || !(amount > 0)) return;
    const t = { hp: victim.hp, armor: victim.inv.armor };
    const lost = applyDamage(t, amount, cause === 'zone');
    victim.hp = t.hp;
    victim.inv.armor = t.armor;
    if (t.armor <= 0) victim.inv.armorLvl = 0;
    const killed = victim.hp <= 0;
    const self = attacker === victim;
    if (attacker && !self) {
      attacker.damage += amount;
      attacker.events.push(['hit', victim.id, Math.round(amount), head ? 1 : 0, killed ? 1 : 0]);
      if (victim.ai) victim.ai.onHurt(attacker);
    }
    const src = from || (attacker && !self ? attacker.s : null);
    if (src) victim.events.push(['dmg', Math.round(lost), r2(src.x), r2(src.z)]);
    if (killed) this.kill(victim, self ? null : attacker, cause);
  }

  kill(victim, attacker, cause) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.hp = 0;
    victim.queue.length = 0;
    victim.heal = null;
    victim.reloadEnd = 0;
    victim.killer = attacker ? attacker.name : null;
    victim.cause = cause;
    this.aliveCount--;
    if (attacker && attacker !== victim) attacker.kills++;
    this.events.push(['kill', attacker ? attacker.id : 0, victim.id, cause]);
    this.dropAll(victim);
    this.deadThisTick.push(victim);
  }

  step() {
    this.tick++;
    this.time = this.tick * TICK_MS;

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.bot) {
        this.applyInput(p, p.ai.update(TICK_DT), TICK_DT);
        continue;
      }
      p.budget = Math.min(p.budget + TICK_DT, 0.5);
      while (p.queue.length > 0 && p.budget >= INPUT_DT - 1e-9 && p.alive) {
        const inp = p.queue.shift();
        p.budget -= INPUT_DT;
        p.ack = inp.seq;
        this.applyInput(p, inp, INPUT_DT);
      }
      // No input from this client for a while (loading, lag, hidden tab):
      // keep physics running so nobody hangs in mid-air.
      if (p.alive && p.queue.length === 0 && p.budget >= 0.4) {
        p.budget -= TICK_DT;
        // The player keeps their stance but does not walk or shoot on their own.
        this.applyInput(p, { mx: 0, mz: 0, yaw: p.yaw, pitch: p.pitch, b: p.btn & BTN.CROUCH }, TICK_DT);
      }
    }

    this.updateProjectiles();
    if (updateZone(this.zone, this.time, this.rnd, this.world.isLand)) this.events.push(['zone', this.zone]);
    zoneCircleAt(this.zone, this.time, this.circle);
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (!p.s.chute) this.autoPickup(p);
      if (!insideCircle(this.circle, p.s.x, p.s.z)) this.damage(p, this.zone.dps * TICK_DT, null, 'zone', false);
    }

    this.resolveDeaths();

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      p.hist.push({ t: this.time, x: p.s.x, y: p.s.y, z: p.s.z, crouch: p.s.crouch });
      if (p.hist.length > HISTORY_TICKS) p.hist.shift();
    }

    this.sendSnapshots();
    if (this.aliveCount <= 1) this.end();
  }

  // Assigns final places to everyone eliminated this tick. Players who fall in
  // the same tick are ranked by kills, then damage (see rankSimultaneous).
  resolveDeaths() {
    if (this.deadThisTick.length === 0) return;
    const ranked = rankSimultaneous(this.deadThisTick);
    ranked.forEach((p, i) => {
      p.place = this.aliveCount + 1 + i;
    });
    for (const p of ranked) {
      if (!p.client || p.place === 1) continue;
      p.client.send(this.deadMessage(p));
    }
    this.deadThisTick.length = 0;
  }

  deadMessage(p) {
    return {
      t: 'dead', place: p.place, total: this.total, killer: p.killer, cause: p.cause,
      kills: p.kills, damage: Math.round(p.damage),
    };
  }

  flagsOf(p) {
    const s = p.s;
    let f = 0;
    if (s.ground) f |= PF.GROUND;
    if (s.crouch) f |= PF.CROUCH;
    if (s.chute) f |= PF.CHUTE;
    if (p.btn & BTN.ADS) f |= PF.ADS;
    if (p.btn & BTN.SPRINT) f |= PF.SPRINT;
    if (p.reloadEnd) f |= PF.RELOAD;
    if (p.heal) f |= PF.HEAL;
    return f;
  }

  privateState(p) {
    const inv = p.inv;
    const w = Inv.activeWeapon(inv);
    return JSON.stringify({
      hp: Math.ceil(p.hp),
      ar: Math.ceil(inv.armor),
      al: inv.armorLvl,
      bp: inv.pack,
      w: inv.weapons.map((x) => (x ? [x.kind, x.mag, x.att] : null)),
      s: inv.active,
      am: [inv.ammo.light, inv.ammo.rifle, inv.ammo.shell, inv.ammo.sniper],
      bd: inv.bandage,
      mk: inv.medkit,
      gr: inv.grenade,
      sm: inv.smoke,
      rl: p.reloadEnd && w ? WEAPONS[w.kind].reload : 0,
      hl: p.heal ? p.heal.kind : 0,
      k: p.kills,
    });
  }

  sendSnapshots() {
    const arr = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const w = Inv.activeWeapon(p.inv);
      arr.push([p.id, r2(p.s.x), r2(p.s.y), r2(p.s.z), r3(p.yaw), r3(p.pitch), this.flagsOf(p), w ? WEAPON_KINDS.indexOf(w.kind) : -1]);
    }
    const shared = JSON.stringify(arr);
    const head = '{"t":"s","n":' + this.tick + ',"tm":' + r2(this.time) + ',"al":' + this.aliveCount;
    for (const c of this.clients.values()) {
      const p = c.player;
      let msg = head;
      let evs = this.events;
      if (p) {
        if (p.alive) {
          const s = p.s;
          msg += ',"a":' + p.ack + ',"me":' + JSON.stringify([s.x, s.y, s.z, s.vx, s.vy, s.vz, this.flagsOf(p)]);
          const st = this.privateState(p);
          if (st !== p.lastState) {
            msg += ',"st":' + st;
            p.lastState = st;
          }
        }
        if (p.events.length) evs = evs.concat(p.events);
      }
      if (evs.length) msg += ',"e":' + JSON.stringify(evs);
      c.sendRaw(msg + ',"p":' + shared + '}');
    }
    for (const p of this.players.values()) p.events.length = 0;
    this.events.length = 0;
  }

  end() {
    if (this.state !== 'playing') return;
    this.state = 'ended';
    let winner = null;
    for (const p of this.players.values()) {
      if (p.alive) winner = p;
    }
    if (!winner) {
      for (const p of this.players.values()) if (p.place === 1) winner = p;
    }
    if (winner) winner.place = 1;
    this.winner = winner;
    for (const c of this.clients.values()) c.send(this.endMessage(c));
    this.endAt = Date.now() + this.opts.endSeconds * 1000;
  }

  endMessage(client) {
    const winner = this.winner;
    const p = client.player;
    const rows = Array.from(this.players.values())
      .sort((a, b) => a.place - b.place)
      .map((q) => ({ id: q.id, name: q.name, bot: q.bot, place: q.place, kills: q.kills, damage: Math.round(q.damage) }));
    return {
      t: 'end',
      winner: winner ? { id: winner.id, name: winner.name, bot: winner.bot } : null,
      rows,
      you: p ? { id: p.id, place: p.place, kills: p.kills, damage: Math.round(p.damage) } : null,
      total: this.total,
    };
  }
}
