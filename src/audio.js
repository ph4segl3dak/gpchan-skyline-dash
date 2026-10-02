// Synthesized music and effects. No audio files; everything is WebAudio.
const BPM = 152;
const STEP = 60 / BPM / 4; // 16th note
// IV - V - iii - vi in C (the "royal road" progression), two bars each.
const CHORDS = [
  [53, 57, 60, 64], [55, 59, 62, 65], [52, 55, 59, 62], [57, 60, 64, 67],
];
const BASS = [41, 43, 40, 45];
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

export class Audio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.musicOn = false;
    this.step = 0;
    this.nextTime = 0;
    this.intensity = 0;
    this.boost = false;
    this.chipChain = 0;
    this.chipTime = 0;
  }

  unlock() {
    if (!this.ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return false;
      this.ctx = new C();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.7;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      this.master.connect(comp).connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.42;
      this.musicBus.connect(this.master);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 0.8;
      this.sfxBus.connect(this.master);
      // Low-pass on the music for muffled moments (pause, falling).
      this.musicLP = this.ctx.createBiquadFilter();
      this.musicLP.type = 'lowpass'; this.musicLP.frequency.value = 18000;
      this.musicIn = this.ctx.createGain();
      this.musicIn.connect(this.musicLP).connect(this.musicBus);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.timer = setInterval(() => this.schedule(), 25);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return true;
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.03);
  }

  muffle(on) {
    if (this.musicLP) this.musicLP.frequency.setTargetAtTime(on ? 600 : 18000, this.ctx.currentTime, 0.08);
  }

  startMusic() {
    if (!this.ctx) return;
    this.musicOn = true;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.08;
    this.muffle(false);
  }

  stopMusic() { this.musicOn = false; }

  schedule() {
    if (!this.musicOn || !this.ctx) return;
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += STEP;
      this.step++;
    }
  }

  playStep(i, t) {
    const s16 = i % 16, bar = Math.floor(i / 16), chord = Math.floor(bar / 2) % 4;
    const lvl = this.intensity;
    // Kick: four on the floor
    if (s16 % 4 === 0) this.kick(t);
    // Snare / clap on 2 and 4
    if (s16 === 4 || s16 === 12) this.snare(t);
    // Off-beat open hat, 16th closed hats when intense
    if (s16 % 4 === 2) this.hat(t, 0.08, 0.12);
    else if (lvl > 0.35 || this.boost) this.hat(t, 0.025, 0.05);
    // Octave bass on 8ths
    if (s16 % 2 === 0) {
      const n = BASS[chord] + (s16 % 4 === 2 ? 12 : 0);
      this.pluck(mtof(n - 12), t, STEP * 1.6, 'sawtooth', 0.16, 900);
    }
    // Chord stabs on the off-beats
    if (s16 === 2 || s16 === 6 || s16 === 10 || s16 === 14 || (s16 === 7 && bar % 2)) {
      for (const n of CHORDS[chord]) this.pluck(mtof(n), t, STEP * 1.2, 'square', 0.028, 2600);
    }
    // Arpeggio lead joins as the multiplier climbs
    if (lvl > 0.15) {
      const notes = CHORDS[chord];
      const n = notes[[0, 2, 1, 3, 2, 1, 3, 2][s16 % 8]] + 12;
      this.pluck(mtof(n), t, STEP * 0.9, 'triangle', 0.05 * Math.min(1, lvl * 2), 5000);
    }
    // Hook melody at high intensity
    if (lvl > 0.55 && bar % 2 === 0) {
      const mel = [0, -1, -1, 2, -1, 4, -1, 2, 0, -1, 7, -1, 4, -1, 2, -1];
      const iv = mel[s16];
      if (iv >= 0) this.pluck(mtof(CHORDS[chord][0] + 24 + iv), t, STEP * 1.8, 'sawtooth', 0.035, 3800);
    }
  }

  kick(t) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.55, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g).connect(this.musicIn); o.start(t); o.stop(t + 0.25);
  }

  snare(t) {
    this.noiseHit(t, 0.16, 0.18, 1800, 'bandpass', this.musicIn, 0.8);
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g).connect(this.musicIn); o.start(t); o.stop(t + 0.12);
  }

  hat(t, gain, dur) { this.noiseHit(t, dur, gain, 9000, 'highpass', this.musicIn); }

  noiseHit(t, dur, gain, freq, type, dest, q = 0.7) {
    const src = this.ctx.createBufferSource(); src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
  }

  pluck(freq, t, dur, type, gain, cutoff, dest = this.musicIn) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    f.type = 'lowpass'; f.frequency.setValueAtTime(cutoff, t); f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff * 0.3), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(dest);
    o.start(t); o.stop(t + dur + 0.02);
  }

  tone(freq, dur, { type = 'sine', gain = 0.2, to = null, delay = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfxBus); o.start(t); o.stop(t + dur + 0.02);
  }

  swoosh(dur, from, to, gain = 0.2, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource(); src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus); src.start(t, Math.random() * 0.4); src.stop(t + dur + 0.02);
  }

  play(type, data = {}) {
    if (!this.ctx || this.muted) return;
    switch (type) {
      case 'jump': this.tone(380, 0.14, { type: 'square', gain: 0.07, to: 760 }); this.swoosh(0.18, 800, 2400, 0.12); break;
      case 'doubleJump': this.tone(620, 0.1, { type: 'triangle', gain: 0.12, to: 1240 }); this.tone(930, 0.16, { type: 'triangle', gain: 0.09, to: 1860, delay: 0.06 }); this.swoosh(0.3, 1200, 5000, 0.12); break;
      case 'land': this.tone(110, 0.09, { gain: 0.22 * Math.min(1, (data.fall || 6) / 14), to: 60 }); this.swoosh(0.08, 500, 300, 0.06); break;
      case 'slide': this.swoosh(0.5, 3000, 600, 0.16); break;
      case 'dive': this.swoosh(0.22, 2500, 400, 0.16); this.tone(500, 0.18, { type: 'sawtooth', gain: 0.05, to: 120 }); break;
      case 'lane': this.swoosh(0.12, 1400, 2600, 0.09); break;
      case 'edge': this.tone(140, 0.06, { type: 'square', gain: 0.05 }); break;
      case 'chip': {
        const now = this.ctx.currentTime;
        this.chipChain = now - this.chipTime < 0.45 ? Math.min(this.chipChain + 1, 14) : 0;
        this.chipTime = now;
        const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33];
        const f = mtof(84 + scale[this.chipChain]);
        this.tone(f, 0.12, { type: 'sine', gain: 0.09 }); this.tone(f * 2, 0.08, { type: 'triangle', gain: 0.03 });
        break;
      }
      case 'power': [0, 4, 7, 12, 16].forEach((n, i) => this.tone(mtof(72 + n), 0.18, { type: 'square', gain: 0.06, delay: i * 0.05 })); break;
      case 'mult': [0, 7, 12].forEach((n, i) => this.tone(mtof(76 + n + Math.min(data.mult || 2, 8)), 0.22, { type: 'sawtooth', gain: 0.06, delay: i * 0.07 })); break;
      case 'trick': this.tone(mtof(88), 0.1, { type: 'triangle', gain: 0.05 }); break;
      case 'wallStart': this.swoosh(0.6, 600, 3000, 0.16); this.tone(300, 0.3, { type: 'triangle', gain: 0.06, to: 600 }); break;
      case 'pad': this.tone(180, 0.4, { type: 'sine', gain: 0.25, to: 900 }); this.swoosh(0.5, 400, 4000, 0.14); break;
      case 'bump': this.tone(90, 0.2, { type: 'square', gain: 0.14, to: 50 }); this.swoosh(0.15, 300, 200, 0.2); break;
      case 'crash': this.tone(200, 0.6, { type: 'sawtooth', gain: 0.16, to: 40 }); this.swoosh(0.6, 2000, 150, 0.35); break;
      case 'smash': this.swoosh(0.3, 3000, 400, 0.3); this.tone(140, 0.2, { type: 'square', gain: 0.12, to: 60 }); break;
      case 'shieldBreak': [0, 3, 7].forEach((n, i) => this.tone(mtof(96 - n * 2), 0.25, { type: 'triangle', gain: 0.08, delay: i * 0.04 })); this.swoosh(0.4, 6000, 2000, 0.2); break;
      case 'mantle': this.swoosh(0.15, 700, 1200, 0.12); this.tone(160, 0.08, { gain: 0.1 }); break;
      case 'start': [0, 4, 7, 12].forEach((n, i) => this.tone(mtof(64 + n), 0.15, { type: 'square', gain: 0.07, delay: i * 0.08 })); break;
      case 'ui': this.tone(880, 0.06, { type: 'triangle', gain: 0.06 }); break;
      case 'best': [0, 4, 7, 12, 16, 19, 24].forEach((n, i) => this.tone(mtof(72 + n), 0.25, { type: 'square', gain: 0.06, delay: i * 0.07 })); break;
    }
  }
}
