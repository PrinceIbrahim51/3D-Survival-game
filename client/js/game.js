// Client side of one match: predicts the local player, interpolates everyone
// else, drives the camera, and turns server events into visuals and sound.
// The server stays authoritative for every gameplay result.

import * as THREE from 'three';
import {
  stepPlayer, makeMoveState, copyMoveState, raycastWorld, rayPlayer, isSwimming, stepProjectile, downedInput,
} from '/shared/physics.js';
import {
  VEHICLES, ENTER_RADIUS, makeVehicleState, copyVehicleState, stepVehicle, seatPosition, vehicleCircles,
} from '/shared/vehicle.js';
import {
  BTN, PF, INPUT_DT, TICK_DT, INTERP_DELAY_MS, INTERACT_RADIUS, WALK_SPEED, EYE_HEIGHT, CROUCH_EYE_HEIGHT, dirFromAngles,
  REVIVE_SECONDS, REVIVE_RANGE,
} from '/shared/constants.js';
import {
  WEAPONS, WEAPON_KINDS, MELEE, ITEMS, HEAL, THROW, SWAP_TIME, BLOOM_DECAY, AIR_SPREAD, adsZoom, recoilScale, bloomScale,
  adsSpreadScale,
} from '/shared/items.js';
import { zoneCircleAt, insideCircle } from '/shared/zone.js';
import { createCharacter, createVehicleView, createNameTag, LootView } from './models.js';
import { Effects } from './effects.js';
import { causeText } from './hud.js';

