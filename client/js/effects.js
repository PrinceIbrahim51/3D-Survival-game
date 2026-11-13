// Short-lived visual effects: bullet tracers, muzzle flashes, impact puffs and
// the wall of the safe zone.

import * as THREE from 'three';

const Z = new THREE.Vector3(0, 0, 1);
const tmp = new THREE.Vector3();

export class Effects {
  constructor(scene) {
    this.scene = scene;

    // Tracers: unit boxes stretched along the bullet path.
    const tgeo = new THREE.BoxGeometry(1, 1, 1);
    tgeo.translate(0, 0, 0.5);
    this.tracers = [];
    for (let i = 0; i < 64; i++) {
      const m = new THREE.Mesh(tgeo, new THREE.MeshBasicMaterial({
        color: 0xfff0b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.tracers.push({ mesh: m, life: 0, max: 1 });
    }
    this.tracerIdx = 0;

    // Muzzle flashes: two crossed quads.
    const fgeo = new THREE.BufferGeometry();
    const s = 0.5;
    fgeo.setAttribute('position', new THREE.Float32BufferAttribute([
      -s, 0, 0, s, 0, 0, s, 0, -1.6 * s, -s, 0, 0, s, 0, -1.6 * s, -s, 0, -1.6 * s,
      0, -s, 0, 0, s, 0, 0, s, -1.6 * s, 0, -s, 0, 0, s, -1.6 * s, 0, -s, -1.6 * s,
      -s, -s, -0.05, s, -s, -0.05, s, s, -0.05, -s, -s, -0.05, s, s, -0.05, -s, s, -0.05,
    ], 3));
    this.flashes = [];
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(fgeo, new THREE.MeshBasicMaterial({
        color: 0xffc860, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide, fog: false,
      }));
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.flashes.push({ mesh: m, life: 0 });
    }
    this.flashIdx = 0;
    this.flashLight = new THREE.PointLight(0xffc070, 0, 14, 1.6);
    scene.add(this.flashLight);

    // Impact puffs.
    const pgeo = new THREE.IcosahedronGeometry(1, 0);
    this.puffs = [];
    for (let i = 0; i < 48; i++) {
      const m = new THREE.Mesh(pgeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false;
      scene.add(m);
      this.puffs.push({ mesh: m, life: 0, max: 1, grow: 1, vy: 0 });
    }
    this.puffIdx = 0;

    // Thrown grenades in flight.
    const ngeo = new THREE.IcosahedronGeometry(0.1, 1);
    this.nadeMats = { grenade: new THREE.MeshLambertMaterial({ color: 0x3f5a2e }), smoke: new THREE.MeshLambertMaterial({ color: 0x9aa3a8 }) };
    this.nadePool = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(ngeo, this.nadeMats.grenade);
      m.visible = false;
      m.castShadow = true;
      scene.add(m);
      this.nadePool.push(m);
    }

    // Explosion fireball.
    this.blasts = [];
    const bgeo = new THREE.IcosahedronGeometry(1, 2);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(bgeo, new THREE.MeshBasicMaterial({
        color: 0xffb347, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      m.visible = false;
      scene.add(m);
      this.blasts.push({ mesh: m, life: 0 });
    }
    this.blastIdx = 0;

    // Smoke clouds: clusters of large soft blobs.
    this.smokeGeo = new THREE.IcosahedronGeometry(1, 1);
    this.clouds = [];

    // Zone wall: tall open cylinder with a scrolling energy texture.
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    // Kept translucent so players can always see through the wall.
    grad.addColorStop(0, 'rgba(120, 90, 255, 0)');
    grad.addColorStop(0.45, 'rgba(120, 110, 255, 0.16)');
    grad.addColorStop(0.8, 'rgba(130, 150, 255, 0.32)');
    grad.addColorStop(1, 'rgba(150, 200, 255, 0.46)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 256);
    ctx.globalCompositeOperation = 'destination-out';
    for (let y = 0; y < 256; y += 16) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, y, 64, 5);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(28, 0, 8, 256);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(160, 1);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.zoneTex = tex;
    this.zone = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 128, 1, true),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false }),
    );
    this.zone.renderOrder = 5;
    this.zone.frustumCulled = false;
    scene.add(this.zone);
  }

  tracer(from, to, thick = 0.035) {
    const t = this.tracers[this.tracerIdx];
    this.tracerIdx = (this.tracerIdx + 1) % this.tracers.length;
    const len = from.distanceTo(to);
    if (len < 0.3) return;
    t.mesh.position.copy(from);
    t.mesh.quaternion.setFromUnitVectors(Z, tmp.subVectors(to, from).divideScalar(len));
    t.mesh.scale.set(thick, thick, len);
    t.mesh.visible = true;
    t.life = t.max = 0.09;
  }

