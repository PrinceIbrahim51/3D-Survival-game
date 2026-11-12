// Character, weapon and loot models, all built from simple primitives so the
// game ships without any binary art assets.

import * as THREE from 'three';
import { GeoBuilder } from './scene.js';
import { WEAPON_KINDS, ITEMS, AMMO } from '/shared/items.js';

const lambert = new Map();
function mat(color) {
  let m = lambert.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    lambert.set(color, m);
  }
  return m;
}
export const vertexMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

// ------------------------------------------------------------------ weapons
// Models point down -Z with the grip near the origin.

function weaponGeometry(kind) {
  const b = new GeoBuilder();
  const metal = 0x2a2c30;
  const box = (x0, y0, z0, x1, y1, z1, c) => b.box(x0, y0, z0, x1, y1, z1, c, { bottom: true });
  switch (kind) {
    case 'pistol':
      box(-0.025, 0.0, -0.2, 0.025, 0.055, 0.02, 0xb9bec4);
      box(-0.022, -0.12, -0.02, 0.022, 0.0, 0.03, 0x3a2f28);
      break;
    case 'smg':
      box(-0.03, -0.02, -0.34, 0.03, 0.06, 0.1, 0x3d5a73);
      box(-0.014, 0.0, -0.5, 0.014, 0.03, -0.34, metal);
      box(-0.02, -0.2, -0.16, 0.02, -0.02, -0.1, metal);
      box(-0.022, -0.13, 0.0, 0.022, -0.02, 0.05, metal);
      box(-0.02, 0.0, 0.1, 0.02, 0.04, 0.26, metal);
      break;
    case 'ar':
      box(-0.03, -0.03, -0.42, 0.03, 0.06, 0.14, 0x4f5a3c);
      box(-0.015, 0.0, -0.78, 0.015, 0.03, -0.42, metal);
      box(-0.022, -0.2, -0.2, 0.022, -0.03, -0.12, metal);
      box(-0.022, -0.14, 0.02, 0.022, -0.03, 0.07, metal);
      box(-0.025, -0.06, 0.14, 0.025, 0.05, 0.42, 0x3c4530);
      box(-0.012, 0.06, -0.3, 0.012, 0.1, -0.05, metal);
      break;
    case 'shotgun':
      box(-0.028, -0.02, -0.2, 0.028, 0.055, 0.12, metal);
      box(-0.02, 0.0, -0.82, 0.02, 0.045, -0.2, 0x35373b);
      box(-0.03, -0.035, -0.55, 0.03, 0.0, -0.3, 0x7a5332);
      box(-0.026, -0.08, 0.12, 0.026, 0.04, 0.45, 0x7a5332);
      break;
    case 'sniper':
      box(-0.03, -0.03, -0.36, 0.03, 0.055, 0.14, 0xa8946a);
      box(-0.013, 0.0, -1.05, 0.013, 0.028, -0.36, metal);
      box(-0.022, 0.075, -0.3, 0.022, 0.12, 0.06, metal);
      box(-0.01, 0.055, -0.22, 0.01, 0.075, -0.18, metal);
      box(-0.01, 0.055, -0.02, 0.01, 0.075, 0.02, metal);
      box(-0.02, -0.16, -0.14, 0.02, -0.03, -0.08, metal);
      box(-0.026, -0.08, 0.14, 0.026, 0.045, 0.5, 0x8c7a56);
      break;
    default:
  }
  return b.build();
}

const weaponGeo = {};
for (const k of WEAPON_KINDS) weaponGeo[k] = weaponGeometry(k);
export const MUZZLE_LENGTH = { pistol: 0.2, smg: 0.5, ar: 0.78, shotgun: 0.82, sniper: 1.05 };

// --------------------------------------------------------------- characters