const BASE_FOV = 68;
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const round5 = (v) => Math.round(v * 1e5) / 1e5;
const seatTmp = {};
const circleTmp = [];

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export class Game {
  constructor(app, start) {
    this.app = app;
    this.world = app.world;
    this.camera = app.camera;
    this.input = app.input;
    this.hud = app.hud;
    this.audio = app.audio;
    this.net = app.net;

    this.root = new THREE.Group();
    app.scene.add(this.root);
    this.effects = new Effects(this.root);
    this.loot = new LootView(this.root);

    this.myId = start.you;
    this.total = start.total;
    this.aliveCount = start.total;
    this.names = new Map();
    this.teamOf = new Map();
    for (const [id, name, bot, team] of start.players) {
      this.names.set(id, { name, bot: !!bot });
      this.teamOf.set(id, team);
    }
    this.team = start.team || 0;
    this.teamSize = start.teamSize || 1;
    this.watching = !!start.watching;
    this.teamsAlive = start.teams || 0;

    // Vehicles. The one we drive is predicted locally; the rest are interpolated.
    this.vehicles = new Map();
    this.seatOf = new Map(); // player id -> vehicle
    for (const a of start.veh || []) this.addVehicle(a);
    this.obstacles = [];
    this.myVeh = null;
    this.mySeat = -1;
    this.vs = makeVehicleState(0, 0, 0, 0);
    this.vprev = makeVehicleState(0, 0, 0, 0);
    this.vcorr = new THREE.Vector3();
    for (const [id, kind, x, y, z, n] of start.loot) this.loot.add(id, kind, x, y, z);
    this.lootN = new Map(start.loot.map((l) => [l[0], l[5]]));

    // A resumed match (after a reconnect) may find us landed, or already out.
    this.alive = start.alive !== false;
    this.ended = false;
    this.lastTick = 0;
    this.s = makeMoveState(start.spawn[0], start.spawn[1], start.spawn[2]);
    this.s.chute = start.resume ? !!start.chute : true;
    this.prev = copyMoveState(makeMoveState(), this.s);
    this.pos = new THREE.Vector3(this.s.x, this.s.y, this.s.z);
    this.corr = new THREE.Vector3();
    this.camY = this.s.y;
    this.eye = EYE_HEIGHT;
    this.seq = start.seq || 0; // the server ignores sequence numbers it has already seen
    this.pending = [];
    this.outbox = [];
    this.acc = 0;
    this.clock = 0;
    this.nextFire = 0;
    this.shots = [];
    this.bloom = 0;
    this.stepDist = 0;
    this.st = null;
    this.kills = 0;

    this.nades = new Map(); // thrown grenades in flight, simulated locally from their launch state
    this.shake = 0;
    for (const k of start.smokes || []) this.effects.smoke(v1.set(k[0], k[1], k[2]), THROW.smoke.radius, k[3]);

    this.me = createCharacter(this.myId);
    this.root.add(this.me.root);
    this.players = new Map();
    this.seen = new Set();

    this.zone = start.zone;
    this.circle = { x: 0, z: 0, r: 999 };
    this.timeOffset = null;
    this.serverTime = 0;
    this.renderTime = 0;

    this.camDist = 7;
    this.camSide = 0;
    this.camUp = 1.2;
    this.fov = BASE_FOV;
    this.camDir = new THREE.Vector3(0, 0, -1);
    this.scoped = false;
    this.spectateId = 0;
    this.promptItem = null;
    this.promptSince = 0;
    this.frameNo = 0;
    this.fireWasDown = false;
    this.lastDeathPos = new THREE.Vector3();

    this.input.reset(start.spawn[3]);
    this.hud.setTeam([]);
    this.hud.setVehicle(null);
    this.hud.setDowned(null);
    this.hud.setUseButton(null);
    this.hud.setSpectate(null);
    this.hud.setPrompt(null);
    this.hud.stopProgress();
    if (!this.alive) {
      this.input.spectating = true;
      this.me.root.visible = false;
      this.lastDeathPos.copy(this.pos);
    } else if (!start.resume) {
      this.hud.announce('Steer your parachute and land near buildings to find gear', 5000);
    }
  }

  addVehicle(a) {
    const [id, type, x, y, z, yaw, hp, dead, seats, variant] = a;
    const view = createVehicleView(type, variant || 0);
    this.root.add(view.root);
    view.set(x, y, z, yaw);
    if (dead) view.setWrecked(true);
    const v = { id, type, def: VEHICLES[type], view, x, y, z, yaw, speed: 0, hp, dead: !!dead, seats: seats.slice(), buf: [] };
    this.vehicles.set(id, v);
    for (const pid of seats) if (pid) this.seatOf.set(pid, v);
  }

  isMate(id) {
    return this.teamSize > 1 && !this.watching && id !== this.myId && this.teamOf.get(id) === this.team;
  }

  nameOf(id) {
    const n = this.names.get(id);
    return n ? n.name : 'Unknown';
  }

  // ------------------------------------------------------------- snapshots

  onSnapshot(m) {
    const now = performance.now();
    const est = m.tm - now;
    // Track the fastest packets: they give the best estimate of the clock offset.
    if (this.timeOffset === null || est > this.timeOffset || this.timeOffset - est > 600) this.timeOffset = est;
    else this.timeOffset += (est - this.timeOffset) * 0.02;
    // During a socket hand-over a snapshot can arrive late. Its events still
    // count, but its (older) positions and state must not overwrite newer ones.
    if (m.n <= this.lastTick) {
      if (m.e) for (const e of m.e) this.onEvent(e);
      return;
    }
    this.lastTick = m.n;
    this.aliveCount = m.al;
    if (m.tl !== undefined) this.teamsAlive = m.tl;
    if (m.v) {
      for (const a of m.v) {
        const v = this.vehicles.get(a[0]);
        if (!v) continue;
        v.buf.push({ t: m.tm, x: a[1], y: a[2], z: a[3], yaw: a[4], speed: a[5] });
        if (v.buf.length > 30) v.buf.shift();
        v.hp = a[6];
      }
    }

    const seen = this.seen;
    seen.clear();
    for (const a of m.p) {
      const id = a[0];
      seen.add(id);
      if (id === this.myId && this.alive) continue;
      let r = this.players.get(id);
      if (!r) r = this.addRemote(id);
      r.buf.push({ t: m.tm, x: a[1], y: a[2], z: a[3], yaw: a[4], pitch: a[5], f: a[6], w: a[7] });
      if (r.buf.length > 40) r.buf.shift();
    }
    for (const [id, r] of this.players) {
      if (!seen.has(id) && !r.dying) this.killRemote(id);
    }

    if (m.me && this.alive) this.reconcile(m);
    if (m.st) this.setState(m.st);
    if (m.e) for (const e of m.e) this.onEvent(e);
  }

  addRemote(id) {
    const view = createCharacter(id);
    this.root.add(view.root);
    const r = { id, view, buf: [], x: 0, y: 0, z: 0, yaw: 0, crouch: false, chute: false, down: false, dying: 0, stepDist: 0, speed: 0 };
    // Team-mates get a name floating over their head.
    if (this.isMate(id)) view.root.add(createNameTag(this.nameOf(id)));
    this.players.set(id, r);
    return r;
  }

  killRemote(id) {
    const r = this.players.get(id);
    if (!r || r.dying) return;
    r.dying = 0.001;
    r.view.dead = 0.001;
  }

  reconcile(m) {
    const ack = m.a;
    const pending = this.pending;
    let drop = 0;
    while (drop < pending.length && pending[drop].seq <= ack) drop++;
    if (drop) pending.splice(0, drop);
    if (this.shots.length) this.shots = this.shots.filter((seq) => seq > ack);

    // Driving: the vehicle is what we predict.
    if (m.mv && this.myVeh && this.mySeat === 0) {
      const v = this.vs;
      const ox = v.x;
      const oy = v.y;
      const oz = v.z;
      v.x = m.mv[0]; v.y = m.mv[1]; v.z = m.mv[2]; v.yaw = m.mv[3]; v.speed = m.mv[4];
      const def = this.myVeh.def;
      for (let i = 0; i < pending.length; i++) stepVehicle(this.world, def, v, pending[i], INPUT_DT);
      const ex = ox - v.x;
      const ey = oy - v.y;
      const ez = oz - v.z;
      const err = ex * ex + ey * ey + ez * ez;
      if (err > 1e-8) {
        this.vprev.x -= ex;
        this.vprev.y -= ey;
        this.vprev.z -= ez;
        if (err < 36) this.vcorr.add(v1.set(ex, ey, ez));
        else this.vcorr.set(0, 0, 0);
      }
      return;
    }

    const s = this.s;
    const ox = s.x;
    const oy = s.y;
    const oz = s.z;
    const me = m.me;
    s.x = me[0]; s.y = me[1]; s.z = me[2];
    s.vx = me[3]; s.vy = me[4]; s.vz = me[5];
    s.ground = (me[6] & PF.GROUND) !== 0;
    s.crouch = (me[6] & PF.CROUCH) !== 0;
    s.chute = (me[6] & PF.CHUTE) !== 0;
    if (me[6] & PF.VEHICLE) return; // riding: our position simply follows the vehicle
    const down = (me[6] & PF.DOWN) !== 0;
    for (let i = 0; i < pending.length; i++) {
      stepPlayer(this.world, s, down ? downedInput(pending[i]) : pending[i], INPUT_DT, this.obstacles);
    }

    const ex = ox - s.x;
    const ey = oy - s.y;
    const ez = oz - s.z;
    const err = ex * ex + ey * ey + ez * ez;
    if (err > 1e-8) {
      // Keep the interpolation pair consistent and hide the correction by
      // easing it out visually instead of snapping.
      this.prev.x -= ex;
      this.prev.y -= ey;
      this.prev.z -= ez;
      if (err < 25) this.corr.add(v1.set(ex, ey, ez));
      else this.corr.set(0, 0, 0);
    }
  }

  setState(st) {
    const prev = this.st;
    this.st = st;
    this.kills = st.k;
    this.hud.setState(st);
    this.me.setGear(st.ar, st.bp);
    const wasReload = prev && prev.rl > 0;
    const wasHeal = prev && prev.hl;
    const wasRevive = prev && prev.rv;
    if (st.rl > 0 && !wasReload) {
      this.hud.startProgress('Reloading', st.rl);
      this.audio.ui('reload');
    } else if (st.hl && st.hl !== wasHeal) {
      this.hud.startProgress('Using ' + HEAL[st.hl].name, HEAL[st.hl].time);
    } else if (st.rv && st.rv !== wasRevive) {
      this.hud.startProgress('Reviving ' + this.nameOf(st.rv), REVIVE_SECONDS);
    } else if ((wasReload && !st.rl) || (wasHeal && !st.hl) || (wasRevive && !st.rv)) {
      this.hud.stopProgress();
      if (wasHeal && st.hp > prev.hp) this.audio.ui('heal');
    }
    if (prev && prev.s !== st.s) {
      this.shots.length = 0;
      this.bloom = 0;
    }

    // Vehicle seat.
    const veh = st.veh ? this.vehicles.get(st.veh[0]) : null;
    const seat = veh ? st.veh[1] : -1;
    if (veh !== this.myVeh || seat !== this.mySeat) {
      if (!veh && this.myVeh) {
        // Stepped out: carry on from where the server put us.
        this.corr.set(0, 0, 0);
        this.pending.length = 0;
      }
      this.myVeh = veh;
      this.mySeat = seat;
      if (veh && seat === 0) {
        // Took the wheel: start predicting from where the vehicle is drawn.
        this.vs.x = veh.x; this.vs.y = veh.y; this.vs.z = veh.z; this.vs.yaw = veh.yaw; this.vs.speed = veh.speed;
        copyVehicleState(this.vprev, this.vs);
        this.vcorr.set(0, 0, 0);
        this.pending.length = 0;
      }
    }
    if (veh) veh.hp = st.veh[2];

    // Team.
    if (st.tm) this.hud.setTeam(st.tm.map(([id, hp, state]) => ({ name: this.nameOf(id), hp, state })));
    if (st.dn && !(prev && prev.dn)) this.audio.ui('lose');
    this.hud.setDowned(st.dn ? (st.dn === 2 ? 'A team-mate is helping you up' : 'Crawl to a team-mate: they can revive you') : null);
  }

  // ---------------------------------------------------------------- events

  onEvent(e) {
    switch (e[0]) {
      case 'shot': this.onShot(e); break;
      case 'hit':
        this.hud.hitMarker(e[4] ? 'kill' : e[3] ? 'head' : 'hit');
        this.audio.ui(e[4] ? 'kill' : e[3] ? 'head' : 'hit');
        if (e[4] === 2) this.hud.announce('You knocked down ' + this.nameOf(e[1]));
        break;
      case 'down': {
        const mine = e[1] === this.myId || e[2] === this.myId || this.isMate(e[2]);
        this.hud.killFeed(e[1] ? this.nameOf(e[1]) : null, this.nameOf(e[2]), e[1] ? 'knocked down' : 'is down', mine);
        if (this.isMate(e[2])) this.hud.announce(this.nameOf(e[2]) + ' is down - revive them!');
        break;
      }
      case 'up':
        this.hud.killFeed(this.nameOf(e[1]), this.nameOf(e[2]), 'revived', e[1] === this.myId || e[2] === this.myId);
        break;
      case 'vin': {
        const v = this.vehicles.get(e[1]);
        if (v) {
          v.seats[e[3]] = e[2];
          this.seatOf.set(e[2], v);
        }
        break;
      }
      case 'vout': {
        const v = this.vehicles.get(e[1]);
        if (v) {
          const i = v.seats.indexOf(e[2]);
          if (i >= 0) v.seats[i] = 0;
        }
        this.seatOf.delete(e[2]);
        break;
      }
      case 'vd': {
        const v = this.vehicles.get(e[1]);
        if (v) {
          v.dead = true;
          v.view.setWrecked(true);
        }
        break;
      }
      case 'dmg': {
        const dx = e[2] - this.s.x;
        const dz = e[3] - this.s.z;
        const yaw = this.input.yaw;
        const fwd = -dx * Math.sin(yaw) - dz * Math.cos(yaw);
        const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
        this.hud.damageFrom(Math.atan2(right, fwd));
        this.audio.ui('hurt');
        break;
      }
      case 'kill': this.onKill(e[1], e[2], e[3]); break;
      case 'la':
        this.loot.add(e[1], e[2], e[3], e[4], e[5]);
        this.lootN.set(e[1], e[6]);
        break;
      case 'lr':
        this.loot.remove(e[1]);
        this.lootN.delete(e[1]);
        break;
      case 'lu': this.lootN.set(e[1], e[2]); break;
      case 'zone':
        this.zone = e[1];
        if (this.zone.mode === 'shrink') {
          this.hud.announce('The zone is closing in!');
          this.audio.ui('zone');
        } else if (this.zone.mode === 'wait') {
          this.hud.announce('New safe zone marked on your map');
        } else {
          this.hud.announce('Final zone: nowhere left to hide');
        }
        break;
      case 'melee': {
        const r = this.players.get(e[1]);
        if (r) {
          r.view.punch = 1;
          this.audio.swing(r.x, r.z);
        }
        break;
      }
      case 'pick':
        this.hud.pickupLog(e[1]);
        this.audio.ui('pickup');
        break;
      case 'nade': {
        const mesh = this.effects.takeNade(e[2]);
        this.nades.set(e[1], {
          kind: e[2], p: { x: e[3], y: e[4], z: e[5], vx: e[6], vy: e[7], vz: e[8] }, acc: 0, life: e[9] + 1.5, mesh,
        });
        if (e[10] === this.myId) this.me.punch = 1;
        else this.audio.swing(e[3], e[5]);
        break;
      }
      case 'boom': {
        this.dropNade(e[1]);
        v1.set(e[2], e[3], e[4]);
        this.effects.explosion(v1);
        this.audio.boom(e[2], e[4]);
        const d = Math.hypot(e[2] - this.pos.x, e[4] - this.pos.z);
        if (d < 30) this.shake = Math.max(this.shake, 1 - d / 30);
        break;
      }
      case 'smoke':
        this.dropNade(e[1]);
        this.effects.smoke(v1.set(e[2], e[3], e[4]), THROW.smoke.radius, e[5]);
        this.audio.hiss(e[2], e[4]);
        break;
      default:
    }
  }

  dropNade(id) {
    const n = this.nades.get(id);
    if (!n) return;
    if (n.mesh) n.mesh.visible = false;
    this.nades.delete(id);
  }

  updateNades(dt) {
    for (const [id, n] of this.nades) {
      n.acc += dt;
      n.life -= dt;
      // Same fixed step as the server, so the arc and bounces match.
      while (n.acc >= TICK_DT) {
        n.acc -= TICK_DT;
        stepProjectile(this.world, n.p, TICK_DT);
      }
      if (n.mesh) {
        n.mesh.position.set(n.p.x + n.p.vx * n.acc, n.p.y, n.p.z + n.p.vz * n.acc);
        n.mesh.rotation.x += dt * 9;
      }
      if (n.life <= 0) this.dropNade(id);
    }
  }

  onShot(e) {
    const id = e[1];
    const kind = WEAPON_KINDS[e[2]];
    const mine = id === this.myId && this.alive;
    const from = v1;
    if (mine) {
      if (this.scoped) from.copy(this.camera.position).addScaledVector(this.camDir, 0.6).add(v3.set(0, -0.08, 0));
      else this.me.muzzle(from);
    } else {
      const r = this.players.get(id);
      if (!r) return;
      r.view.muzzle(from);
    }
    const to = v2;
    for (let i = 3; i + 3 < e.length; i += 4) {
      to.set(e[i], e[i + 1], e[i + 2]);
      this.effects.tracer(from, to, kind === 'sniper' ? 0.06 : kind === 'shotgun' ? 0.025 : 0.035);
      const what = e[i + 3];
      if (what === 1) this.effects.puff(to, 0xd6ccb4, 0.09, 0.35, 0.5);
      else if (what === 2) this.effects.puff(to, 0xff5a3c, 0.12, 0.28, 0.2);
    }
    if (!mine) {
      v3.subVectors(to, from).normalize();
      this.effects.flash(from, v3, false);
      this.audio.shot(kind, from.x, from.z);
    }
  }

  onKill(killerId, victimId, cause) {
    const victim = this.nameOf(victimId);
    const killer = killerId ? this.nameOf(killerId) : null;
    const mine = killerId === this.myId || victimId === this.myId;
    this.hud.killFeed(killer, victim, causeText(cause), mine);
    if (victimId === this.myId) {
      this.alive = false;
      this.input.spectating = true;
      this.input.fire = false;
      this.input.unlock();
      this.me.dead = 0.001;
      this.lastDeathPos.copy(this.pos);
      this.spectateId = killerId || 0;
      this.pending.length = 0;
      this.outbox.length = 0;
      this.hud.stopProgress();
      this.hud.setPrompt(null);
      this.audio.ui('lose');
    } else {
      this.killRemote(victimId);
      if (killerId === this.myId) this.hud.announce('You eliminated ' + victim);
    }
  }

  // ----------------------------------------------------------------- input

  activeDef() {
    const st = this.st;
    if (!st || st.s === 2 || !st.w[st.s]) return null;
    return WEAPONS[st.w[st.s][0]];
  }

  // Attachment flags of the weapon in hand.
  activeAtt() {
    const st = this.st;
    return st && st.s !== 2 && st.w[st.s] ? st.w[st.s][2] | 0 : 0;
  }

  // Direction from the character's eyes to whatever is under the crosshair.
  // The camera sits behind the shoulder, so its ray is not the bullet's ray.
  computeAim(yaw, pitch) {
    const cam = this.camera.position;
    const dir = dirFromAngles(yaw, pitch, this.aimDir || (this.aimDir = {}));
    const s = this.s;
    const ex = s.x;
    const ey = s.y + (s.crouch ? CROUCH_EYE_HEIGHT : EYE_HEIGHT);
    const ez = s.z;
    // Start the camera ray level with the player so nothing behind them counts.
    const t0 = Math.max(0, (ex - cam.x) * dir.x + (ey - cam.y) * dir.y + (ez - cam.z) * dir.z);
    const sx = cam.x + dir.x * t0;
    const sy = cam.y + dir.y * t0;
    const sz = cam.z + dir.z * t0;
    let t = raycastWorld(this.world, sx, sy, sz, dir.x, dir.y, dir.z, 400);
    for (const r of this.players.values()) {
      if (r.dying) continue;
      const h = rayPlayer(sx, sy, sz, dir.x, dir.y, dir.z, t, r.x, r.y, r.z, r.crouch);
      if (h && h.t < t) t = h.t;
    }
    const dx = sx + dir.x * t - ex;
    const dy = sy + dir.y * t - ey;
    const dz = sz + dir.z * t - ez;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1.2) return [yaw, pitch];
    return [round5(Math.atan2(-dx, -dz)), round5(Math.asin(Math.max(-1, Math.min(1, dy / len))))];
  }

  tickInput() {
    const input = this.input;
    const b = input.sample();
    const yaw = round5(input.yaw);
    const pitch = round5(input.pitch);
    const inp = { seq: ++this.seq, mx: input.mx, mz: input.mz, yaw, pitch, b };
    const s = this.s;
    const driving = this.myVeh && this.mySeat === 0;
    const wasChute = s.chute;
    const wasGround = s.ground;
    if (driving) {
      copyVehicleState(this.vprev, this.vs);
      const before = Math.abs(this.vs.speed);
      const lost = stepVehicle(this.world, this.myVeh.def, this.vs, inp, INPUT_DT);
      if (lost > 4 && before > 6) {
        this.audio.ui('hurt');
        this.shake = Math.max(this.shake, 0.6);
      }
    } else if (!this.myVeh) {
      copyMoveState(this.prev, s);
      stepPlayer(this.world, s, this.st && this.st.dn ? downedInput(inp) : inp, INPUT_DT, this.obstacles);
    }
    this.clock += INPUT_DT;
    if (this.bloom > 0) this.bloom = Math.max(0, this.bloom - BLOOM_DECAY * INPUT_DT);

    if (!this.myVeh) {
      if (wasChute && !s.chute) {
        this.audio.ui('land');
        this.hud.announce('Find a weapon!', 2500);
      } else if (!wasGround && s.ground && !wasChute) {
        this.audio.step(undefined, undefined, true);
      }
      if (s.ground) {
        this.stepDist += Math.sqrt(s.vx * s.vx + s.vz * s.vz) * INPUT_DT;
        if (this.stepDist > 2.3) {
          this.stepDist = 0;
          this.audio.step(undefined, undefined, true);
        }
      }
    }

    const arr = [inp.seq, inp.mx, inp.mz, yaw, pitch, b];
    // Drivers and downed players cannot shoot.
    if ((b & BTN.FIRE) && !s.chute && this.st && !driving && !this.st.dn) {
      const aim = this.computeAim(yaw, pitch);
      arr.push(aim[0], aim[1], Math.round(this.renderTime));
      this.predictFire(inp.seq, b, aim);
    }
    this.outbox.push(arr);
    this.pending.push(inp);
    if (this.pending.length > 180) this.pending.shift();
  }

  // Immediate feedback for our own shots. Hits are still decided by the server.
  predictFire(seq, b, aim) {
    if (this.clock < this.nextFire) return;
    const st = this.st;
    if (st.s === 2 || !st.w[st.s]) {
      this.nextFire = this.clock + MELEE.interval;
      this.me.punch = 1;
      this.audio.swing();
      return;
    }
    if (st.rl) return;
    const w = st.w[st.s];
    const def = WEAPONS[w[0]];
    if (w[1] - this.shots.length <= 0) {
      if (!this.emptyAt || this.clock - this.emptyAt > 0.45) {
        this.emptyAt = this.clock;
        this.audio.ui('empty');
      }
      return;
    }
    this.nextFire = this.clock + 60 / def.rpm;
    this.shots.push(seq);
    const att = w[2] | 0;
    this.bloom = Math.min(def.bloomMax, this.bloom + def.bloom * bloomScale(att));
    // Recoil: the view climbs and wanders a little; the player pulls it back.
    const k = ((b & BTN.ADS) ? 0.65 : 1) * (this.s.crouch ? 0.8 : 1) * recoilScale(att);
    this.input.pitch = Math.min(1.45, this.input.pitch + def.recoil * 0.011 * k);
    this.input.yaw += (Math.random() - 0.5) * def.recoil * 0.009 * k;
    const dir = dirFromAngles(aim[0], aim[1], this.fireDir || (this.fireDir = new THREE.Vector3()));
    if (!this.scoped) {
      this.me.muzzle(v1);
      this.effects.flash(v1, dir, true);
    }
    this.audio.shot(w[0]);
  }

  doActions() {
    const acts = this.input.actions;
    if (!acts.length) return;
    for (const act of acts) {
      switch (act.a) {
        case 'map': this.hud.toggleMap(); break;
        case 'pause': this.app.showPause(true); break;
        case 'resume': this.app.showPause(false); break;
        case 'next': if (!this.alive) this.nextSpectate(); break;
        default:
          if (this.alive && this.st) this.doGameAction(act);
      }
    }
    acts.length = 0;
  }

  doGameAction(act) {
    const st = this.st;
    switch (act.a) {
      case 'slot':
        if (act.n === st.s || (act.n < 2 && !st.w[act.n])) return;
        this.net.send({ t: 'act', a: 'slot', n: act.n });
        this.nextFire = Math.max(this.nextFire, this.clock + SWAP_TIME);
        break;
      case 'swap': {
        const order = [0, 1, 2].filter((n) => n === 2 || st.w[n]);
        const i = order.indexOf(st.s);
        const n = order[(i + (act.dir < 0 ? order.length - 1 : 1)) % order.length];
        if (n !== st.s) this.doGameAction({ a: 'slot', n });
        break;
      }
      case 'heal': {
        let k = act.k;
        if (!k) k = st.hp < 45 && st.mk > 0 ? 'medkit' : st.hp < HEAL.bandage.upTo && st.bd > 0 ? 'bandage' : 'medkit';
        if (st[k === 'medkit' ? 'mk' : 'bd'] <= 0) {
          this.hud.announce('No ' + HEAL[k].name + ' left', 1200);
          return;
        }
        if (st.hp >= HEAL[k].upTo) {
          this.hud.announce(k === 'bandage' ? 'Bandages only heal up to ' + HEAL[k].upTo : 'Health is already full', 1400);
          return;
        }
        this.net.send({ t: 'act', a: 'heal', k });
        break;
      }
      case 'pickup': {
        // The weapon named in the on-screen prompt comes first; other items
        // lying closer (full ammo, spare bandages) must not get in the way.
        const it = this.nearestLoot(false) || this.nearestLoot(true);
        if (it) this.net.send({ t: 'act', a: 'pickup', id: it.id });
        break;
      }
      case 'drop':
        this.net.send({ t: 'act', a: 'drop' });
        break;
      case 'use':
        this.net.send({ t: 'act', a: 'use' });
        break;
      case 'throw': {
        const k = act.k === 'smoke' ? 'smoke' : 'grenade';
        if (this.s.chute) return;
        if (st[k === 'smoke' ? 'sm' : 'gr'] <= 0) {
          this.hud.announce('No ' + THROW[k].name + ' to throw', 1200);
          return;
        }
        this.net.send({ t: 'act', a: 'throw', k, ay: round5(this.input.yaw), ap: round5(this.input.pitch) });
        break;
      }
      default:
    }
  }

  nearestLoot(any) {
    const s = this.s;
    let best = null;
    let bestD = INTERACT_RADIUS * INTERACT_RADIUS;
    for (const it of this.loot.items.values()) {
      if (!any && ITEMS[it.kind].type !== 'weapon') continue;
      const dx = it.x - s.x;
      const dz = it.z - s.z;
      const d = dx * dx + dz * dz;
      if (d < bestD && Math.abs(it.y - s.y) < 2.2) {
        bestD = d;
        best = it;
      }
    }
    return best;
  }

  // ------------------------------------------------------------- per frame

  frame(dt) {
    this.frameNo++;
    const now = performance.now();
    if (this.timeOffset !== null) {
      this.serverTime = now + this.timeOffset;
      this.renderTime = this.serverTime - INTERP_DELAY_MS;
    }
    this.doActions();

    if (this.alive && !this.ended) {
      this.acc += dt;
      let n = 0;
      // Catch up after a slow frame so low frame rates do not slow the player down.
      while (this.acc >= INPUT_DT && n < 15) {
        this.acc -= INPUT_DT;
        this.tickInput();
        n++;
      }
      if (this.acc > INPUT_DT * 15) this.acc = 0;
      if (this.outbox.length) {
        this.net.send({ t: 'i', a: this.outbox });
        this.outbox = [];
      }
      if (!this.myVeh) {
        const a = this.acc / INPUT_DT;
        const s = this.s;
        const p = this.prev;
        this.corr.multiplyScalar(Math.exp(-dt * 12));
        this.pos.set(p.x + (s.x - p.x) * a + this.corr.x, p.y + (s.y - p.y) * a + this.corr.y, p.z + (s.z - p.z) * a + this.corr.z);
      }
    } else if (!this.alive && this.input.touch) {
      // Dead on a phone: the fire button cycles the spectated player.
      const down = this.input.fire;
      if (down && !this.fireWasDown) this.nextSpectate();
      this.fireWasDown = down;
    }

    this.updateVehicles(dt);
    this.updateRemotes(dt);
    this.updateSelf(dt);
    this.updateNades(dt);
    zoneCircleAt(this.zone, this.serverTime, this.circle);
    this.effects.setZone(this.circle, now / 1000);
    this.updateCamera(dt);
    this.effects.update(dt);
    this.loot.update(now / 1000);
    this.updateHud(dt);
  }

  // Places every vehicle: ours from prediction, the others from snapshots.
  updateVehicles(dt) {
    const rt = this.renderTime;
    let n = 0;
    for (const v of this.vehicles.values()) {
      if (v === this.myVeh && this.mySeat === 0 && this.alive) {
        const a = this.acc / INPUT_DT;
        const p = this.vprev;
        const c = this.vs;
        this.vcorr.multiplyScalar(Math.exp(-dt * 12));
        v.x = p.x + (c.x - p.x) * a + this.vcorr.x;
        v.y = p.y + (c.y - p.y) * a + this.vcorr.y;
        v.z = p.z + (c.z - p.z) * a + this.vcorr.z;
        v.yaw = lerpAngle(p.yaw, c.yaw, a);
        v.speed = c.speed;
      } else if (v.buf.length) {
        const buf = v.buf;
        let i = buf.length - 1;
        while (i > 0 && buf[i].t > rt) i--;
        const a = buf[i];
        const b = buf[i + 1] || a;
        let k = b.t > a.t ? (rt - a.t) / (b.t - a.t) : 0;
        k = k < 0 ? 0 : k > 1 ? 1 : k;
        v.x = a.x + (b.x - a.x) * k;
        v.y = a.y + (b.y - a.y) * k;
        v.z = a.z + (b.z - a.z) * k;
        v.yaw = lerpAngle(a.yaw, b.yaw, k);
        v.speed = b.speed;
      }
      v.view.set(v.x, v.y, v.z, v.yaw);
      // Everything except the vehicle we are sitting in is solid to us.
      if (v !== this.myVeh) n = vehicleCircles(v.def, v, this.obstacles, n);
    }
    this.obstacles.length = n;
    if (this.myVeh && this.alive) {
      // Seated: we are wherever our seat is.
      seatPosition(this.myVeh.def, this.myVeh, this.mySeat, seatTmp);
      this.pos.set(seatTmp.x, seatTmp.y - 0.45, seatTmp.z);
      const s = this.s;
      s.x = this.pos.x; s.y = this.pos.y; s.z = this.pos.z;
      s.vx = -Math.sin(this.myVeh.yaw) * this.myVeh.speed;
      s.vz = -Math.cos(this.myVeh.yaw) * this.myVeh.speed;
      s.vy = 0;
      s.ground = true;
      s.crouch = false;
      s.chute = false;
      copyMoveState(this.prev, s);
    }
  }

  updateSelf(dt) {
    const s = this.s;
    const view = this.me;
    if (this.alive) {
      view.root.position.copy(this.pos);
      view.root.rotation.y = this.myVeh ? this.myVeh.yaw : this.input.yaw;
      const st = this.st;
      const armed = !!(st && st.s !== 2 && st.w[st.s]);
      view.setWeapon(armed ? WEAPON_KINDS.indexOf(st.w[st.s][0]) : -1);
      view.update(dt, {
        speed: Math.sqrt(s.vx * s.vx + s.vz * s.vz), pitch: this.input.pitch, crouch: s.crouch, chute: s.chute,
        ground: s.ground, armed: armed && !(this.myVeh && this.mySeat === 0), reloading: !!(st && st.rl),
        swim: isSwimming(this.world, s), seated: !!this.myVeh, down: !!(st && st.dn),
      });
      view.root.visible = !this.scoped;
    } else if (view.dead > 0) {
      view.root.visible = true;
      view.update(dt, {});
      if (view.dead > 4) view.root.visible = false;
    }
  }

  updateRemotes(dt) {
    const rt = this.renderTime;
    for (const [id, r] of this.players) {
      const view = r.view;
      if (r.dying) {
        r.dying += dt;
        view.update(dt, {});
        if (r.dying > 3.5) {
          view.dispose();
          this.players.delete(id);
        }
        continue;
      }
      const buf = r.buf;
      if (!buf.length) continue;
      let i = buf.length - 1;
      while (i > 0 && buf[i].t > rt) i--;
      const a = buf[i];
      const b = buf[i + 1] || a;
      let k = b.t > a.t ? (rt - a.t) / (b.t - a.t) : 0;
      k = k < 0 ? 0 : k > 1 ? 1 : k;
      const x = a.x + (b.x - a.x) * k;
      const y = a.y + (b.y - a.y) * k;
      const z = a.z + (b.z - a.z) * k;
      const span = (b.t - a.t) / 1000;
      const speed = span > 0 ? Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) / span : 0;
      r.speed += (speed - r.speed) * Math.min(1, dt * 10);
      const f = b.f;
      r.x = x; r.y = y; r.z = z;
      r.yaw = lerpAngle(a.yaw, b.yaw, k);
      r.crouch = (f & PF.CROUCH) !== 0;
      r.chute = (f & PF.CHUTE) !== 0;
      r.down = (f & PF.DOWN) !== 0;
      const seated = (f & PF.VEHICLE) !== 0;
      const ride = seated ? this.seatOf.get(id) : null;
      view.root.position.set(x, y, z);
      view.root.rotation.y = ride ? ride.yaw : r.yaw;
      view.setWeapon(b.w);
      view.update(dt, {
        speed: r.speed, pitch: a.pitch + (b.pitch - a.pitch) * k, crouch: r.crouch, chute: r.chute,
        ground: (f & PF.GROUND) !== 0, armed: b.w >= 0, reloading: (f & PF.RELOAD) !== 0, swim: isSwimming(this.world, r),
        seated, down: r.down,
      });
      if ((f & PF.GROUND) && r.speed > 3.4 && !r.crouch && !seated) {
        r.stepDist += r.speed * dt;
        if (r.stepDist > 2.3) {
          r.stepDist = 0;
          this.audio.step(x, z, false);
        }
      }
    }
  }

  nextSpectate() {
    const ids = [];
    for (const [id, r] of this.players) if (!r.dying) ids.push(id);
    if (!ids.length) return;
    // Team-mates first, then everyone else.
    ids.sort((a, b) => (this.isMate(b) ? 1 : 0) - (this.isMate(a) ? 1 : 0) || a - b);
    const i = ids.indexOf(this.spectateId);
    this.spectateId = ids[(i + 1) % ids.length];
  }

  updateCamera(dt) {
    const input = this.input;
    const cam = this.camera;
    const yaw = input.yaw;
    const pitch = input.pitch;
    const dir = dirFromAngles(yaw, pitch, this.camDir);
    let px;
    let py;
    let pz;
    let wantDist = 3.3;
    let wantSide = 0.62;
    let wantUp = 0.18;
    let wantFov = BASE_FOV;
    let scoped = false;
    let eyeTarget = EYE_HEIGHT;

    if (this.alive) {
      const s = this.s;
      px = this.pos.x;
      py = this.pos.y;
      pz = this.pos.z;
      eyeTarget = s.crouch ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
      const ads = input.ads && !s.chute;
      const def = this.activeDef();
      if (this.myVeh) {
        // Chase camera centred on the vehicle.
        px = this.myVeh.x;
        py = this.myVeh.y;
        pz = this.myVeh.z;
        wantDist = this.myVeh.def.cam;
        wantSide = 0;
        wantUp = 1.1;
      } else if (s.chute) {
        wantDist = 7.5;
        wantSide = 0;
        wantUp = 1.4;
      } else if (ads) {
        wantDist = 1.5;
        wantSide = 0.46;
        wantUp = 0.1;
        const zoom = def ? adsZoom(this.st.w[this.st.s][0], this.activeAtt()) : 1.15;
        wantFov = (2 * Math.atan(Math.tan((BASE_FOV * Math.PI) / 360) / zoom) * 180) / Math.PI;
        scoped = !!(def && def.scope && !(this.st && this.st.rl));
      }
      // Smooth out stair steps; follow falls and the parachute directly.
      const dy = py - this.camY;
      this.camY = Math.abs(dy) > 1.2 || s.chute ? py : this.camY + dy * Math.min(1, dt * (this.myVeh ? 8 : 16));
      py = this.camY;
    } else {
      let r = this.players.get(this.spectateId);
      if (!r || r.dying) {
        this.nextSpectate();
        r = this.players.get(this.spectateId);
      }
      if (r && !r.dying) {
        px = r.x; py = r.y; pz = r.z;
        if (r.chute) wantDist = 7;
        else wantDist = 4.2;
        wantSide = 0.3;
        wantUp = 0.4;
        this.hud.setSpectate(this.nameOf(r.id));
      } else {
        px = this.lastDeathPos.x; py = this.lastDeathPos.y; pz = this.lastDeathPos.z;
        wantDist = 5;
      }
    }

    const ease = Math.min(1, dt * 11);
    this.camDist += (wantDist - this.camDist) * ease;
    this.camSide += (wantSide - this.camSide) * ease;
    this.camUp += (wantUp - this.camUp) * ease;
    this.eye += (eyeTarget - this.eye) * Math.min(1, dt * 14);
    this.scoped = scoped && Math.abs(this.fov - wantFov) < 6;
    this.fov += (wantFov - this.fov) * Math.min(1, dt * (scoped ? 16 : 11));
    if (Math.abs(cam.fov - this.fov) > 0.02) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    input.lookScale = Math.tan((this.fov * Math.PI) / 360) / Math.tan((BASE_FOV * Math.PI) / 360);

    const pivotY = py + this.eye + 0.12;
    if (this.scoped) {
      cam.position.set(px + dir.x * 0.25, py + this.eye + dir.y * 0.25, pz + dir.z * 0.25);
    } else {
      const rx = Math.cos(yaw);
      const rz = -Math.sin(yaw);
      let vx = -dir.x * this.camDist + rx * this.camSide;
      let vy = -dir.y * this.camDist + this.camUp;
      let vz = -dir.z * this.camDist + rz * this.camSide;
      const len = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      vx /= len;
      vy /= len;
      vz /= len;
      // Pull the camera in when something is between it and the player.
      const hit = raycastWorld(this.world, px, pivotY, pz, vx, vy, vz, len + 0.3);
      const d = hit < len + 0.3 ? Math.max(0.2, hit - 0.3) : len;
      cam.position.set(px + vx * d, pivotY + vy * d, pz + vz * d);
      const ground = Math.max(this.world.heightAt(cam.position.x, cam.position.z), 0) + 0.2;
      if (cam.position.y < ground) cam.position.y = ground;
    }
    cam.rotation.set(pitch, yaw, 0, 'YXZ');
    if (this.shake > 0.01) {
      // Explosion nearby: jolt the view briefly.
      cam.rotation.x += (Math.random() - 0.5) * this.shake * 0.07;
      cam.rotation.y += (Math.random() - 0.5) * this.shake * 0.07;
      this.shake *= Math.exp(-dt * 6);
    }
    this.app.worldView.follow(px, py, pz);
    this.audio.setListener(px, pz, yaw);
  }

  updateHud(dt) {
    const hud = this.hud;
    const s = this.s;
    hud.setCounts(this.aliveCount, this.kills, this.net.ping);

    // Zone status line.
    const z = this.zone;
    const outside = this.alive && !insideCircle(this.circle, s.x, s.z);
    let text;
    let frac = 0;
    let alert = false;
    if (z.mode === 'wait') {
      const rem = (z.t1 - this.serverTime) / 1000;
      text = 'Zone closes in ' + fmtTime(rem);
      frac = 1 - Math.max(0, Math.min(1, (z.t1 - this.serverTime) / (z.t1 - z.t0)));
      alert = rem < 10;
    } else if (z.mode === 'shrink') {
      text = 'Zone closing ' + fmtTime((z.t1 - this.serverTime) / 1000);
      frac = Math.max(0, Math.min(1, (this.serverTime - z.t0) / (z.t1 - z.t0)));
      alert = true;
    } else {
      text = 'Final zone';
      frac = 1;
      alert = true;
    }
    if (outside) {
      text = 'OUTSIDE THE SAFE ZONE - ' + text;
      alert = true;
    }
    hud.setZone(text, frac, alert);
    hud.setOutside(outside);

    // Crosshair spread.
    const def = this.activeDef();
    const ads = this.input.ads && !s.chute;
    let visible = this.alive && !s.chute && !this.scoped && !(this.myVeh && this.mySeat === 0) && !(this.st && this.st.dn);
    let gap = 7;
    if (def) {
      let deg = (ads ? def.spreadAds * adsSpreadScale(this.activeAtt()) : def.spread) + this.bloom;
      deg += def.movePen * Math.min(1.5, Math.sqrt(s.vx * s.vx + s.vz * s.vz) / WALK_SPEED) * (ads ? 0.6 : 1);
      if (!s.ground) deg += AIR_SPREAD;
      if (s.crouch) deg *= 0.8;
      gap = 3 + (Math.tan((deg * Math.PI) / 180) / Math.tan((this.fov * Math.PI) / 360)) * (window.innerHeight / 2);
      if (def.scope && !ads) gap = Math.min(gap, 60);
    }
    if (!this.alive) visible = false;
    hud.setCrosshair(Math.min(gap, 90), visible);
    hud.setScope(this.scoped);

    // Prompts. "Use" actions (E) come first: revive, get out, get in. Then
    // weapons on the ground (F); everything else is collected by walking over it.
    if (this.frameNo % 6 === 0) {
      const st = this.st;
      const free = this.alive && !s.chute && st && !st.dn;
      let useText = null;
      let useLabel = null;
      if (free && this.myVeh) {
        useLabel = 'EXIT';
      } else if (free) {
        const mate = this.downedMateNear();
        const veh = mate ? null : this.vehicleNear();
        if (mate) {
          useText = st.rv ? null : 'Revive ' + this.nameOf(mate.id);
          useLabel = st.rv ? null : 'REVIVE';
        } else if (veh) {
          useText = (veh.seats[0] ? 'Ride in ' : 'Drive ') + veh.def.name;
          useLabel = veh.seats[0] ? 'RIDE' : 'DRIVE';
        }
      }
      let it = null;
      if (free && !this.myVeh && !useText) it = this.nearestLoot(false);
      if (it !== this.promptItem) {
        this.promptItem = it;
        this.promptSince = performance.now();
      }
      if (useText) {
        hud.setPrompt(useText, this.input.touch ? null : 'E', 'use');
      } else if (it && performance.now() - this.promptSince > 250) {
        const full = st.w[0] && st.w[1];
        hud.setPrompt((full ? 'Swap for ' : 'Pick up ') + ITEMS[it.kind].name, this.input.touch ? null : 'F');
      } else {
        hud.setPrompt(null);
      }
      hud.setUseButton(this.input.touch ? useLabel : null);
      hud.setVehicle(this.myVeh && this.alive
        ? { name: this.myVeh.def.name, kmh: Math.round(Math.abs(this.myVeh.speed) * 3.6), hp: this.myVeh.hp }
        : null);
    }

    const spec = !this.alive ? this.players.get(this.spectateId) : null;
    const mates = [];
    if (this.teamSize > 1 && !this.watching) {
      for (const r of this.players.values()) if (!r.dying && this.isMate(r.id)) mates.push({ x: r.x, z: r.z, down: r.down });
    }
    const vehicles = [];
    for (const v of this.vehicles.values()) if (!v.dead) vehicles.push(v);
    hud.update(dt, {
      circle: this.circle,
      next: z.mode === 'closed' ? null : z.to,
      me: this.alive ? { x: s.x, z: s.z, yaw: this.myVeh ? this.myVeh.yaw : this.input.yaw } : spec ? { x: spec.x, z: spec.z, yaw: spec.yaw } : null,
      others: mates,
      vehicles,
    });
  }

  // A knocked-down team-mate within reach, if any.
  downedMateNear() {
    if (this.teamSize <= 1) return null;
    const s = this.s;
    for (const r of this.players.values()) {
      if (r.dying || !r.down || !this.isMate(r.id)) continue;
      if ((r.x - s.x) ** 2 + (r.z - s.z) ** 2 <= REVIVE_RANGE * REVIVE_RANGE && Math.abs(r.y - s.y) < 2) return r;
    }
    return null;
  }

  // The nearest vehicle with a free seat that is close enough to board.
  vehicleNear() {
    const s = this.s;
    let best = null;
    let bestD = ENTER_RADIUS * ENTER_RADIUS;
    for (const v of this.vehicles.values()) {
      if (v.dead || !v.seats.includes(0) || Math.abs(v.y - s.y) > 2.5) continue;
      vehicleCircles(v.def, v, circleTmp, 0);
      for (let k = 0; k < 2; k++) {
        const d2 = (circleTmp[k].x - s.x) ** 2 + (circleTmp[k].z - s.z) ** 2 - v.def.radius * v.def.radius;
        if (d2 < bestD) {
          bestD = d2;
          best = v;
        }
      }
    }
    return best;
  }

  dispose() {
    this.app.scene.remove(this.root);
    this.root.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
    });
    this.hud.setPrompt(null);
    this.hud.setUseButton(null);
    this.hud.setVehicle(null);
    this.hud.setDowned(null);
    this.hud.setTeam([]);
    this.hud.stopProgress();
    this.hud.setScope(false);
    this.hud.setOutside(false);
    if (this.camera.fov !== BASE_FOV) {
      this.camera.fov = BASE_FOV;
      this.camera.updateProjectionMatrix();
    }
    this.input.lookScale = 1;
  }
}