  flash(pos, dir, withLight) {
    const f = this.flashes[this.flashIdx];
    this.flashIdx = (this.flashIdx + 1) % this.flashes.length;
    f.mesh.position.copy(pos);
    // The flash geometry extends along -Z; aim it down the barrel.
    f.mesh.quaternion.setFromUnitVectors(Z, tmp.copy(dir).negate());
    f.mesh.rotateZ(Math.random() * Math.PI);
    f.mesh.scale.setScalar(0.5 + Math.random() * 0.35);
    f.mesh.visible = true;
    f.life = 0.05;
    if (withLight) {
      this.flashLight.position.copy(pos);
      this.flashLight.intensity = 14;
    }
  }

  puff(pos, color, size = 0.12, life = 0.35, rise = 0.6) {
    const p = this.puffs[this.puffIdx];
    this.puffIdx = (this.puffIdx + 1) % this.puffs.length;
    p.mesh.position.copy(pos);
    p.mesh.material.color.setHex(color);
    p.mesh.scale.setScalar(size);
    p.mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    p.mesh.visible = true;
    p.life = p.max = life;
    p.grow = size * 3;
    p.vy = rise;
  }

  takeNade(kind) {
    const m = this.nadePool.find((x) => !x.visible);
    if (!m) return null;
    m.material = this.nadeMats[kind] || this.nadeMats.grenade;
    m.visible = true;
    return m;
  }

  explosion(pos) {
    const b = this.blasts[this.blastIdx];
    this.blastIdx = (this.blastIdx + 1) % this.blasts.length;
    b.mesh.position.copy(pos);
    b.mesh.scale.setScalar(0.6);
    b.mesh.visible = true;
    b.life = 0.32;
    this.flashLight.position.copy(pos).setY(pos.y + 1);
    this.flashLight.intensity = 90;
    for (let i = 0; i < 9; i++) {
      tmp.set((Math.random() - 0.5) * 3.5, Math.random() * 1.6, (Math.random() - 0.5) * 3.5).add(pos);
      this.puff(tmp, i < 3 ? 0xffa64d : 0x4a4640, 0.5 + Math.random() * 0.5, 0.7 + Math.random() * 0.7, 1.2);
    }
  }

  smoke(pos, radius, seconds) {
    const group = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xc9ced1, transparent: true, opacity: 0, depthWrite: false });
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(this.smokeGeo, mat);
      const a = (i / 16) * Math.PI * 2;
      const d = i < 4 ? 0 : radius * (0.3 + Math.random() * 0.45);
      const s = radius * (0.38 + Math.random() * 0.22);
      m.position.set(Math.cos(a) * d, s * (0.55 + Math.random() * 0.5), Math.sin(a) * d);
      m.scale.set(s, s * 0.85, s);
      m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
      group.add(m);
    }
    group.position.copy(pos);
    group.renderOrder = 4;
    this.scene.add(group);
    this.clouds.push({ group, mat, age: 0, life: seconds });
  }

  setZone(circle, time) {
    const r = Math.max(0.01, circle.r);
    this.zone.visible = circle.r > 0.5;
    this.zone.position.set(circle.x, 30, circle.z);
    this.zone.scale.set(r, 90, r);
    this.zoneTex.repeat.x = Math.max(8, Math.round(r * 1.2));
    this.zoneTex.offset.y = -time * 0.05;
    this.zoneTex.offset.x = time * 0.01;
  }

  update(dt) {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.mesh.material.opacity = Math.max(0, t.life / t.max) * 0.9;
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      f.mesh.material.opacity = Math.max(0, f.life / 0.05);
      if (f.life <= 0) f.mesh.visible = false;
    }
    if (this.flashLight.intensity > 0) this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * (this.flashLight.intensity > 20 ? 320 : 220));
    for (const b of this.blasts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      b.mesh.scale.addScalar(dt * 22);
      b.mesh.material.opacity = Math.max(0, b.life / 0.32) * 0.85;
      if (b.life <= 0) b.mesh.visible = false;
    }
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i];
      c.age += dt;
      // Billow in, hang, then thin out.
      c.mat.opacity = Math.min(1, c.age / 1.2, (c.life - c.age) / 2.5) * 0.92;
      c.group.rotation.y += dt * 0.05;
      if (c.age >= c.life) {
        this.scene.remove(c.group);
        c.mat.dispose();
        this.clouds.splice(i, 1);
      }
    }
    for (const p of this.puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const k = Math.max(0, p.life / p.max);
      p.mesh.material.opacity = k * 0.8;
      p.mesh.scale.addScalar(p.grow * dt);
      p.mesh.position.y += p.vy * dt;
      if (p.life <= 0) p.mesh.visible = false;
    }
  }
}