const SHIRTS = [0xd94f3d, 0x3d7ed9, 0x39a05a, 0xe0a030, 0x8e5bd0, 0x2aa7a0, 0xd65a9c, 0xf0ede4, 0x596673, 0xc96a2b, 0x7fb341, 0x345e9c];
const PANTS = [0x2f3a56, 0x5a4632, 0x3a3a3a, 0xe8e0c8, 0x2e5a3a, 0x6b3a3a];
const SKIN = [0x8d5a3b, 0xa56a43, 0xc68642, 0x7a4a2e, 0xb97a4f];
const HAIR = [0x16110e, 0x241812, 0x0e0e12];
const CHUTE_COLORS = [0xff9b21, 0xf3f1ea, 0x2bc4b4, 0xf3f1ea];

function part(w, h, d, color, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const m = new THREE.Mesh(g, mat(color));
  m.castShadow = true;
  return m;
}

function parachuteGeometry() {
  const b = new GeoBuilder();
  const segs = 10;
  const R = 2.6;
  const rings = [[R, 0], [R * 0.82, 0.95], [R * 0.45, 1.5], [0.05, 1.7]];
  for (let s = 0; s < segs; s++) {
    const a0 = (s / segs) * Math.PI * 2;
    const a1 = ((s + 1) / segs) * Math.PI * 2;
    const c = CHUTE_COLORS[s % CHUTE_COLORS.length];
    for (let r = 0; r < rings.length - 1; r++) {
      const [ra, ya] = rings[r];
      const [rb, yb] = rings[r + 1];
      b.quad(
        [Math.cos(a0) * ra, ya, Math.sin(a0) * ra], [Math.cos(a0) * rb, yb, Math.sin(a0) * rb],
        [Math.cos(a1) * rb, yb, Math.sin(a1) * rb], [Math.cos(a1) * ra, ya, Math.sin(a1) * ra], c, 0.9 + r * 0.06,
      );
    }
    // Suspension line down to the harness.
    const lx = Math.cos(a0) * R;
    const lz = Math.sin(a0) * R;
    b.quad([lx, 0, lz], [lx * 1.01, 0, lz * 1.01 + 0.03], [0.02, -3.2, 0.03], [0, -3.2, 0], 0x2b2b2b);
  }
  return b.build();
}
let chuteGeo = null;
const chuteMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });

