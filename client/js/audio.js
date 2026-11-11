// All sound is synthesised with the Web Audio API, so there are no audio files
// to download or license.

const SHOT = {
  pistol: { freq: 900, decay: 0.12, thump: 160, gain: 0.5 },
  smg: { freq: 1100, decay: 0.09, thump: 190, gain: 0.42 },
  ar: { freq: 700, decay: 0.14, thump: 120, gain: 0.55 },
  shotgun: { freq: 420, decay: 0.3, thump: 70, gain: 0.8 },
  sniper: { freq: 520, decay: 0.45, thump: 55, gain: 0.9 },
};

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.volume = 0.7;
    this.listener = { x: 0, z: 0, yaw: 0 };
  }

  // Browsers only allow audio after a user gesture; call this from one.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, len);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  setListener(x, z, yaw) {
    this.listener.x = x;
    this.listener.z = z;
    this.listener.yaw = yaw;
  }

  // Returns [gain, pan] for a sound at world position (x, z).
  spatial(x, z, range) {
    if (x === undefined) return [1, 0];
    const dx = x - this.listener.x;
    const dz = z - this.listener.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > range) return [0, 0];
    const gain = 1 / (1 + (d / (range * 0.12)) ** 1.5);
    // Project onto the listener's right vector.
    const right = dx * Math.cos(this.listener.yaw) - dz * Math.sin(this.listener.yaw);
    const pan = d > 0.5 ? Math.max(-1, Math.min(1, right / d)) * 0.8 : 0;
    return [gain, pan];
  }

  out(gain, pan) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  noiseBurst(dest, { freq, q = 0.8, decay, gain, type = 'bandpass', delay = 0 }) {
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + decay + 0.02);
  }

  tone(dest, { freq, to, decay, gain, type = 'sine', delay = 0 }) {
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + decay);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + decay + 0.02);
  }

  shot(kind, x, z) {
    if (!this.ctx) return;
    const s = SHOT[kind];
    if (!s) return;
    const [gain, pan] = this.spatial(x, z, 260);
    if (gain < 0.01) return;
    const dest = this.out(gain * s.gain, pan);
    this.noiseBurst(dest, { freq: s.freq, q: 0.6, decay: s.decay, gain: 1 });
    this.noiseBurst(dest, { freq: 3500, q: 0.4, decay: s.decay * 0.35, gain: 0.5, type: 'highpass' });
    this.tone(dest, { freq: s.thump * 1.6, to: s.thump * 0.5, decay: s.decay * 0.9, gain: 0.9 });
  }

  step(x, z, own) {
    if (!this.ctx) return;
    const [gain, pan] = this.spatial(x, z, 22);
    if (gain < 0.02) return;
    const dest = this.out(gain * (own ? 0.12 : 0.3), pan);
    this.noiseBurst(dest, { freq: 260 + Math.random() * 120, q: 1.2, decay: 0.07, gain: 1, type: 'lowpass' });
  }

  swing(x, z) {
    if (!this.ctx) return;
    const [gain, pan] = this.spatial(x, z, 20);
    if (gain < 0.02) return;
    this.noiseBurst(this.out(gain * 0.3, pan), { freq: 900, q: 2, decay: 0.16, gain: 1 });
  }

  ui(name) {
    if (!this.ctx) return;
    const dest = this.out(1, 0);
    switch (name) {
      case 'hit': this.tone(dest, { freq: 1500, decay: 0.05, gain: 0.25, type: 'square' }); break;
      case 'head': this.tone(dest, { freq: 2100, decay: 0.09, gain: 0.3, type: 'square' }); break;
      case 'kill':
        this.tone(dest, { freq: 660, decay: 0.12, gain: 0.3, type: 'triangle' });
        this.tone(dest, { freq: 990, decay: 0.2, gain: 0.3, type: 'triangle', delay: 0.09 });
        break;
      case 'hurt':
        this.tone(dest, { freq: 150, to: 60, decay: 0.2, gain: 0.6 });
        this.noiseBurst(dest, { freq: 500, decay: 0.1, gain: 0.3, type: 'lowpass' });
        break;
      case 'pickup': this.tone(dest, { freq: 520, to: 880, decay: 0.1, gain: 0.22, type: 'triangle' }); break;
      case 'empty': this.tone(dest, { freq: 1900, decay: 0.03, gain: 0.15, type: 'square' }); break;
      case 'reload':
        this.noiseBurst(dest, { freq: 2400, q: 3, decay: 0.05, gain: 0.3 });
        this.noiseBurst(dest, { freq: 1700, q: 3, decay: 0.06, gain: 0.3, delay: 0.22 });
        break;
      case 'heal': this.tone(dest, { freq: 440, to: 700, decay: 0.35, gain: 0.2 }); break;
      case 'zone':
        this.tone(dest, { freq: 330, decay: 0.3, gain: 0.25, type: 'sawtooth' });
        this.tone(dest, { freq: 330, decay: 0.3, gain: 0.25, type: 'sawtooth', delay: 0.4 });
        break;
      case 'land': this.noiseBurst(dest, { freq: 180, decay: 0.2, gain: 0.5, type: 'lowpass' }); break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(dest, { freq: f, decay: 0.4, gain: 0.25, type: 'triangle', delay: i * 0.14 }));
        break;
      case 'lose': this.tone(dest, { freq: 300, to: 110, decay: 0.7, gain: 0.3, type: 'sawtooth' }); break;
      case 'click': this.tone(dest, { freq: 800, decay: 0.04, gain: 0.12, type: 'square' }); break;
      default:
    }
  }
}
