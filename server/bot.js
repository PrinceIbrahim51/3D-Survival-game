// Server-side bots. They fill matches so the game is playable alone, and they
// use exactly the same input path as humans (applyInput), so they obey every
// movement, fire-rate and inventory rule.

import { BTN, eyeHeight, SPRINT_SPEED } from '../shared/constants.js';
import { WEAPONS, ITEMS, HEAL, ATTACHMENTS, THROW_SPEED } from '../shared/items.js';
import { raycastWorld } from '../shared/physics.js';
import { insideCircle } from '../shared/zone.js';
import * as Inv from './inventory.js';
import { getNav } from './nav.js';

export const BOT_NAMES = [
  'Arun', 'Kavya', 'Senthil', 'Meena', 'Karthik', 'Anjali', 'Vikram', 'Divya', 'Ravi', 'Lakshmi',
  'Bala', 'Priya', 'Ganesh', 'Nila', 'Suresh', 'Revathi', 'Mani', 'Deepa', 'Rajan', 'Kamala',
  'Gopal', 'Sindhu', 'Murali', 'Yamini', 'Harish', 'Pavithra',
];

// How far (metres) a bot will open fire with each weapon.
const ENGAGE_RANGE = { pistol: 38, smg: 42, ar: 75, shotgun: 20, sniper: 120 };
const IDEAL_RANGE = { pistol: 16, smg: 14, ar: 30, shotgun: 7, sniper: 60 };
const VIEW_RANGE = 65;
const NOTICE_RANGE = 14; // within this distance bots notice enemies behind them too
const TURN_RATE = 5.5; // radians per second
const BOT_VS_BOT_RANGE = 26;
const GRACE_SECONDS = 28; // bots do not start fights this early in a match
const BASE_AIM_ERROR = 0.11; // radians, scaled by each bot's skill

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Bot {
  constructor(match, player) {
    this.m = match;
    this.p = player;
    this.nav = getNav(match.world);
    const r = match.rnd;
    this.skill = 0.55 + r() * 0.75; // higher = better aim
    this.reaction = 0.45 + r() * 0.6;
    this.yaw = player.yaw;
    this.pitch = 0;
    this.goal = null; // { x, z, item? }
    this.path = null;
    this.pathIdx = 0;
    this.repathAt = 0;
    this.thinkAt = r() * 0.3;
    this.lootAt = 0;
    this.target = null;
    this.targetVisible = false;
    this.seenAt = 0;
    this.lastSeen = null;
    this.strafe = 1;
    this.strafeUntil = 0;
    this.burstUntil = 0;
    this.pauseUntil = 0;
    this.errYaw = 0;
    this.errPitch = 0;
    this.errAt = 0;
    this.ignore = new Map();
    this.checkAt = 1;
    this.checkX = 0;
    this.checkZ = 0;
    this.jumpUntil = 0;
    this.dodgeUntil = 0;
    this.dodgeDir = 1;
    this.zonePhase = -1;
    this.zoneGoal = null;
    this.dropGoal = this.pickDropGoal();
    this.inp = { mx: 0, mz: 0, yaw: this.yaw, pitch: 0, b: 0, ay: this.yaw, ap: 0 };
  }

  pickDropGoal() {
    const s = this.p.s;
    let best = null;
    let bestScore = Infinity;
    const taken = this.m.dropGoals || (this.m.dropGoals = []);
    for (const sp of this.m.world.lootSpawns) {
      const d = Math.sqrt((sp.x - s.x) ** 2 + (sp.z - s.z) ** 2);
      if (d > 85) continue;
      let score = d * (0.4 + this.m.rnd());
      // Spread out: avoid landing on top of another bot's chosen spot.
      for (const g of taken) {
        if ((g.x - sp.x) ** 2 + (g.z - sp.z) ** 2 < 40 * 40) score += 80;
      }
      if (score < bestScore) {
        bestScore = score;
        best = sp;
      }
    }
    const goal = best ? { x: best.x, z: best.z } : { x: s.x * 0.7, z: s.z * 0.7 };
    taken.push(goal);
    return goal;
  }

  onHurt(attacker) {
    if (!attacker || !attacker.alive || this.target === attacker) return;
    // Turn on whoever is shooting us, even if we had not spotted them.
    if (!this.target || !this.targetVisible) {
      this.target = attacker;
      this.seenAt = this.m.time / 1000 - this.reaction * 0.5;
      this.lastSeen = { x: attacker.s.x, z: attacker.s.z, t: this.m.time / 1000 };
    }
    this.dodgeUntil = this.m.time / 1000 + 0.8;
    this.dodgeDir = this.m.rnd() < 0.5 ? -1 : 1;
  }

  hasGun() {
    const inv = this.p.inv;
    for (const w of inv.weapons) {
      if (w && (w.mag > 0 || inv.ammo[WEAPONS[w.kind].ammo] > 0)) return true;
    }
    return false;
  }

  canSee(q) {
    const s = this.p.s;
    const ox = s.x;
    const oy = s.y + eyeHeight(s.crouch);
    const oz = s.z;
    const dx = q.s.x - ox;
    const dy = q.s.y + 1.2 - oy;
    const dz = q.s.z - oz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 0.5) return true;
    if (this.m.smokes.length && this.m.smokeBlocks(ox, oy, oz, q.s.x, q.s.y + 1.2, q.s.z)) return false;
    return raycastWorld(this.m.world, ox, oy, oz, dx / d, dy / d, dz / d, d) >= d - 0.3;
  }

  // Chooses the weapon best suited to the distance of the current target.
  chooseWeapon(dist) {
    const inv = this.p.inv;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < 2; i++) {
      const w = inv.weapons[i];
      if (!w) continue;
      if (w.mag <= 0 && inv.ammo[WEAPONS[w.kind].ammo] <= 0) continue;
      let score = -Math.abs(dist - IDEAL_RANGE[w.kind]);
      if (dist > ENGAGE_RANGE[w.kind]) score -= 60;
      if (w.mag <= 0) score -= 15;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best !== -1 && best !== inv.active) this.m.switchSlot(this.p, best);
    else if (best === -1 && inv.active !== Inv.SLOT_MELEE) this.m.switchSlot(this.p, Inv.SLOT_MELEE);
  }

  wants(it) {
    const inv = this.p.inv;
    const info = ITEMS[it.kind];
    switch (info.type) {
      case 'weapon':
        return inv.weapons.includes(null) && !inv.weapons.some((w) => w && w.kind === it.kind) ? 3 : 0;
      case 'ammo': {
        const used = inv.weapons.some((w) => w && WEAPONS[w.kind].ammo === info.ammo);
        if (!used) return 0;
        return inv.ammo[info.ammo] < 60 ? 2 : inv.ammo[info.ammo] < Inv.ammoCap(inv, info.ammo) ? 0.5 : 0;
      }
      case 'heal':
        return inv[info.heal] < Inv.healCap(inv, info.heal) ? 1.2 : 0;
      case 'armor':
        return it.n > inv.armor ? 2 : 0;
      case 'pack':
        return info.level > inv.pack ? 1 : 0;
      case 'throw':
        return inv[info.throw] < 2 ? 0.8 : 0;
      case 'att': {
        const def = ATTACHMENTS[it.kind];
        return inv.weapons.some((w) => w && def.fits.includes(w.kind) && !(w.att & def.bit)) ? 1 : 0;
      }
      default:
        return 0;
    }
  }

  findLoot(t) {
    const s = this.p.s;
    let best = null;
    let bestScore = 0;
    for (const it of this.m.loot.values()) {
      const dx = it.x - s.x;
      const dz = it.z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 75 * 75) continue;
      const until = this.ignore.get(it.id);
      if (until && until > t) continue;
      const want = this.wants(it);
      if (want <= 0) continue;
      // Bots walk on the ground only: skip loot on roofs and towers.
      if (Math.abs(it.y - this.m.world.heightAt(it.x, it.z)) > 0.9) continue;
      if (!insideCircle(this.m.circle, it.x, it.z)) continue;
      const score = want / (8 + Math.sqrt(d2));
      if (score > bestScore) {
        bestScore = score;
        best = it;
      }
    }
    return best;
  }

  zonePoint() {
    const z = this.m.zone;
    if (this.zonePhase === z.phase && this.zoneGoal) return this.zoneGoal;
    const c = z.to.r > 4 ? z.to : z.from;
    let pt = { x: c.x, z: c.z };
    for (let i = 0; i < 12; i++) {
      const x = c.x + (this.m.rnd() * 2 - 1) * c.r * 0.55;
      const zz = c.z + (this.m.rnd() * 2 - 1) * c.r * 0.55;
      if (this.nav.isWalkable(x, zz)) {
        pt = { x, z: zz };
        break;
      }
    }
    this.zonePhase = z.phase;
    this.zoneGoal = pt;
    return pt;
  }

  setGoal(goal) {
    const cur = this.goal;
    if (cur && goal && Math.abs(cur.x - goal.x) < 0.5 && Math.abs(cur.z - goal.z) < 0.5) {
      cur.item = goal.item;
      return;
    }
    this.goal = goal;
    this.path = null;
    this.repathAt = 0;
  }

  think(t) {
    const p = this.p;
    const s = p.s;
    const m = this.m;

    // --- perception --------------------------------------------------------
    let nearest = null;
    let nearestD = VIEW_RANGE * VIEW_RANGE;
    const seen = [];
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    for (const q of m.players.values()) {
      // Team-mates are not targets, and a downed enemy is left to bleed out.
      if (q === p || !q.alive || q.s.chute || q.team === p.team || q.downed) continue;
      const dx = q.s.x - s.x;
      const dz = q.s.z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= nearestD) continue;
      // Bots mostly leave distant bots alone so matches are not over before
      // human players get into the fight.
      if (q.bot && q !== this.target && d2 > BOT_VS_BOT_RANGE * BOT_VS_BOT_RANGE) continue;
      // Limited field of view: enemies behind a bot go unnoticed unless they
      // are very close or already being fought.
      if (q !== this.target && d2 > NOTICE_RANGE * NOTICE_RANGE && dx * fx + dz * fz < 0.25 * Math.sqrt(d2)) continue;
      seen.push([d2, q]);
    }
    seen.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < seen.length && i < 3; i++) {
      // Crouching players are harder to notice at range.
      const q = seen[i][1];
      if (q.s.crouch && seen[i][0] > 45 * 45) continue;
      if (this.canSee(q)) {
        nearest = q;
        nearestD = seen[i][0];
        break;
      }
    }
    // Opening truce: for the first seconds everyone is busy looting, so bots
    // only fight back when shot at.
    if (nearest && t < GRACE_SECONDS * m.zone.scale && nearest !== this.target) nearest = null;
    if (this.passive) nearest = null; // test helper: bots that never start a fight
    if (nearest) {
      if (this.target !== nearest) {
        this.target = nearest;
        this.seenAt = t;
      }
      this.targetVisible = true;
      this.lastSeen = { x: nearest.s.x, z: nearest.s.z, t };
    } else {
      this.targetVisible = false;
      if (this.target && (!this.target.alive || !this.lastSeen || t - this.lastSeen.t > 4)) {
        this.target = null;
        this.lastSeen = null;
      }
    }

    const armed = this.hasGun();
    const dist = Math.sqrt(nearestD);
    if (nearest && p.inv.grenade > 0 && dist > 8 && dist < 15 && t - this.seenAt > 1 && m.rnd() < 0.07) {
      // Lob a grenade: pick the low arc that lands at the target's distance.
      const k = Math.min(1, (20 * dist) / (THROW_SPEED * THROW_SPEED));
      m.throwItem(p, 'grenade', Math.atan2(-(nearest.s.x - s.x), -(nearest.s.z - s.z)), 0.5 * Math.asin(k) - 0.18);
    }
    if (this.target && armed) this.chooseWeapon(this.targetVisible ? dist : 25);
    else if (!armed && p.inv.active !== Inv.SLOT_MELEE) m.switchSlot(p, Inv.SLOT_MELEE);

    // --- helping a downed team-mate up -----------------------------------------
    this.mate = null;
    if (m.teamSize > 1 && !this.targetVisible && !p.reviving) {
      for (const q of m.teams.get(p.team)) {
        if (q === p || !q.alive || !q.downed) continue;
        const d2 = (q.s.x - s.x) ** 2 + (q.s.z - s.z) ** 2;
        if (d2 < 45 * 45) {
          this.mate = q;
          if (d2 < 2 * 2) m.startRevive(p, q);
          break;
        }
      }
    }

    // --- healing -------------------------------------------------------------
    if (!p.heal && !this.targetVisible) {
      if (p.hp < 45 && p.inv.medkit > 0) m.startHeal(p, 'medkit');
      else if (p.hp < HEAL.bandage.upTo - 10 && p.inv.bandage > 0) m.startHeal(p, 'bandage');
      else if (p.hp < 70 && p.inv.medkit > 0) m.startHeal(p, 'medkit');
    }

    // --- where to go ---------------------------------------------------------
    const zone = m.zone;
    const outsideNow = !insideCircle(m.circle, s.x, s.z);
    const next = zone.to.r > 4 ? zone.to : zone.from;
    const outsideNext = !insideCircle({ x: next.x, z: next.z, r: next.r * 0.9 }, s.x, s.z);
    const closingSoon = zone.mode === 'shrink' || zone.t1 - m.time < 25000 * zone.scale;

    if (p.reviving) {
      this.setGoal(null); // stay put until the team-mate is up
    } else if (this.mate && !outsideNow) {
      this.setGoal({ x: this.mate.s.x, z: this.mate.s.z });
    } else if (outsideNow || (outsideNext && closingSoon)) {
      this.setGoal(this.zonePoint());
    } else if (this.target && armed) {
      if (!this.targetVisible && this.lastSeen) this.setGoal({ x: this.lastSeen.x, z: this.lastSeen.z });
      else this.setGoal(null);
    } else {
      const needLoot = !this.goal || !this.goal.item || !m.loot.has(this.goal.item);
      if (needLoot && t >= this.lootAt) {
        this.lootAt = t + 0.8;
        const it = this.findLoot(t);
        if (it) this.setGoal({ x: it.x, z: it.z, item: it.id });
        else if (!this.goal) {
          // Nothing worth grabbing nearby: roam toward the safe area.
          if (outsideNext) this.setGoal(this.zonePoint());
          else {
            const sp = m.world.lootSpawns[Math.floor(m.rnd() * m.world.lootSpawns.length)];
            if (insideCircle(next, sp.x, sp.z)) this.setGoal({ x: sp.x, z: sp.z });
            else this.setGoal(this.zonePoint());
          }
        }
      }
    }

    if (this.goal && (!this.path || t >= this.repathAt)) {
      this.path = this.nav.findPath(s.x, s.z, this.goal.x, this.goal.z);
      this.pathIdx = 0;
      this.repathAt = t + 2.5 + m.rnd();
      if (!this.path) {
        if (this.goal.item) this.ignore.set(this.goal.item, t + 30);
        this.goal = null;
      }
    }
  }

  // Direction to walk along the current path, or null on arrival.
  followPath(t) {
    const s = this.p.s;
    const path = this.path;
    if (!path) return null;
    while (this.pathIdx < path.length) {
      const w = path[this.pathIdx];
      if ((w[0] - s.x) ** 2 + (w[1] - s.z) ** 2 > 0.55 * 0.55) break;
      this.pathIdx++;
    }
    if (this.pathIdx >= path.length) {
      // Arrived. If the item is still there we could not reach it.
      if (this.goal && this.goal.item && this.m.loot.has(this.goal.item)) this.ignore.set(this.goal.item, t + 45);
      this.path = null;
      this.goal = null;
      return null;
    }
    // Cut corners when the way to a later waypoint is clear.
    let k = this.pathIdx;
    const last = Math.min(path.length - 1, this.pathIdx + 6);
    for (let j = last; j > this.pathIdx; j--) {
      if (this.nav.lineClear(s.x, s.z, path[j][0], path[j][1])) {
        k = j;
        break;
      }
    }
    if (k > this.pathIdx + 1) this.pathIdx = k - 1;
    const w = path[k];
    const dx = w[0] - s.x;
    const dz = w[1] - s.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    return { x: dx / d, z: dz / d };
  }

  // Produces this tick's input command.
  update(dt) {
    const p = this.p;
    const s = p.s;
    const m = this.m;
    const t = m.time / 1000;
    const inp = this.inp;
    inp.b = 0;
    inp.mx = 0;
    inp.mz = 0;

    if (s.chute) {
      const dx = this.dropGoal.x - s.x;
      const dz = this.dropGoal.z - s.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      this.yaw = Math.atan2(-dx, -dz);
      inp.mz = d > 2 ? 1 : 0;
      inp.yaw = this.yaw;
      inp.pitch = 0;
      inp.ay = this.yaw;
      inp.ap = 0;
      return inp;
    }

    if (p.downed) {
      // Crawl toward the nearest standing team-mate and hope for a revive.
      let best = null;
      let bd = Infinity;
      for (const q of m.teams.get(p.team)) {
        if (q === p || !q.alive || q.downed) continue;
        const d2 = (q.s.x - s.x) ** 2 + (q.s.z - s.z) ** 2;
        if (d2 < bd) {
          bd = d2;
          best = q;
        }
      }
      if (best && bd > 2.5) {
        this.yaw = Math.atan2(-(best.s.x - s.x), -(best.s.z - s.z));
        inp.mz = 1;
      }
      inp.yaw = this.yaw;
      inp.pitch = 0;
      return inp;
    }
    if (t >= this.thinkAt) {
      this.think(t);
      this.thinkAt = t + 0.22 + m.rnd() * 0.1;
    }

    let wantYaw = this.yaw;
    let wantPitch = 0;
    let moveX = 0; // world-space walk direction
    let moveZ = 0;
    let moving = false;

    const dir = this.followPath(t);
    if (dir) {
      moveX = dir.x;
      moveZ = dir.z;
      moving = true;
      wantYaw = Math.atan2(-dir.x, -dir.z);
      inp.b |= BTN.SPRINT;
    }

    const q = this.target;
    const armed = this.hasGun();
    if (q && q.alive && this.targetVisible) {
      const dx = q.s.x - s.x;
      const dz = q.s.z - s.z;
      const dy = q.s.y + (q.s.crouch ? 0.8 : 1.15) - (s.y + eyeHeight(s.crouch));
      const hd = Math.sqrt(dx * dx + dz * dz) || 0.001;
      if (t >= this.errAt) {
        // Re-roll the aim error a few times per second; moving targets are harder.
        const tv = Math.sqrt(q.s.vx * q.s.vx + q.s.vz * q.s.vz);
        const e = (BASE_AIM_ERROR / this.skill) * (1 + tv / SPRINT_SPEED);
        this.errYaw = (m.rnd() + m.rnd() - 1) * e;
        this.errPitch = (m.rnd() + m.rnd() - 1) * e * 0.6;
        this.errAt = t + 0.25 + m.rnd() * 0.2;
      }
      wantYaw = Math.atan2(-dx, -dz) + this.errYaw;
      wantPitch = Math.atan2(dy, hd) + this.errPitch;
      const w = Inv.activeWeapon(p.inv);
      if (armed && w) {
        const range = ENGAGE_RANGE[w.kind];
        const ideal = IDEAL_RANGE[w.kind];
        const onTarget = Math.abs(angleDiff(wantYaw, this.yaw)) < 0.14;
        if (hd < range && onTarget && t - this.seenAt > this.reaction) {
          const auto = w.kind === 'ar' || w.kind === 'smg';
          if (!auto) {
            // Single-shot weapons: squeeze, then take a moment to re-aim.
            if (t >= this.pauseUntil) {
              inp.b |= BTN.FIRE;
              this.pauseUntil = t + 0.25 + m.rnd() * 0.5;
            }
          }
          else if (t < this.burstUntil) inp.b |= BTN.FIRE;
          else if (t >= this.pauseUntil) {
            this.burstUntil = t + 0.3 + m.rnd() * 0.4;
            this.pauseUntil = this.burstUntil + 0.45 + m.rnd() * 0.55;
          }
        }
        if (hd > 22) inp.b |= BTN.ADS;
        // Strafe, and close in or back off toward the weapon's preferred range.
        if (t >= this.strafeUntil) {
          this.strafe = m.rnd() < 0.5 ? -1 : 1;
          this.strafeUntil = t + 0.6 + m.rnd() * 1.1;
        }
        const fwd = hd > ideal * 1.4 ? 1 : hd < ideal * 0.5 ? -1 : 0;
        const fx = dx / hd;
        const fz = dz / hd;
        moveX = fx * fwd + -fz * this.strafe * 0.9;
        moveZ = fz * fwd + fx * this.strafe * 0.9;
        moving = true;
        inp.b &= ~BTN.SPRINT;
      } else if (hd < 4.5) {
        // Unarmed and cornered: go for a punch.
        moveX = dx / hd;
        moveZ = dz / hd;
        moving = true;
        if (hd < 2) inp.b |= BTN.FIRE;
      }
    } else if (t < this.dodgeUntil && !moving) {
      // Being shot from somewhere unseen: sidestep.
      moveX = Math.cos(this.yaw) * this.dodgeDir;
      moveZ = -Math.sin(this.yaw) * this.dodgeDir;
      moving = true;
    }

    // Top up the magazine when it is quiet.
    const w = Inv.activeWeapon(p.inv);
    if (w && !this.targetVisible && w.mag < WEAPONS[w.kind].mag * 0.5) inp.b |= BTN.RELOAD;

    // Turn smoothly toward the wanted heading.
    const maxTurn = TURN_RATE * dt;
    const dyaw = angleDiff(wantYaw, this.yaw);
    this.yaw += Math.abs(dyaw) <= maxTurn ? dyaw : Math.sign(dyaw) * maxTurn;
    this.pitch += Math.max(-maxTurn, Math.min(maxTurn, wantPitch - this.pitch));

    // Unstick: if we wanted to move but barely did for a second, hop and re-plan.
    if (t >= this.checkAt) {
      const moved = Math.sqrt((s.x - this.checkX) ** 2 + (s.z - this.checkZ) ** 2);
      if (this.wasMoving && moved < 0.5) {
        this.jumpUntil = t + 0.25;
        this.path = null;
        this.repathAt = 0;
        this.strafe = -this.strafe;
        if (this.goal && this.goal.item) {
          this.stuck = (this.stuck || 0) + 1;
          if (this.stuck >= 3) {
            this.ignore.set(this.goal.item, t + 40);
            this.goal = null;
            this.stuck = 0;
          }
        }
      } else {
        this.stuck = 0;
      }
      this.checkX = s.x;
      this.checkZ = s.z;
      this.checkAt = t + 1;
      this.wasMoving = false;
    }
    if (moving) this.wasMoving = true;
    if (t < this.jumpUntil) inp.b |= BTN.JUMP;

    if (moving) {
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      inp.mx = moveX * cos - moveZ * sin;
      inp.mz = -moveX * sin - moveZ * cos;
    }
    inp.yaw = this.yaw;
    inp.pitch = this.pitch;
    inp.ay = this.yaw;
    inp.ap = this.pitch;
    return inp;
  }
}