// A blocky humanoid facing -Z. Returns an object with update() for animation.
export function createCharacter(id) {
  const shirt = SHIRTS[(id * 7 + 3) % SHIRTS.length];
  const pants = PANTS[(id * 5 + 1) % PANTS.length];
  const skin = SKIN[(id * 3 + 2) % SKIN.length];
  const hair = HAIR[id % HAIR.length];

  const root = new THREE.Group();
  const body = new THREE.Group(); // everything that leans/crouches
  root.add(body);

  const legL = new THREE.Group();
  const legR = new THREE.Group();
  legL.position.set(-0.13, 0.92, 0);
  legR.position.set(0.13, 0.92, 0);
  legL.add(part(0.19, 0.8, 0.21, pants, 0, -0.4, 0), part(0.2, 0.13, 0.3, 0x1e1e1e, 0, -0.86, -0.04));
  legR.add(part(0.19, 0.8, 0.21, pants, 0, -0.4, 0), part(0.2, 0.13, 0.3, 0x1e1e1e, 0, -0.86, -0.04));
  body.add(legL, legR);

  const torso = new THREE.Group();
  torso.position.set(0, 0.92, 0);
  torso.add(part(0.52, 0.6, 0.28, shirt, 0, 0.3, 0));
  torso.add(part(0.54, 0.1, 0.3, 0x2b2420, 0, 0.03, 0)); // belt
  const vest = part(0.58, 0.44, 0.34, 0x4a5a6a, 0, 0.36, 0);
  vest.visible = false;
  torso.add(vest);
  const pack = part(0.4, 0.46, 0.2, 0x6b5a3a, 0, 0.34, 0.24);
  pack.visible = false;
  torso.add(pack);
  body.add(torso);

  const head = new THREE.Group();
  head.position.set(0, 0.62, 0);
  head.add(part(0.3, 0.3, 0.3, skin, 0, 0.17, 0));
  head.add(part(0.32, 0.12, 0.32, hair, 0, 0.3, 0.01));
  head.add(part(0.32, 0.2, 0.1, hair, 0, 0.2, 0.12));
  torso.add(head);

  const armL = new THREE.Group();
  const armR = new THREE.Group();
  armL.position.set(-0.33, 0.54, 0);
  armR.position.set(0.33, 0.54, 0);
  armL.add(part(0.14, 0.3, 0.15, shirt, 0, -0.13, 0), part(0.12, 0.32, 0.13, skin, 0, -0.42, 0));
  armR.add(part(0.14, 0.3, 0.15, shirt, 0, -0.13, 0), part(0.12, 0.32, 0.13, skin, 0, -0.42, 0));
  torso.add(armL, armR);

  // The weapon is parented to the torso and pitched with the aim.
  const gunPivot = new THREE.Group();
  gunPivot.position.set(0.2, 0.42, -0.1);
  const gun = new THREE.Mesh(weaponGeo.ar, vertexMat);
  gun.position.set(0, 0, -0.42);
  gun.castShadow = true;
  gun.visible = false;
  gunPivot.add(gun);
  torso.add(gunPivot);

  if (!chuteGeo) chuteGeo = parachuteGeometry();
  const chute = new THREE.Mesh(chuteGeo, chuteMat);
  chute.position.set(0, 5.1, 0);
  chute.visible = false;
  root.add(chute);

  const c = {
    root,
    gun,
    gunPivot,
    weapon: -2,
    phase: id * 1.7,
    crouchK: 0,
    punch: 0,
    dead: 0,
    setWeapon(index) {
      if (index === c.weapon) return;
      c.weapon = index;
      const kind = WEAPON_KINDS[index];
      gun.visible = !!kind;
      if (kind) gun.geometry = weaponGeo[kind];
    },
    setGear(armor, packLvl) {
      vest.visible = armor > 0;
      pack.visible = packLvl > 0;
      pack.scale.setScalar(packLvl > 1 ? 1.25 : 1);
    },
    // World position of the muzzle (for tracers and flashes).
    muzzle(out) {
      const kind = WEAPON_KINDS[c.weapon];
      out.set(0, 0.03, -(0.42 + (MUZZLE_LENGTH[kind] ?? 0.1)));
      return gunPivot.localToWorld(out);
    },
    // st: { speed, pitch, crouch, chute, ground, armed, reloading }
    update(dt, st) {
      if (c.dead > 0) {
        // Fall over backwards and sink away.
        c.dead += dt;
        const k = Math.min(1, c.dead / 0.45);
        body.rotation.x = k * 1.5;
        body.position.y = 0.12 * k;
        if (c.dead > 2.2) root.position.y -= dt * 0.6;
        return;
      }
      const moving = Math.min(1, st.speed / 5);
      c.phase += dt * (4 + st.speed * 1.5) * (st.ground ? 1 : 0.3);
      const swing = Math.sin(c.phase) * 0.75 * moving;
      c.crouchK += ((st.crouch ? 1 : 0) - c.crouchK) * Math.min(1, dt * 12);
      const ck = c.crouchK;

      chute.visible = st.chute;
      if (st.chute) {
        legL.rotation.x = 0.25 + Math.sin(c.phase * 0.3) * 0.08;
        legR.rotation.x = 0.1 - Math.sin(c.phase * 0.3) * 0.08;
        armL.rotation.set(2.9, 0, 0.25);
        armR.rotation.set(2.9, 0, -0.25);
        body.rotation.x = 0.12;
        body.position.set(0, 0, 0);
        torso.rotation.x = 0;
        gunPivot.visible = false;
        chute.rotation.z = Math.sin(c.phase * 0.2) * 0.05;
        return;
      }
      if (st.swim) {
        // Front crawl: body level at the surface, arms pulling in turn.
        const stroke = c.phase * 0.55;
        body.rotation.x = -1.2;
        body.position.set(0, 1.2, 0.75);
        torso.rotation.x = 0.25;
        head.rotation.x = 0.7;
        armL.rotation.set(2.6 + Math.sin(stroke) * 1.3, 0, 0.3);
        armR.rotation.set(2.6 - Math.sin(stroke) * 1.3, 0, -0.3);
        legL.rotation.x = Math.sin(stroke * 2) * 0.35;
        legR.rotation.x = -Math.sin(stroke * 2) * 0.35;
        legL.scale.y = 1;
        legR.scale.y = 1;
        gunPivot.visible = false;
        return;
      }
      gunPivot.visible = true;
      body.rotation.x = 0;
      body.position.z = 0;
      // Crouch: fold the legs and drop the hips.
      body.position.y = -0.5 * ck;
      legL.rotation.x = swing * (1 - ck * 0.5) + 1.1 * ck;
      legR.rotation.x = -swing * (1 - ck * 0.5) - 0.5 * ck;
      legL.position.y = 0.92;
      legR.position.y = 0.92;
      legL.scale.y = 1 - 0.3 * ck;
      legR.scale.y = 1 - 0.3 * ck;
      if (!st.ground) {
        legL.rotation.x = 0.5;
        legR.rotation.x = -0.35;
      }
      // Positive rotation about X tips a part backwards (it faces -Z).
      torso.rotation.x = -0.12 * ck + st.pitch * 0.25 - (moving > 0.8 && !st.armed ? 0.12 : 0);
      head.rotation.x = st.pitch * 0.45;

      if (st.armed) {
        const lower = st.reloading ? 0.55 : 0;
        gunPivot.rotation.x = st.pitch * 0.75 - lower;
        armR.rotation.set(1.25 + st.pitch * 0.5 - lower, 0, -0.12);
        armL.rotation.set(1.3 + st.pitch * 0.5 - lower, 0.0, 0.55);
      } else {
        c.punch = Math.max(0, c.punch - dt * 4);
        const p = Math.sin(c.punch * Math.PI);
        armR.rotation.set(-swing * 0.9 + p * 1.9, 0, -0.08);
        armL.rotation.set(swing * 0.9 + 0.2 * p, 0, 0.08);
      }
    },
    dispose() {
      if (root.parent) root.parent.remove(root);
    },
  };
  return c;
}

