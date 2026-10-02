// Pure run rules: track generation, movement, collisions, tricks and score.
// No Three.js here, so the rules are deterministic and testable under Node.
// Track coordinates: s = distance forward, x = lateral (+ = screen right), y = up.

export const LANE_W = 2.3;
export const ROOF_HALF = 3.75;
export const WALL_X = 4.4;
export const G = 30;
export const JUMP_V = 10.6;
export const DOUBLE_V = 9.4;
export const PAD_V = 17.5;
export const FASTFALL_V = -26;
export const STEP_UP = 0.5;
export const CRATE_H = 1.6;
export const COYOTE = 0.11;
export const JUMP_BUFFER = 0.16;
export const SLIDE_TIME = 0.62;
export const PLAYER_HALF_X = 0.3;
export const PLAYER_HALF_S = 0.25;
export const STAND_H = 1.6;
export const SLIDE_H = 0.72;
export const BOOST_TIME = 4.5;
export const MAGNET_TIME = 9;
export const MAX_MULT = 8;

export const laneX = lane => lane * LANE_W;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

export function speedAt(s) {
  return 14 + 15 * (1 - Math.exp(-Math.max(0, s) / 2600));
}

// Time until a jump lands at a height difference dh (positive = higher target).
export function airTime(dh, v0 = JUMP_V) {
  const disc = v0 * v0 - 2 * G * dh;
  if (disc < 0) return 0;
  return (v0 + Math.sqrt(disc)) / G;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const topAt = (pl, s) => (pl.s1 === pl.s0 ? pl.y0 : lerp(pl.y0, pl.y1, clamp((s - pl.s0) / (pl.s1 - pl.s0), 0, 1)));

// Each row: three lane codes. . free, B low barrier (jump), H overhead sign (slide),
// C cargo crate (climb or switch), R crate with a ramp, D drone, M drone sweeping lanes.
const ROWS = [
  // tier 0: one thing to read at a time
  ['.B.', 0], ['B..', 0], ['..B', 0], ['.H.', 0], ['H..', 0], ['..H', 0], ['.C.', 0], ['C..', 0], ['..C', 0], ['.R.', 0],
  // tier 1: two lanes
  ['BB.', 1], ['.BB', 1], ['B.B', 1], ['HH.', 1], ['.HH', 1], ['H.H', 1], ['C.C', 1], ['CC.', 1], ['.CC', 1], ['B.H', 1], ['H.B', 1],
  ['.D.', 1], ['D..', 1], ['..D', 1], ['R.C', 1], ['C.R', 1],
  // tier 2: full rows and mixed reads
  ['BBB', 2], ['HHH', 2], ['BHB', 2], ['HBH', 2], ['CBC', 2], ['CHC', 2], ['DBD', 2], ['C.D', 2], ['D.C', 2], ['RRC', 2], ['CRR', 2],
  // tier 3: moving drones and tighter combos
  ['.M.', 3], ['M.C', 3], ['C.M', 3], ['BMB', 3], ['HMH', 3], ['CMC', 3],
];

function tierFor(s) {
  if (s < 500) return 0;
  if (s < 1300) return 1;
  if (s < 2400) return 2;
  return 3;
}

export class Track {
  constructor({ seed = 1, tutorial = true } = {}) {
    this.rng = mulberry32(seed);
    this.platforms = [];
    this.hazards = [];
    this.walls = [];
    this.pads = [];
    this.pickups = [];
    this.hints = [];
    this.nextId = 1;
    this.cursor = -40;
    this.height = 0;
    this.lastPower = 120;
    this.tutorial = tutorial;
    this.added = [];          // new objects since the renderer last drained them
    this.removed = [];
    this.roofCount = 0;
    if (tutorial) this.buildTutorial();
    else {
      const edge = this.addRoof(-40, 190, 0, { quietUntil: 40 });
      const gap = this.addGap(edge, 0, 'normal');
      this.cursor = gap.s;
      this.height = gap.h;
      this.lastGapKind = gap.kind;
    }
  }

  r(a = 0, b = 1) { return a + (b - a) * this.rng(); }
  pick(list) { return list[Math.floor(this.rng() * list.length)]; }

  add(list, obj) {
    obj.id = this.nextId++;
    list.push(obj);
    this.added.push(obj);
    return obj;
  }

  roof(s0, s1, h) {
    this.roofCount++;
    return this.add(this.platforms, { kind: 'roof', x0: -ROOF_HALF, x1: ROOF_HALF, s0, s1, y0: h, y1: h, base: -80, roofIndex: this.roofCount });
  }

  hint(s, text, key) { this.hints.push({ s, text, key, shown: false }); }

  chipLine(x, s0, s1, y, gap = 2.6) {
    for (let s = s0; s <= s1; s += gap) this.add(this.pickups, { kind: 'chip', x, y, s, taken: false });
  }

  chipArc(x, sMid, base, span = 7, peak = 1.9) {
    for (let i = -3; i <= 3; i++) {
      const u = i / 3;
      this.add(this.pickups, { kind: 'chip', x, y: base + 0.7 + peak * (1 - u * u), s: sMid + u * span * 0.5, taken: false });
    }
  }

  // Places one obstacle code in a lane. Returns the farthest s the object occupies.
  place(code, lane, s, h) {
    const x = laneX(lane);
    if (code === 'B') {
      this.add(this.hazards, { kind: 'barrier', x, sweep: 0, x0: x - 1.05, x1: x + 1.05, s0: s, s1: s + 0.5, yb: h, yt: h + 1.0 });
      return s + 0.5;
    }
    if (code === 'H') {
      this.add(this.hazards, { kind: 'bar', x, sweep: 0, x0: x - 1.15, x1: x + 1.15, s0: s, s1: s + 0.55, yb: h + 1.12, yt: h + 3.4 });
      return s + 0.55;
    }
    if (code === 'D' || code === 'M') {
      const sweep = code === 'M' ? (lane === 0 ? (this.rng() < 0.5 ? -1 : 1) : -lane) * LANE_W : 0;
      this.add(this.hazards, { kind: 'drone', x, baseX: x, sweep, phase: this.r(0, Math.PI * 2), x0: x - 0.62, x1: x + 0.62, s0: s, s1: s + 0.9, yb: h + 0.3, yt: h + 1.35 });
      return s + 0.9;
    }
    if (code === 'C' || code === 'R') {
      const len = this.r(8, 18);
      let start = s;
      if (code === 'R') {
        this.add(this.platforms, { kind: 'ramp', x0: x - 1.0, x1: x + 1.0, s0: s - 5.5, s1: s, y0: h, y1: h + CRATE_H, base: h, lane });
      }
      this.add(this.platforms, { kind: 'crate', x0: x - 1.05, x1: x + 1.05, s0: start, s1: start + len, y0: h + CRATE_H, y1: h + CRATE_H, base: h, lane, tint: Math.floor(this.r(0, 4)) });
      if (this.rng() < 0.65) this.chipLine(x, start + 1.5, start + len - 1, h + CRATE_H + 0.7);
      return start + len;
    }
    return s;
  }

  placeRow(pattern, s, h) {
    let end = s;
    const free = [];
    for (let i = 0; i < 3; i++) {
      const code = pattern[i], lane = i - 1;
      end = Math.max(end, this.place(code, lane, s, h));
      if (code === '.') free.push(lane);
      if (code === 'B' && this.rng() < 0.35) this.chipArc(laneX(lane), s + 0.25, h);
      if (code === 'H' && this.rng() < 0.35) this.chipLine(laneX(lane), s - 2.5, s + 3, h + 0.45, 1.4);
    }
    return { end, free };
  }

  addRoof(s0, len, h, { quietUntil = 0 } = {}) {
    const s1 = s0 + len;
    this.roof(s0, s1, h);
    let s = Math.max(s0 + 22, quietUntil);
    while (true) {
      const tier = tierFor(s);
      const sp = speedAt(s);
      const spacing = Math.max(15, sp * this.r(tier >= 2 ? 0.85 : 1.0, tier >= 2 ? 1.25 : 1.45));
      if (s > s1 - 26) break;
      const options = ROWS.filter(([, t]) => t <= tier && t >= tier - 2);
      const [pattern] = this.pick(options);
      // Rows stop 26 m before the ledge and crates are at most 18 m, so the edge stays clear.
      const { end, free } = this.placeRow(pattern, s, h);
      const lane = free.length ? this.pick(free) : null;
      if (lane !== null) {
        if (s - this.lastPower > 420 && this.rng() < 0.5) {
          this.lastPower = s;
          this.add(this.pickups, { kind: this.pick(['magnet', 'shield', 'boost']), x: laneX(lane), y: h + 1.0, s: s + 2, taken: false });
        } else if (this.rng() < 0.55) {
          this.chipLine(laneX(lane), s - spacing * 0.45, s + spacing * 0.3, h + 0.7);
        }
      }
      s = Math.min(end, s1) + spacing;
    }
    return s1;
  }

  // Gap to the next roof; returns the next roof's start and height.
  addGap(edge, h, forceKind = null) {
    const tier = tierFor(edge);
    const sp = speedAt(edge);
    const longChance = [0.18, 0.3, 0.38, 0.45][tier];
    const kind = forceKind || (this.rng() < longChance ? this.pick(['wall', 'wall', 'pad']) : 'normal');
    if (kind === 'normal') {
      // Height drifts but is pulled back toward street level over a long run.
      let choices = tier === 0 ? [0, -0.8, 0.6] : [-2.0, -1.2, -0.6, 0, 0, 0.6, 1.0];
      if (h < -6) choices = [0, 0.6, 1.0, 1.0];
      if (h > 6) choices = [-2.0, -1.2, -0.6];
      const dh = this.pick(choices);
      const reach = sp * airTime(dh);
      const len = clamp(reach * this.r(0.33, 0.55), 3, 9.5);
      return { s: edge + len, h: h + dh, kind };
    }
    if (kind === 'pad') {
      const dh = h < -6 ? 0.8 : this.pick([-1.0, -0.5, 0, 0.8]);
      const len = sp * this.r(0.85, 1.0);
      for (const lane of [-1, 0, 1]) this.add(this.pads, { x: laneX(lane), s: edge - 6, y: h });
      this.chipArc(0, edge + len * 0.45, h + 2.2, len * 0.8, 2.6);
      return { s: edge + len, h: h + dh, kind };
    }
    // Wall run across a long gap. The panel starts on the roof so it can be grabbed early.
    const dh = h < -6 ? 0 : this.pick([-1.0, -0.5, 0]);
    const len = sp * this.r(0.95, 1.15);
    const sides = this.rng() < 0.35 ? [-1, 1] : [this.rng() < 0.5 ? -1 : 1];
    for (const side of sides) {
      this.add(this.walls, { side, s0: edge - 6, s1: edge + len + 3, y0: h - 2, y1: h + 4.2 });
      for (let s = edge + 1; s < edge + len; s += 2.4) this.add(this.pickups, { kind: 'chip', x: side * (WALL_X - 0.55), y: h + 1.9, s, taken: false });
    }
    return { s: edge + len, h: h + dh, kind, sides };
  }

  buildTutorial() {
    const h = 0;
    this.roof(-40, 196, h);
    this.placeRow('BBB', 42, h); this.hint(22, '↑ 또는 Space — 점프', 'jump');
    this.chipArc(0, 42.25, h);
    this.placeRow('HHH', 80, h); this.hint(60, '↓ 또는 S — 슬라이드', 'slide');
    this.chipLine(0, 76, 84, h + 0.45, 1.4);
    this.placeRow('.C.', 118, h); this.hint(96, '← → — 차선 변경 (컨테이너 위로 점프도 가능)', 'lane');
    this.chipLine(laneX(-1), 112, 135, h + 0.7);
    this.placeRow('B.H', 160, h);
    this.chipLine(0, 150, 175, h + 0.7);
    this.hint(176, '건물 끝에서 점프 — 공중에서 한 번 더 누르면 2단 점프', 'gap');
    const g1 = this.addGap(196, h, 'normal');
    // Second roof: drone, then a long gap with walls on both sides.
    const h2 = g1.h;
    const r2s = g1.s;
    this.roof(r2s, r2s + 120, h2);
    this.placeRow('.D.', r2s + 28, h2); this.hint(r2s + 10, '드론은 피하거나 뛰어넘기', 'drone');
    this.placeRow('C.R', r2s + 62, h2);
    this.chipLine(0, r2s + 50, r2s + 80, h2 + 0.7);
    const edge2 = r2s + 120;
    this.hint(edge2 - 24, '긴 틈: 점프 후 공중에서 벽 쪽 ←/→ — 벽타기', 'wall');
    this.hint(edge2 - 10, '공중에서 ↓ — 급강하', 'dive');
    const g2 = this.addGap(edge2, h2, 'wall');
    // Rebuild walls on both sides for the lesson.
    if (g2.sides.length === 1) {
      const w = this.walls[this.walls.length - 1];
      this.add(this.walls, { side: -w.side, s0: w.s0, s1: w.s1, y0: w.y0, y1: w.y1 });
    }
    this.cursor = g2.s;
    this.height = g2.h;
    this.lastGapKind = 'wall';
    this.pendingQuiet = g2.s + 30;
  }

  ensure(sAhead) {
    while (this.cursor < sAhead) {
      const len = this.r(90, 170);
      const s0 = this.cursor;
      // Landing zone: more room after wall runs and launch pads, which land later and higher.
      const quiet = s0 + speedAt(s0) * (this.lastGapKind === 'normal' ? 1.15 : 1.9);
      const edge = this.addRoof(s0, len, this.height, { quietUntil: Math.max(quiet, this.pendingQuiet || 0) });
      this.pendingQuiet = 0;
      const gap = this.addGap(edge, this.height);
      this.cursor = gap.s;
      this.height = gap.h;
      this.lastGapKind = gap.kind;
    }
  }

  prune(sBehind) {
    for (const key of ['platforms', 'hazards', 'walls', 'pads', 'pickups']) {
      const list = this[key];
      const keep = [];
      for (const o of list) {
        const end = o.s1 ?? o.s;
        if (end < sBehind) this.removed.push(o); else keep.push(o);
      }
      this[key] = keep;
    }
    this.hints = this.hints.filter(hn => hn.s > sBehind);
  }

  drain() {
    const out = { added: this.added, removed: this.removed };
    this.added = [];
    this.removed = [];
    return out;
  }
}

export function droneX(hz, t) {
  if (!hz.sweep) return hz.baseX ?? hz.x;
  // Sweeps between its lane and a neighbour with a pause at each end.
  const u = 0.5 - 0.5 * Math.cos(t * 1.9 + hz.phase);
  const eased = u * u * (3 - 2 * u);
  return hz.baseX + hz.sweep * eased;
}

export class Run {
  constructor({ seed = (Math.random() * 2 ** 31) | 0, tutorial = true, bonus = 1 } = {}) {
    this.track = new Track({ seed, tutorial });
    this.bonus = bonus;
    this.time = 0;
    this.events = [];
    this.p = {
      s: 0, x: 0, lane: 0, laneFrom: 0, y: 0, vy: 0, grounded: true, coyote: 0, jumpBuf: 0,
      slide: 0, slideQueued: false, airJumps: 1, flip: 0, wall: null, fastFall: false,
      stumble: 0, invuln: 0, shield: false, magnet: 0, boost: 0, speed: speedAt(0),
      alive: true, cause: null, lastLaneTime: -9, jumpTime: -9, takeoffS: 0, takeoffEdgeDist: 99,
      roofIndex: 1, lastTop: 0, mantle: 0, padTime: -9, landTime: -9, hoverY: null,
    };
    this.score = 0;
    this.chips = 0;
    this.mult = 1;
    this.flow = 0;
    this.distance = 0;
    this.stats = { tricks: 0, bestMult: 1, wallRuns: 0, flips: 0, perfects: 0, smashes: 0, nearMiss: 0 };
    this.track.ensure(320);
  }

  emit(type, data = {}) { this.events.push({ type, t: this.time, ...data }); }

  drainEvents() { const e = this.events; this.events = []; return e; }

  trick(name, pts, flowGain) {
    this.score += pts * this.mult * this.bonus;
    this.flow += flowGain;
    this.stats.tricks++;
    let up = false;
    while (this.flow >= 1) {
      this.flow -= 1;
      if (this.mult < MAX_MULT) { this.mult++; up = true; }
      else this.flow = 0.999;
    }
    this.stats.bestMult = Math.max(this.stats.bestMult, this.mult);
    this.emit('trick', { name, pts: Math.round(pts * this.mult * this.bonus) });
    if (up) this.emit('mult', { mult: this.mult });
  }

  // input: { left, right, jump, down } press counts since last update.
  update(dt, input = {}) {
    const p = this.p;
    if (!p.alive) { this.time += dt; this.crashAnim(dt); return; }
    dt = Math.min(dt, 0.05);
    this.handleInput(input);
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps && p.alive; i++) this.step(h);
    this.track.ensure(p.s + 340);
    this.track.prune(p.s - 40);
  }

  handleInput({ left = 0, right = 0, jump = 0, down = 0 }) {
    const p = this.p;
    for (let i = 0; i < left; i++) this.lateral(-1);
    for (let i = 0; i < right; i++) this.lateral(1);
    if (jump) this.pressJump();
    if (down) this.pressDown();
  }

  wallAt(side, s, y) {
    return this.track.walls.find(w => w.side === side && s >= w.s0 && s <= w.s1 && y >= w.y0 - 0.5 && y <= w.y1);
  }

  lateral(dir) {
    const p = this.p;
    if (p.wall) {
      if (dir !== p.wall.side) this.leaveWall(false);
      return;
    }
    if (!p.grounded) {
      const w = this.wallAt(dir, p.s, p.y);
      if (w && (p.lane === dir || p.lane === 0)) { this.attachWall(w); return; }
    } else {
      // Standing in the outer lane next to a panel: hop onto it.
      const w = this.wallAt(dir, p.s, p.y);
      if (w && p.lane === dir) { p.vy = 6; p.grounded = false; this.attachWall(w); return; }
    }
    const target = clamp(p.lane + dir, -1, 1);
    if (target === p.lane) { this.emit('edge', { dir }); return; }
    p.laneFrom = p.lane;
    p.lane = target;
    p.lastLaneTime = this.time;
    this.emit('lane', { dir });
  }

  attachWall(w) {
    const p = this.p;
    p.wall = { side: w.side, ref: w, t: 0 };
    p.vy = Math.max(p.vy, 0) * 0.3 + 2.2;
    p.grounded = false;
    p.slide = 0;
    p.airJumps = 1;
    p.fastFall = false;
    p.lane = w.side;
    this.stats.wallRuns++;
    this.trick('WALL RUN', 120, 0.34);
    this.emit('wallStart', { side: w.side });
  }

  leaveWall(jumped) {
    const p = this.p;
    if (!p.wall) return;
    const side = p.wall.side;
    p.wall = null;
    p.lane = side;
    if (jumped) {
      p.vy = JUMP_V * 0.92;
      p.jumpTime = this.time;
      this.emit('jump', { wall: true });
    } else {
      p.vy = Math.max(p.vy, 4.5);
    }
    this.emit('wallEnd', { side, jumped });
  }

  pressJump() {
    const p = this.p;
    if (p.wall) { this.leaveWall(true); return; }
    if (p.grounded || p.coyote > 0) { this.doJump(); return; }
    // Close above a landing: buffer it instead of spending the air jump.
    const support = this.supportBelow(p.x, p.s, p.y);
    if (p.vy < 0 && support !== null && p.y - support < 0.6) { p.jumpBuf = JUMP_BUFFER; return; }
    if (p.airJumps > 0) {
      p.airJumps--;
      p.vy = DOUBLE_V;
      p.fastFall = false;
      p.flip = 0.55;
      this.stats.flips++;
      this.trick('FLIP', 60, 0.16);
      this.emit('doubleJump');
    } else {
      p.jumpBuf = JUMP_BUFFER;
    }
  }

  doJump() {
    const p = this.p;
    p.vy = JUMP_V;
    p.grounded = false;
    p.coyote = 0;
    p.jumpBuf = 0;
    p.slide = 0;
    p.slideQueued = false;
    p.jumpTime = this.time;
    p.takeoffS = p.s;
    const roof = this.currentRoof();
    p.takeoffEdgeDist = roof ? roof.s1 - p.s : 99;
    this.emit('jump', {});
  }

  pressDown() {
    const p = this.p;
    if (p.wall) { this.leaveWall(false); p.vy = FASTFALL_V * 0.6; p.fastFall = true; p.slideQueued = true; return; }
    if (p.grounded) {
      p.slide = SLIDE_TIME;
      this.emit('slide');
    } else {
      p.vy = Math.min(p.vy, FASTFALL_V);
      p.fastFall = true;
      p.flip = 0;
      p.slideQueued = true;
      this.emit('dive');
    }
  }

  currentRoof() {
    const p = this.p;
    return this.track.platforms.find(pl => pl.kind === 'roof' && p.s >= pl.s0 - 0.5 && p.s <= pl.s1 + 0.5) || null;
  }

  overlapsX(pl, x) { return x + PLAYER_HALF_X * 0.6 > pl.x0 && x - PLAYER_HALF_X * 0.6 < pl.x1; }

  // Highest walkable top under the player that is not above feet + tolerance.
  supportBelow(x, s, feet, tol = 0.05) {
    let best = null;
    for (const pl of this.track.platforms) {
      if (s < pl.s0 - PLAYER_HALF_S || s > pl.s1 + PLAYER_HALF_S || !this.overlapsX(pl, x)) continue;
      const top = topAt(pl, s);
      if (top <= feet + tol && (best === null || top > best)) best = top;
    }
    return best;
  }

  supportPlatform(x, s, feet, tol) {
    let best = null, bestTop = -Infinity;
    for (const pl of this.track.platforms) {
      if (s < pl.s0 - PLAYER_HALF_S || s > pl.s1 + PLAYER_HALF_S || !this.overlapsX(pl, x)) continue;
      const top = topAt(pl, s);
      if (top <= feet + tol && top > bestTop) { best = pl; bestTop = top; }
    }
    return best;
  }

  step(dt) {
    const p = this.p, t = this.time;
    const prevX = p.x, prevS = p.s, prevY = p.y;
    const base = speedAt(p.s);
    let speed = base * (p.boost > 0 ? 1.45 : 1) * (p.stumble > 0 ? 0.82 : 1) * (p.mantle > 0 ? 0.8 : 1);
    p.speed = speed;

    // Lateral
    if (p.wall) {
      const tx = p.wall.side * (WALL_X - 0.45);
      p.x += (tx - p.x) * (1 - Math.exp(-dt * 24));
    } else {
      const tx = laneX(p.lane);
      p.x += (tx - p.x) * (1 - Math.exp(-dt * 19));
      if (Math.abs(tx - p.x) < 0.004) p.x = tx;
    }
    p.s += speed * dt;
    this.distance = Math.max(this.distance, p.s);

    // Vertical
    if (p.wall) {
      p.wall.t += dt;
      p.vy -= 3.2 * dt;
      p.y += p.vy * dt;
      const w = p.wall.ref;
      if (p.s > w.s1 || p.y < w.y0) this.leaveWall(false);
    } else if (p.grounded) {
      const pl = this.supportPlatform(p.x, p.s, p.y, STEP_UP);
      const top = pl ? topAt(pl, p.s) : null;
      if (top !== null && p.y - top < 0.35) {
        p.y = top;
        p.lastTop = top;
        if (pl.kind === 'roof') p.roofIndex = pl.roofIndex;
      } else {
        p.grounded = false;
        p.coyote = COYOTE;
        p.vy = 0;
        p.takeoffS = p.s;
        p.takeoffEdgeDist = 99;
      }
    }
    if (!p.grounded && !p.wall) {
      p.coyote = Math.max(0, p.coyote - dt);
      p.vy -= G * (p.vy > 0 ? 1 : 1.12) * dt;
      p.y += p.vy * dt;
      if (p.boost > 0 && p.hoverY !== null && p.y < p.hoverY && this.supportBelow(p.x, p.s, p.y + 0.4) === null) {
        // Overdrive glides over gaps at the last roof height.
        p.y = p.hoverY;
        p.vy = Math.max(p.vy, 0);
      }
      if (p.vy <= 0) {
        // Falling: land on anything at or slightly above the feet (same reach as a step up).
        const pl = this.supportPlatform(p.x, p.s, prevY, STEP_UP);
        if (pl) {
          const top = topAt(pl, p.s);
          if (p.y <= top) this.land(pl, top);
        }
      }
    }
    p.jumpBuf = Math.max(0, p.jumpBuf - dt);
    if (p.grounded && p.jumpBuf > 0) this.doJump();
    if (p.flip > 0) p.flip = Math.max(0, p.flip - dt);
    if (p.slide > 0) p.slide = Math.max(0, p.slide - dt);
    if (p.stumble > 0) p.stumble = Math.max(0, p.stumble - dt);
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
    if (p.mantle > 0) p.mantle = Math.max(0, p.mantle - dt);
    if (p.magnet > 0) p.magnet = Math.max(0, p.magnet - dt);
    if (p.boost > 0) {
      p.boost = Math.max(p.grounded ? 0 : 0.001, p.boost - dt);
      if (p.boost === 0) { p.invuln = Math.max(p.invuln, 0.8); p.hoverY = null; this.emit('boostEnd'); }
    }
    if (p.grounded) p.hoverY = p.y;

    this.collidePlatforms(prevX, prevS, prevY);
    if (!p.alive) { this.time += dt; return; }
    this.collideHazards(prevX, prevS, t);
    if (!p.alive) { this.time += dt; return; }
    this.pads(prevS);
    this.pickups(dt);
    this.passChecks(prevS);
    this.hintChecks();

    // Distance score and flow decay
    this.score += (p.s - prevS) * this.mult * this.bonus;
    this.flow -= dt * (0.022 + 0.007 * this.mult);
    if (this.flow < 0) {
      if (this.mult > 1) { this.mult--; this.flow = 0.55; this.emit('multDown', { mult: this.mult }); }
      else this.flow = 0;
    }

    // Fell into a gap. Roofs never drop more than 2 m, so 4 m below the last
    // roof with nothing underneath means a miss: the shield bounces you out.
    if (!p.grounded && !p.wall && p.vy < 0 && p.shield && p.y < p.lastTop - 4 && this.supportBelow(p.x, p.s, p.y) === null) {
      p.shield = false;
      p.vy = 19;
      p.airJumps = 1;
      p.invuln = 1.2;
      p.hoverY = null;
      this.emit('shieldBreak', { rescue: true });
    }
    if (!p.grounded && !p.wall && p.y < p.lastTop - 9) this.die('fall');
    this.time += dt;
  }

  land(pl, top) {
    const p = this.p;
    const fall = -p.vy;
    p.y = top;
    p.vy = 0;
    p.grounded = true;
    p.airJumps = 1;
    p.flip = 0;
    p.lastTop = top;
    p.landTime = this.time;
    const dive = p.fastFall;
    p.fastFall = false;
    if (p.slideQueued) { p.slide = SLIDE_TIME; p.slideQueued = false; this.emit('slide', { fromDive: true }); }
    if (pl.kind === 'roof' && pl.roofIndex !== p.roofIndex) {
      const perfect = p.takeoffEdgeDist < 1.8;
      p.roofIndex = pl.roofIndex;
      if (perfect) { this.stats.perfects++; this.trick('PERFECT GAP', 150, 0.4); }
      else this.trick('GAP', 80, 0.22);
    }
    if (dive && fall > 12) this.trick('DIVE ROLL', 40, 0.1);
    this.emit('land', { fall, kind: pl.kind });
  }

  collidePlatforms(prevX, prevS, prevY) {
    const p = this.p;
    const bodyH = p.slide > 0 ? SLIDE_H : STAND_H;
    for (const pl of this.track.platforms) {
      if (p.s + PLAYER_HALF_S < pl.s0 || p.s - PLAYER_HALF_S > pl.s1) continue;
      if (p.x + PLAYER_HALF_X <= pl.x0 || p.x - PLAYER_HALF_X >= pl.x1) continue;
      const top = topAt(pl, p.s);
      if (top <= p.y + STEP_UP) continue;
      if (p.y + bodyH < pl.base) continue;
      const wasInS = prevS + PLAYER_HALF_S >= pl.s0 && prevS - PLAYER_HALF_S <= pl.s1;
      const wasInX = prevX + PLAYER_HALF_X > pl.x0 && prevX - PLAYER_HALF_X < pl.x1;
      if (wasInS && !wasInX && !(pl.kind === 'ramp' && top - p.y <= 1.15)) {
        // Entered from the side: bounce back to the lane we came from.
        this.bump(prevX);
        continue;
      }
      if (p.boost > 0) { p.y = top; p.vy = Math.max(p.vy, 0); p.grounded = true; this.emit('land', { fall: 0, kind: pl.kind }); continue; }
      if (top - p.y <= 1.15) {
        // Ledge within reach: vault/mantle onto it instead of crashing.
        p.y = top;
        p.vy = 0;
        p.grounded = true;
        p.airJumps = 1;
        p.mantle = 0.32;
        p.lastTop = top;
        if (pl.kind === 'roof') {
          p.roofIndex = pl.roofIndex;
        }
        this.trick('MANTLE', 30, 0.06);
        this.emit('mantle');
        continue;
      }
      if (this.absorb(null)) { p.y = top; p.grounded = true; p.vy = 0; continue; }
      this.die(pl.kind === 'roof' ? 'wall' : 'crate');
      return;
    }
  }

  absorb(hz) {
    const p = this.p;
    if (p.invuln > 0) return true;
    if (p.shield) {
      p.shield = false;
      p.invuln = 1.0;
      if (hz) hz.broken = true;
      this.emit('shieldBreak', { id: hz?.id });
      return true;
    }
    return false;
  }

  bump(prevX) {
    const p = this.p;
    p.x = prevX;
    p.lane = p.laneFrom;
    if (p.stumble <= 0) {
      p.stumble = 0.55;
      this.mult = Math.max(1, this.mult - 2);
      this.flow = 0;
      this.emit('bump');
    }
  }

  hazardBox(hz) {
    if (hz.kind !== 'drone') return hz;
    const x = droneX(hz, this.time);
    hz.x = x;
    hz.x0 = x - 0.62;
    hz.x1 = x + 0.62;
    return hz;
  }

  collideHazards(prevX, prevS) {
    const p = this.p;
    const bodyH = p.slide > 0 ? SLIDE_H : (p.grounded ? STAND_H : 1.35);
    for (const raw of this.track.hazards) {
      if (raw.broken) continue;
      if (p.s + PLAYER_HALF_S < raw.s0 - 0.6 || p.s - PLAYER_HALF_S > raw.s1 + 0.6) continue;
      const hz = this.hazardBox(raw);
      if (p.s + PLAYER_HALF_S < hz.s0 || p.s - PLAYER_HALF_S > hz.s1) continue;
      if (p.x + PLAYER_HALF_X <= hz.x0 || p.x - PLAYER_HALF_X >= hz.x1) continue;
      if (p.y + bodyH <= hz.yb || p.y >= hz.yt) continue;
      if (p.boost > 0) {
        hz.broken = true;
        this.stats.smashes++;
        this.trick('SMASH', 50, 0.12);
        this.emit('smash', { id: hz.id, kind: hz.kind });
        continue;
      }
      if (this.absorb(hz)) { hz.broken = true; this.emit('smash', { id: hz.id, kind: hz.kind }); continue; }
      const wasInS = prevS + PLAYER_HALF_S >= hz.s0 && prevS - PLAYER_HALF_S <= hz.s1;
      const wasInX = prevX + PLAYER_HALF_X > hz.x0 && prevX - PLAYER_HALF_X < hz.x1;
      // Dropping onto a thin hazard from above just clips through it.
      if (wasInS && wasInX) continue;
      if (wasInS) { this.bump(prevX); continue; }
      this.die(hz.kind);
      return;
    }
  }

  pads(prevS) {
    const p = this.p;
    if (!p.grounded) return;
    for (const pad of this.track.pads) {
      if (prevS <= pad.s + 1.0 && p.s >= pad.s - 1.0 && Math.abs(p.x - pad.x) < 1.1) {
        p.vy = PAD_V;
        p.grounded = false;
        p.slide = 0;
        p.airJumps = 1;
        p.padTime = this.time;
        p.jumpTime = this.time;
        p.takeoffEdgeDist = 0;
        this.trick('LAUNCH', 60, 0.15);
        this.emit('pad', { id: pad.id });
        return;
      }
    }
  }

  pickups(dt) {
    const p = this.p;
    const cy = p.y + (p.slide > 0 ? 0.4 : 0.9);
    for (const it of this.track.pickups) {
      if (it.taken) continue;
      const ds = it.s - p.s;
      if (ds < -2 || ds > 30) continue;
      if (it.kind === 'chip' && (p.magnet > 0 || p.boost > 0) && ds < 16 && ds > -1) {
        // Magnet pulls chips toward the player.
        const k = 1 - Math.exp(-dt * 10);
        it.x += (p.x - it.x) * k;
        it.y += (cy - it.y) * k;
        it.s += (p.s - it.s) * k * 0.6;
      }
      const reach = it.kind === 'chip' ? 0.8 : 1.1;
      if (Math.abs(it.s - p.s) < reach && Math.abs(it.x - p.x) < reach + 0.1 && Math.abs(it.y - cy) < 1.15) {
        it.taken = true;
        if (it.kind === 'chip') {
          this.chips++;
          this.score += 10 * this.mult * this.bonus;
          this.flow += 0.012;
          this.emit('chip', { id: it.id });
        } else {
          if (it.kind === 'magnet') p.magnet = MAGNET_TIME;
          if (it.kind === 'shield') p.shield = true;
          if (it.kind === 'boost') { p.boost = BOOST_TIME; p.hoverY = p.y; }
          this.trick(it.kind.toUpperCase(), 40, 0.1);
          this.emit('power', { id: it.id, kind: it.kind });
        }
      }
    }
  }

  passChecks(prevS) {
    const p = this.p;
    for (const hz of this.track.hazards) {
      if (hz.passed || hz.broken || p.s - PLAYER_HALF_S < hz.s1) continue;
      hz.passed = true;
      const hx = hz.x;
      const inLane = Math.abs(p.x - hx) < 1.15;
      if (inLane && p.y >= hz.yt - 0.05) {
        const perfect = this.time - p.jumpTime < 0.36 && p.jumpTime > 0;
        if (perfect) { this.stats.perfects++; this.trick('PERFECT HURDLE', 90, 0.26); }
        else this.trick('HURDLE', 40, 0.12);
      } else if (inLane && p.slide > 0) {
        this.trick('SLIDE UNDER', 50, 0.14);
      } else if (Math.abs(p.x - hx) < 2.7 && this.time - p.lastLaneTime < 0.5) {
        this.stats.nearMiss++;
        this.trick('NEAR MISS', 70, 0.2);
      }
    }
  }

  hintChecks() {
    const p = this.p;
    for (const hn of this.track.hints) {
      if (!hn.shown && p.s >= hn.s) { hn.shown = true; this.emit('hint', { text: hn.text, key: hn.key }); }
    }
  }

  die(cause) {
    const p = this.p;
    p.alive = false;
    p.cause = cause;
    p.deathTime = this.time;
    p.vy = cause === 'fall' ? p.vy : 6;
    this.emit('crash', { cause });
  }

  crashAnim(dt) {
    const p = this.p;
    if (p.cause === 'fall') { p.vy -= G * dt; p.y += p.vy * dt; p.s += p.speed * 0.3 * dt; return; }
    // Knockback after a frontal hit; a hit in mid-air keeps falling.
    p.vy -= G * dt;
    p.y = p.grounded ? Math.max(p.lastTop, p.y + p.vy * dt) : p.y + p.vy * dt;
    p.s -= 3 * dt * Math.max(0, 1 - (this.time - p.deathTime) * 2);
  }
}

export const CAUSE_TEXT = {
  fall: '추락했어요',
  wall: '건물 벽에 정면충돌',
  crate: '컨테이너에 정면충돌',
  barrier: '바리케이드에 걸려 넘어짐',
  bar: '간판에 머리 박음',
  drone: '드론과 충돌',
};
