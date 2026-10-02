import test from 'node:test';
import assert from 'node:assert/strict';
import { Run, Track, speedAt, airTime, laneX, JUMP_V, G, SLIDE_TIME } from '../src/sim.js';
import { createAutopilot } from '../src/autopilot.js';

const DT = 1 / 60;
const run = (r, seconds, input = () => ({})) => {
  for (let t = 0; t < seconds; t += DT) r.update(DT, input(r));
};

test('speed rises smoothly and is capped', () => {
  assert.equal(Math.round(speedAt(0)), 14);
  assert.ok(speedAt(1000) > speedAt(500));
  assert.ok(speedAt(1e6) <= 29.0001);
});

test('jump peak clears barriers, drones and crates', () => {
  const peak = JUMP_V * JUMP_V / (2 * G);
  assert.ok(peak > 1.6 + 0.2, `peak ${peak}`);
  assert.ok(airTime(1.0) > 0.5);
});

test('lane change moves to the next lane and stops at the edge', () => {
  const r = new Run({ seed: 3, tutorial: false });
  r.update(DT, { right: 1 });
  run(r, 0.4);
  assert.equal(r.p.lane, 1);
  assert.ok(Math.abs(r.p.x - laneX(1)) < 0.05);
  const events = r.drainEvents();
  r.update(DT, { right: 1 });
  assert.equal(r.p.lane, 1);
  assert.ok(r.drainEvents().some(e => e.type === 'edge'));
});

test('jump, double jump flip and buffered landing jump', () => {
  const r = new Run({ seed: 4, tutorial: false });
  r.update(DT, { jump: 1 });
  assert.equal(r.p.grounded, false);
  run(r, 0.2);
  r.update(DT, { jump: 1 });
  assert.ok(r.p.flip > 0, 'flip started');
  assert.equal(r.p.airJumps, 0);
  // Fall until just above the roof, then press: it must buffer and jump on landing.
  for (let i = 0; i < 400 && !(r.p.vy < 0 && r.p.y < 0.4); i++) r.update(DT);
  r.update(DT, { jump: 1 });
  let rejumped = false;
  for (let i = 0; i < 30; i++) { r.update(DT); if (r.p.vy > 5) rejumped = true; }
  assert.ok(rejumped, 'buffered jump fired on landing');
});

test('slide lowers the body and expires; down in the air dives', () => {
  const r = new Run({ seed: 5, tutorial: false });
  r.update(DT, { down: 1 });
  assert.ok(r.p.slide > 0);
  run(r, SLIDE_TIME + 0.1);
  assert.equal(r.p.slide, 0);
  r.update(DT, { jump: 1 });
  run(r, 0.15);
  r.update(DT, { down: 1 });
  assert.ok(r.p.vy < -20);
  run(r, 0.3);
  assert.ok(r.p.grounded);
  assert.ok(r.p.slide > 0, 'dive turns into a slide on landing');
});

test('tutorial barrier kills when ignored and is cleared by a jump', () => {
  const a = new Run({ seed: 1, tutorial: true });
  run(a, 5);
  assert.equal(a.p.alive, false);
  assert.equal(a.p.cause, 'barrier');

  const b = new Run({ seed: 1, tutorial: true });
  run(b, 5, r => ({ jump: r.p.grounded && r.p.s > 42 - r.p.speed * 0.19 && r.p.s < 41 ? 1 : 0 }));
  assert.ok(b.p.alive || b.p.cause !== 'barrier', `cause ${b.p.cause}`);
  assert.ok(b.p.s > 60);
});

test('side bump bounces back instead of killing', () => {
  const r = new Run({ seed: 1, tutorial: true });
  // The tutorial crate sits in the middle lane at s=118. Go left, run beside it, then steer into it.
  r.update(DT, { left: 1 });
  run(r, 0.3);
  r.p.s = 125; r.p.y = 0; r.p.grounded = true;
  r.track.hazards = [];
  r.update(DT, { right: 1 });
  run(r, 0.3);
  assert.equal(r.p.alive, true);
  assert.equal(r.p.lane, -1);
  assert.ok(r.drainEvents().some(e => e.type === 'bump'));
});

test('shield absorbs one frontal hit', () => {
  const r = new Run({ seed: 1, tutorial: true });
  r.p.shield = true;
  run(r, 3.2);
  assert.equal(r.p.alive, true);
  assert.equal(r.p.shield, false);
});

test('tricks raise the multiplier and score', () => {
  const r = new Run({ seed: 2, tutorial: false });
  for (let i = 0; i < 6; i++) r.trick('TEST', 100, 0.5);
  assert.ok(r.mult >= 3);
  assert.ok(r.score > 600);
});