// --------------------------------------------------------------------- loot

function lootGeometry(kind) {
  const info = ITEMS[kind];
  const b = new GeoBuilder();
  const box = (x0, y0, z0, x1, y1, z1, c) => b.box(x0, y0, z0, x1, y1, z1, c, { bottom: true });
  switch (info.type) {
    case 'ammo': {
      const c = AMMO[info.ammo].color;
      box(-0.16, 0, -0.11, 0.16, 0.16, 0.11, 0x4b4f3a);
      box(-0.165, 0.05, -0.115, 0.165, 0.11, 0.115, c);
      break;
    }
    case 'heal':
      if (info.heal === 'medkit') {
        box(-0.2, 0, -0.14, 0.2, 0.2, 0.14, 0xd8372e);
        box(-0.05, 0.2, -0.11, 0.05, 0.215, 0.11, 0xffffff);
        box(-0.13, 0.2, -0.035, 0.13, 0.215, 0.035, 0xffffff);
      } else {
        box(-0.1, 0, -0.1, 0.1, 0.13, 0.1, 0xf4f1e8);
        box(-0.105, 0.045, -0.105, 0.105, 0.085, 0.105, 0xd8372e);
      }
      break;
    case 'armor': {
      const c = info.level === 2 ? 0x39526b : 0x6f8496;
      box(-0.2, 0, -0.1, 0.2, 0.36, 0.1, c);
      box(-0.2, 0.36, -0.1, -0.09, 0.47, 0.1, c);
      box(0.09, 0.36, -0.1, 0.2, 0.47, 0.1, c);
      box(-0.12, 0.1, -0.115, 0.12, 0.24, -0.1, 0x2a333c);
      break;
    }
    case 'pack': {
      const c = info.level === 2 ? 0x4e6b3a : 0x8a6a40;
      const s = info.level === 2 ? 1.2 : 1;
      box(-0.17 * s, 0, -0.1 * s, 0.17 * s, 0.4 * s, 0.1 * s, c);
      box(-0.12 * s, 0.06 * s, -0.15 * s, 0.12 * s, 0.24 * s, -0.1 * s, 0x3a2f22);
      box(-0.17 * s, 0.4 * s, -0.06 * s, 0.17 * s, 0.45 * s, 0.06 * s, 0x3a2f22);
      break;
    }
    default:
  }
  return b.build();
}

