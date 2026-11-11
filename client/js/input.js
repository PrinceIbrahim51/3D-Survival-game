// Keyboard + mouse and touch input. Produces a movement vector, look angles,
// held buttons and a queue of one-shot actions for the game to consume.

import { BTN } from '/shared/constants.js';

const MOUSE_SENS = 0.0022;
const TOUCH_SENS = 0.0052;
const STICK_RADIUS = 56;

// Keeps receiving move events for a touch that slides off its element.
function capture(el, pointerId) {
  try {
    el.setPointerCapture(pointerId);
  } catch { /* the pointer is already gone */ }
}

export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.enabled = false; // true while a match is being played
    this.touch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.yaw = 0;
    this.pitch = 0;
    this.mx = 0;
    this.mz = 0;
    this.lookScale = 1; // lowered by the game while aiming down sights
    this.actions = [];
    this.keys = new Set();
    this.fire = false;
    this.ads = false;
    this.crouch = false;
    this.jump = false;
    this.sprint = false;
    this.reloadUntil = 0;
    this.mouseDown = false;
    this.locked = false;
    this.spectating = false; // dead: cursor stays free, drag to look around
    this.paused = false; // settings overlay open: the character stands still
    this.stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
    this.look = { id: null, x: 0, y: 0 };

    this.bindKeyboard();
    this.bindMouse();
    if (this.touch) this.bindTouch();
  }

  act(a, extra) {
    if (this.enabled) this.actions.push({ a, ...extra });
  }

  applyLook(dx, dy, sens) {
    const k = sens * this.settings.sens * this.lookScale;
    this.yaw -= dx * k;
    this.pitch -= dy * k * (this.settings.invert ? -1 : 1);
    if (this.pitch > 1.45) this.pitch = 1.45;
    if (this.pitch < -1.45) this.pitch = -1.45;
    // Keep yaw bounded so precision never degrades in long sessions.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (!this.enabled) return;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      if (this.paused) {
        if (e.code === 'Escape') this.act('resume');
        return;
      }
      this.keys.add(e.code);
      switch (e.code) {
        case 'Digit1': this.act('slot', { n: 0 }); break;
        case 'Digit2': this.act('slot', { n: 1 }); break;
        case 'Digit3': this.act('slot', { n: 2 }); break;
        case 'Digit4': this.act('heal', { k: 'bandage' }); break;
        case 'Digit5': this.act('heal', { k: 'medkit' }); break;
        case 'KeyH': this.act('heal', {}); break;
        case 'KeyQ': this.act('swap'); break;
        case 'KeyF': case 'KeyE': this.act('pickup'); break;
        case 'KeyG': this.act('drop'); break;
        case 'KeyM': case 'Tab': this.act('map'); break;
        case 'KeyC': this.crouch = !this.crouch; break;
        case 'KeyN': this.act('next'); break;
        case 'Space': if (this.spectating) this.act('next'); break;
        case 'KeyR': this.reloadUntil = performance.now() + 150; break;
        case 'Escape': this.act('pause'); break;
        default:
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.fire = false;
      this.mouseDown = false;
    });
  }

  bindMouse() {
    const c = this.canvas;
    c.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.touch || this.paused) return;
      this.mouseDown = true;
      if (this.spectating) return;
      this.lock();
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.ads = true;
    });
    window.addEventListener('mouseup', (e) => {
      this.mouseDown = false;
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.ads = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || this.touch) return;
      // Pointer lock is preferred; dragging with a button held also works.
      if (this.locked || this.mouseDown) this.applyLook(e.movementX || 0, e.movementY || 0, MOUSE_SENS);
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      if (this.enabled) this.act('swap', { dir: Math.sign(e.deltaY) });
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === c;
      if (was && !this.locked) {
        this.fire = false;
        this.ads = false;
        this.act('pause');
      }
    });
  }

  lock() {
    if (this.touch || this.spectating || this.paused || this.locked || !this.canvas.requestPointerLock) return;
    const p = this.canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  bindTouch() {
    const $ = (id) => document.getElementById(id);
    const stickEl = $('stick');
    const knob = stickEl.firstElementChild;
    const zone = $('stickzone');
    const setKnob = () => {
      knob.style.transform = `translate(${this.stick.x * STICK_RADIUS}px, ${this.stick.y * STICK_RADIUS}px)`;
    };
    zone.addEventListener('pointerdown', (e) => {
      if (this.stick.id !== null) return;
      capture(zone, e.pointerId);
      this.stick.id = e.pointerId;
      this.stick.ox = e.clientX;
      this.stick.oy = e.clientY;
      stickEl.classList.add('live');
      stickEl.style.left = e.clientX + 'px';
      stickEl.style.top = e.clientY + 'px';
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stick.id) return;
      let dx = (e.clientX - this.stick.ox) / STICK_RADIUS;
      let dy = (e.clientY - this.stick.oy) / STICK_RADIUS;
      const l = Math.hypot(dx, dy);
      // Pushing the stick far forward sprints.
      this.sprint = l > 1.25 && dy < -0.7;
      if (l > 1) {
        dx /= l;
        dy /= l;
      }
      this.stick.x = dx;
      this.stick.y = dy;
      setKnob();
    });
    const endStick = (e) => {
      if (e.pointerId !== this.stick.id) return;
      this.stick.id = null;
      this.stick.x = this.stick.y = 0;
      this.sprint = false;
      stickEl.classList.remove('live');
      stickEl.style.left = '';
      stickEl.style.top = '';
      setKnob();
    };
    zone.addEventListener('pointerup', endStick);
    zone.addEventListener('pointercancel', endStick);

    // Anything that should also turn the camera while held.
    const lookPad = (el, onDown, onUp) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        capture(el, e.pointerId);
        el._pid = e.pointerId;
        el._x = e.clientX;
        el._y = e.clientY;
        if (onDown) onDown();
      });
      el.addEventListener('pointermove', (e) => {
        if (e.pointerId !== el._pid) return;
        this.applyLook(e.clientX - el._x, e.clientY - el._y, TOUCH_SENS);
        el._x = e.clientX;
        el._y = e.clientY;
      });
      const up = (e) => {
        if (e.pointerId !== el._pid) return;
        el._pid = null;
        if (onUp) onUp();
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    lookPad($('lookzone'));
    const fireBtn = $('t-fire');
    lookPad(fireBtn, () => { this.fire = true; fireBtn.classList.add('on'); }, () => { this.fire = false; fireBtn.classList.remove('on'); });
    const fire2 = $('t-fire2');
    lookPad(fire2, () => { this.fire = true; fire2.classList.add('on'); }, () => { this.fire = false; fire2.classList.remove('on'); });
    const jump = $('t-jump');
    lookPad(jump, () => { this.jump = true; }, () => { this.jump = false; });

    const tap = (id, fn) => {
      const el = $(id);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        fn(el);
      });
    };
    tap('t-ads', (el) => {
      this.ads = !this.ads;
      el.classList.toggle('on', this.ads);
    });
    tap('t-crouch', (el) => {
      this.crouch = !this.crouch;
      el.classList.toggle('on', this.crouch);
    });
    tap('t-reload', () => { this.reloadUntil = performance.now() + 150; });
    tap('t-pickup', () => this.act('pickup'));
  }

  // Called when a match starts or ends.
  reset(yaw = 0) {
    this.yaw = yaw;
    this.pitch = -0.2;
    this.spectating = false;
    this.paused = false;
    this.fire = false;
    this.ads = false;
    this.crouch = false;
    this.jump = false;
    this.sprint = false;
    this.keys.clear();
    this.actions.length = 0;
    for (const id of ['t-ads', 't-crouch']) {
      const el = document.getElementById(id);
      if (el) el.classList.remove('on');
    }
  }

  // Samples the current movement vector and button bit mask.
  sample() {
    let mx = 0;
    let mz = 0;
    const k = this.keys;
    if (this.paused) {
      this.mx = 0;
      this.mz = 0;
      return this.crouch ? BTN.CROUCH : 0;
    }
    if (k.has('KeyW') || k.has('ArrowUp')) mz += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) mz -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (this.stick.id !== null) {
      mx = this.stick.x;
      mz = -this.stick.y;
    }
    // Rounded so the exact same numbers are used for prediction and sent to the server.
    this.mx = Math.round(mx * 1000) / 1000;
    this.mz = Math.round(mz * 1000) / 1000;
    let b = 0;
    if (k.has('Space') || this.jump) b |= BTN.JUMP;
    if (k.has('ShiftLeft') || k.has('ShiftRight') || this.sprint) b |= BTN.SPRINT;
    if (this.crouch || k.has('ControlLeft')) b |= BTN.CROUCH;
    if (this.ads) b |= BTN.ADS;
    if (this.fire) b |= BTN.FIRE;
    if (k.has('KeyR') || performance.now() < this.reloadUntil) b |= BTN.RELOAD;
    return b;
  }
}