test('track generation is deterministic and keeps ledges clear', () => {
  const a = new Track({ seed: 77, tutorial: false });
  const b = new Track({ seed: 77, tutorial: false });
  a.ensure(4000); b.ensure(4000);
  assert.deepEqual(a.platforms.map(p => [p.kind, p.s0.toFixed(2)]), b.platforms.map(p => [p.kind, p.s0.toFixed(2)]));
  const roofs = a.platforms.filter(p => p.kind === 'roof');
  for (const hz of a.hazards) {
    const roof = roofs.find(r => hz.s0 >= r.s0 && hz.s0 <= r.s1);
    assert.ok(roof, 'hazard sits on a roof');
    assert.ok(roof.s1 - hz.s1 > 20, 'clear run-up before every ledge');
  }
  for (const c of a.platforms.filter(p => p.kind === 'crate')) {
    const roof = roofs.find(r => c.s0 >= r.s0 && c.s0 <= r.s1);
    assert.ok(roof && c.s1 <= roof.s1 - 6, 'crates end before the ledge');
  }
});

test('autopilot finishes the tutorial including the wall run', () => {
  const r = new Run({ seed: 11, tutorial: true });
  const bot = createAutopilot();
  let walls = 0;
  for (let t = 0; t < 60 && r.p.alive && r.p.s < 700; t += DT) {
    r.update(DT, bot(r));
    walls += r.drainEvents().filter(e => e.type === 'wallStart').length;
  }
  assert.equal(r.p.alive, true, `died: ${r.p.cause} at ${r.p.s.toFixed(1)}`);
  assert.ok(walls >= 1, 'used a wall run');
});

test('generated runs are passable for the autopilot', () => {
  const results = [];
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const r = new Run({ seed, tutorial: false });
    const bot = createAutopilot();
    for (let t = 0; t < 240 && r.p.alive && r.p.s < 3500; t += DT) r.update(DT, bot(r));
    results.push({ seed, s: Math.round(r.p.s), alive: r.p.alive, cause: r.p.cause });
  }
  const failed = results.filter(x => !x.alive);
  assert.ok(failed.length <= 1, JSON.stringify(results));
});

import { createMissionState, checkMissions, settleMissions, bonusFor } from '../src/missions.js';

test('missions: three unique, clear banks a star and refills', () => {
  const st = createMissionState(null);
  assert.equal(st.active.length, 3);
  assert.equal(new Set(st.active.map(m => m.key)).size, 3);
  const fake = { distance: 1e6, chips: 1e6, score: 1e9, stats: { wallRuns: 99, flips: 99, perfects: 99, nearMiss: 99, bestMult: 8, smashes: 99 } };
  const done = checkMissions(st, fake);
  assert.equal(done.length, 3);
  assert.equal(checkMissions(st, fake).length, 0, 'not reported twice');
  assert.equal(settleMissions(st), 3);
  assert.equal(st.stars, 3);
  assert.equal(st.active.length, 3);
  assert.ok(st.active.every(m => !m.done));
  assert.ok(Math.abs(bonusFor(3) - 1.15) < 1e-9);
});

test('shield saves a missed gap once (face hit or deep fall)', () => {
  const r = new Run({ seed: 1, tutorial: true });
  // Run off the first ledge without jumping, holding a shield.
  r.track.hazards = [];
  r.p.shield = true;
  let saved = false;
  for (let t = 0; t < 20 && r.p.alive && r.p.s < 215; t += DT) {
    r.update(DT);
    if (r.drainEvents().some(e => e.type === 'shieldBreak')) saved = true;
  }
  assert.ok(saved, 'shield was used');
  assert.equal(r.p.alive, true);
  assert.equal(r.p.shield, false);

  // Deep fall with nothing ahead: the rescue bounce fires.
  const d = new Run({ seed: 2, tutorial: false });
  d.track.platforms = [];
  d.p.shield = true; d.p.grounded = false; d.p.lastTop = 0;
  let rescue = false;
  for (let i = 0; i < 120; i++) { d.update(DT); if (d.drainEvents().some(e => e.type === 'shieldBreak' && e.rescue)) rescue = true; }
  assert.ok(rescue);
});

test('running off a ledge onto a slightly lower roof grabs the ledge instead of sticking to the wall', () => {
  const r = new Run({ seed: 1, tutorial: true });
  r.track.hazards = [];
  r.track.platforms = r.track.platforms.filter(p => p.kind === 'roof');
  const next = r.track.platforms.find(p => p.kind === 'roof' && p.s0 > 150);
  const events = [];
  for (let t = 0; t < 20 && r.p.alive && r.p.s < next.s0 + 10; t += DT) { r.update(DT); events.push(...r.drainEvents()); }
  assert.equal(r.p.alive, true, `cause ${r.p.cause}`);
  assert.ok(events.some(e => e.type === 'mantle' || e.type === 'land'));
  assert.ok(!events.some(e => e.type === 'bump'), 'no side bump against a roof face');
});