const GLOW = { weapon: 0xffb23e, ammo: 0xd8e06a, heal: 0x7dffa0, armor: 0x7ab8ff, pack: 0xd9a066 };

// Draws every loot item on the ground with one instanced mesh per item kind.
export class LootView {
  constructor(scene) {
    this.scene = scene;
    this.items = new Map(); // id -> { kind, x, y, z, slot }
    this.byKind = new Map();
    this.dummy = new THREE.Object3D();
    const ring = new THREE.RingGeometry(0.28, 0.4, 20);
    ring.rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(
      ring,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending }),
      512,
    );
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.rings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(512 * 3), 3);
    scene.add(this.rings);
    this.color = new THREE.Color();
    this.dirty = true;
  }

  group(kind) {
    let g = this.byKind.get(kind);
    if (!g) {
      const isWeapon = ITEMS[kind].type === 'weapon';
      const mesh = new THREE.InstancedMesh(isWeapon ? weaponGeo[kind] : lootGeometry(kind), vertexMat, 96);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.scene.add(mesh);
      g = { mesh, list: [], isWeapon };
      this.byKind.set(kind, g);
    }
    return g;
  }

  add(id, kind, x, y, z) {
    if (!ITEMS[kind] || this.items.has(id)) return;
    const it = { id, kind, x, y, z, phase: (id * 0.618) % 1 };
    this.items.set(id, it);
    this.group(kind).list.push(it);
    this.dirty = true;
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return;
    this.items.delete(id);
    const list = this.group(it.kind).list;
    list.splice(list.indexOf(it), 1);
    this.dirty = true;
  }

  clear() {
    this.items.clear();
    for (const g of this.byKind.values()) {
      g.list.length = 0;
      g.mesh.count = 0;
    }
    this.rings.count = 0;
    this.dirty = true;
  }

  update(time) {
    const d = this.dummy;
    let r = 0;
    for (const [kind, g] of this.byKind) {
      const n = Math.min(g.list.length, 96);
      g.mesh.count = n;
      const scale = g.isWeapon ? 1.5 : 1.25;
      for (let i = 0; i < n; i++) {
        const it = g.list[i];
        const bob = Math.sin(time * 2 + it.phase * 6.28) * 0.05;
        d.position.set(it.x, it.y + 0.28 + bob, it.z);
        d.rotation.set(0, time * 1.2 + it.phase * 6.28, g.isWeapon ? 0.5 : 0);
        d.scale.setScalar(scale);
        d.updateMatrix();
        g.mesh.setMatrixAt(i, d.matrix);
        if (this.dirty && r < 512) {
          d.position.set(it.x, it.y + 0.04, it.z);
          d.rotation.set(0, 0, 0);
          d.scale.setScalar(g.isWeapon ? 1.3 : 1);
          d.updateMatrix();
          this.rings.setMatrixAt(r, d.matrix);
          this.rings.setColorAt(r, this.color.setHex(GLOW[ITEMS[kind].type]));
          r++;
        }
      }
      g.mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.dirty) {
      this.rings.count = r;
      this.rings.instanceMatrix.needsUpdate = true;
      this.rings.instanceColor.needsUpdate = true;
      this.dirty = false;
    }
  }
}
