import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Run, CAUSE_TEXT, BOOST_TIME, MAGNET_TIME } from './sim.js';
import { loadCharacter } from './character.js';
import { World } from './world.js';
import { Audio } from './audio.js';
import { createAutopilot } from './autopilot.js';
import { createMissionState, missionText, missionValue, checkMissions, settleMissions, bonusFor } from './missions.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const AUTO = params.has('auto');
const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const KEY = 'gpchan_skyline_dash_v1';
const saved = store.get(KEY, { best: 0, bestDist: 0, runs: 0, muted: false });
saved.missions = createMissionState(saved.missions);

// ---------- Renderer ----------
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
renderer.setPixelRatio(pixelRatio);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1200);
const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());
let useBloom = true;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(w, h);
  bloom.setSize(Math.floor(w * pixelRatio / 2), Math.floor(h * pixelRatio / 2));
  camera.aspect = w / h;
  // Portrait screens need a wider vertical view to keep lanes in frame.
  camera.userData.portrait = h > w;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const world = new World(scene, renderer);
const audio = new Audio();
audio.setMuted(saved.muted);

// ---------- State ----------
let mode = 'loading'; // loading | menu | run | paused | dead
let run = new Run({ seed: Number(params.get('seed')) || 20261002, tutorial: saved.runs < 2 || saved.best < 1500 || params.has('tutorial'), bonus: bonusFor(saved.missions.stars) });
let character = null;
let bot = AUTO ? createAutopilot() : null;
let slowmo = 1, slowmoT = 0, hitstop = 0, shake = 0, fovKick = 0, deadT = 0;
let menuBlend = 1;
const camState = { y: 3, x: 0, roll: 0, fov: 62 };
const input = { left: 0, right: 0, jump: 0, down: 0 };
const isTouch = matchMedia('(pointer: coarse)').matches;

world.sync(run.track);

// Shield bubble
const bubble = new THREE.Mesh(
  new THREE.SphereGeometry(1.05, 24, 16),
  new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { time: { value: 0 }, color: { value: new THREE.Color('#7fe8ff') } },
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform float time; uniform vec3 color; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.5); float hex = 0.5 + 0.5*sin(vN.y*30.0 + time*3.0); gl_FragColor = vec4(color, f*0.75 + hex*f*0.25); }`,
  }));
bubble.visible = false;
scene.add(bubble);

// ---------- Loading ----------
(async () => {
  try {
    character = await loadCharacter(p => { $('load-bar').firstElementChild.style.width = `${Math.round(p * 100)}%`; });
    scene.add(character.root);
    $('loading').classList.add('hidden');
    toMenu();
    if (AUTO) setTimeout(startRun, 400);
  } catch (err) {
    console.error(err);
    $('load-msg').textContent = `불러오기 실패: ${err.message}. HTTP 서버로 열었는지 확인해 주세요.`;
  }
})();

// ---------- Flow ----------
function toMenu() {
  mode = 'menu';
  $('title').classList.remove('hidden');
  $('hud').classList.remove('on');
  $('result').classList.add('hidden');
  $('pause').classList.add('hidden');
  const best = saved.best;
  $('best-line').innerHTML = best > 0 ? `최고 기록 <b>${best.toLocaleString()}</b> · ${Math.round(saved.bestDist).toLocaleString()} m` : '첫 달리기는 튜토리얼 코스로 시작해요';
  renderMissions($('title-missions'), null);
  if (run.p.s > 1 || !run.p.alive) resetRun();
  audio.stopMusic();
}

function resetRun() {
  world.clear();
  const seed = params.get('seed') ? Number(params.get('seed')) : (Math.random() * 2 ** 31) | 0;
  run = new Run({ seed, tutorial: saved.runs < 2 || saved.best < 1500 || params.has('tutorial'), bonus: bonusFor(saved.missions.stars) });
  world.sync(run.track);
  slowmo = 1; slowmoT = 0; hitstop = 0; shake = 0; deadT = 0;
  for (const k in input) input[k] = 0;
  $('tricks').innerHTML = '';
  $('powers').innerHTML = '';
  hideHint();
}

function startRun() {
  if (!character) return;
  audio.unlock();
  if (mode === 'dead' || run.p.s > 1 || !run.p.alive) resetRun();
  mode = 'run';
  $('title').classList.add('hidden');
  $('result').classList.add('hidden');
  $('hud').classList.add('on');
  $('touch-help').classList.toggle('hidden', !isTouch);
  if (isTouch) setTimeout(() => $('touch-help').classList.add('hidden'), 6000);
  audio.play('start');
  audio.startMusic();
}

function pause(on) {
  if (on && mode === 'run') { mode = 'paused'; $('pause').classList.remove('hidden'); audio.muffle(true); }
  else if (!on && mode === 'paused') { mode = 'run'; $('pause').classList.add('hidden'); audio.muffle(false); lastT = performance.now(); }
}

function gameOver() {
  mode = 'dead';
  deadT = 0;
  hideHint();
  const score = Math.round(run.score);
  const isBest = score > saved.best;
  saved.runs++;
  if (isBest) { saved.best = score; }
  saved.bestDist = Math.max(saved.bestDist, run.distance);
  checkMissions(saved.missions, run);
  const shown = saved.missions.active.map(m => ({ ...m }));
  const finalRun = run;
  const gained = settleMissions(saved.missions);
  store.set(KEY, saved);
  setTimeout(() => {
    if (mode !== 'dead') return;
    $('cause').textContent = CAUSE_TEXT[run.p.cause] || '넘어졌어요';
    $('final-score').textContent = score.toLocaleString();
    $('best-text').textContent = isBest ? '최고 기록 갱신!' : `최고 기록 ${saved.best.toLocaleString()}`;
    $('newbest').classList.toggle('hidden', !isBest);
    $('st-dist').textContent = `${Math.round(run.distance).toLocaleString()} m`;
    $('st-chips').textContent = run.chips.toLocaleString();
    $('st-mult').textContent = `×${run.stats.bestMult}`;
    $('st-tricks').textContent = run.stats.tricks.toLocaleString();
    renderMissions($('result-missions'), { list: shown, run: finalRun, gained });
    $('result').classList.remove('hidden');
    $('hud').classList.remove('on');
    if (isBest) audio.play('best');
    if (AUTO) setTimeout(startRun, 1500);
  }, 1300);
  audio.stopMusic();
}

// ---------- Input ----------
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'jump', KeyW: 'jump', Space: 'jump', ArrowDown: 'down', KeyS: 'down',
};
window.addEventListener('keydown', e => {
  if (e.code === 'KeyM') { toggleMute(); return; }
  if (e.code === 'Escape' || e.code === 'KeyP') { if (mode === 'run') pause(true); else if (mode === 'paused') pause(false); return; }
  if (mode === 'menu' && (e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); startRun(); return; }
  if (mode === 'dead' && (e.code === 'Space' || e.code === 'Enter') && !$('result').classList.contains('hidden')) { e.preventDefault(); startRun(); return; }
  const a = KEYMAP[e.code];
  if (a) {
    e.preventDefault();
    if (e.repeat) return;
    if (mode === 'run') input[a]++;
  }
});

let touchStart = null;
canvas.addEventListener('pointerdown', e => {
  audio.unlock();
  if (mode !== 'run') return;
  touchStart = { x: e.clientX, y: e.clientY, t: performance.now(), done: false };
});
canvas.addEventListener('pointermove', e => {
  if (!touchStart || touchStart.done || mode !== 'run') return;
  const dx = e.clientX - touchStart.x, dy = e.clientY - touchStart.y;
  const th = Math.max(26, Math.min(window.innerWidth, window.innerHeight) * 0.045);
  if (Math.hypot(dx, dy) > th) {
    touchStart.done = true;
    if (Math.abs(dx) > Math.abs(dy)) input[dx < 0 ? 'left' : 'right']++;
    else input[dy < 0 ? 'jump' : 'down']++;
  }
});
canvas.addEventListener('pointerup', () => {
  if (touchStart && !touchStart.done && mode === 'run' && performance.now() - touchStart.t < 300) input.jump++;
  touchStart = null;
});

$('start-btn').addEventListener('click', startRun);
$('retry-btn').addEventListener('click', startRun);
$('menu-btn').addEventListener('click', () => { resetRun(); toMenu(); });
$('resume-btn').addEventListener('click', () => pause(false));
$('quit-btn').addEventListener('click', () => { pause(false); resetRun(); toMenu(); });
$('pause-btn').addEventListener('click', () => pause(true));
$('mute-btn').addEventListener('click', toggleMute);
function toggleMute() {
  saved.muted = !saved.muted;
  audio.setMuted(saved.muted);
  store.set(KEY, saved);
  $('mute-btn').textContent = saved.muted ? '✕' : '♪';
}
$('mute-btn').textContent = saved.muted ? '✕' : '♪';
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(true); });
window.addEventListener('blur', () => { if (!AUTO) pause(true); });

// ---------- Missions ----------
function renderMissions(el, result) {
  const st = saved.missions;
  const list = result ? result.list : st.active;
  const rows = list.map(m => {
    const v = result ? Math.min(m.goal, missionValue(m, result.run)) : 0;
    const prog = result && !m.done ? `<span class="mprog">${v.toLocaleString()} / ${m.goal.toLocaleString()}</span>` : '';
    return `<li class="${m.done ? 'done' : ''}"><i>${m.done ? '★' : '☆'}</i><span>${missionText(m)}</span>${prog}</li>`;
  }).join('');
  const head = result && result.gained
    ? `미션 ${result.gained}개 달성! <b>★ ${st.stars}</b> · 점수 보너스 +${Math.round((bonusFor(st.stars) - 1) * 100)}%`
    : `미션 <b>★ ${st.stars}</b> · 점수 보너스 +${Math.round((bonusFor(st.stars) - 1) * 100)}%`;
  el.innerHTML = `<div class="mhead">${head}</div><ul>${rows}</ul>`;
}
let missionTick = 0;
function updateMissions(dt) {
  missionTick += dt;
  if (missionTick < 0.25) return;
  missionTick = 0;
  for (const m of checkMissions(saved.missions, run)) {
    popTrick('MISSION CLEAR!', 0, true);
    showHint(`★ 미션 달성: ${missionText(m)}`);
    audio.play('best');
  }
}

// ---------- HUD helpers ----------
let hintTimer = 0;
function showHint(text) { const h = $('hint'); h.textContent = text; h.classList.add('on'); hintTimer = 3.2; }
function hideHint() { $('hint').classList.remove('on'); hintTimer = 0; }

const TRICK_KO = {
  'PERFECT GAP': '퍼펙트 점프', GAP: '빌딩 점프', 'WALL RUN': '벽타기', FLIP: '공중제비', 'PERFECT HURDLE': '퍼펙트 허들',
  HURDLE: '허들', 'SLIDE UNDER': '슬라이딩', 'NEAR MISS': '아슬아슬', MANTLE: '기어오르기', LAUNCH: '점프대', SMASH: '부수기',
  'DIVE ROLL': '급강하', MAGNET: '자석', SHIELD: '실드', BOOST: '오버드라이브',
};
function popTrick(name, pts, big = false) {
  const box = $('tricks');
  const el = document.createElement('div');
  el.className = 'trick' + (big ? ' big' : '');
  el.innerHTML = `${name}<small>${pts ? '+' + pts.toLocaleString() : ''}</small>`;
  el.title = TRICK_KO[name] || name;
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(() => el.remove(), 1150);
}
function flash(color, strength = 0.35) {
  const f = $('flash');
  f.style.transition = 'none';
  f.style.background = `radial-gradient(ellipse at center, transparent 40%, ${color})`;
  f.style.opacity = strength;
  requestAnimationFrame(() => { f.style.transition = 'opacity .45s'; f.style.opacity = 0; });
}

const POWER_UI = { boost: ['»', '#ffd34d', '오버드라이브', BOOST_TIME], magnet: ['U', '#ff6fb5', '자석', MAGNET_TIME], shield: ['◆', '#7fe8ff', '실드', 1] };
let lastScoreShown = -1, lastMultShown = 0;
function updateHud() {
  const p = run.p;
  const sc = Math.round(run.score);
  if (sc !== lastScoreShown) { $('score').textContent = sc.toLocaleString(); lastScoreShown = sc; }
  $('score-sub').textContent = `${Math.round(run.distance).toLocaleString()} m`;
  $('chips').textContent = run.chips;
  const m = $('mult');
  m.style.setProperty('--flow', clamp(run.flow, 0, 1).toFixed(3));
  if (run.mult !== lastMultShown) { m.querySelector('b').textContent = `×${run.mult}`; m.dataset.m = run.mult; lastMultShown = run.mult; }
  const list = [];
  if (p.boost > 0) list.push(['boost', Math.min(1, p.boost / BOOST_TIME)]);
  if (p.magnet > 0) list.push(['magnet', p.magnet / MAGNET_TIME]);
  if (p.shield) list.push(['shield', 1]);
  const html = list.map(([k, v]) => { const [ic, c, label] = POWER_UI[k]; return `<div class="pw"><span class="ic" style="background:${c}">${ic}</span><span>${label}</span><span class="bar"><i style="background:${c};transform:scaleX(${v.toFixed(3)})"></i></span></div>`; }).join('');
  if ($('powers').innerHTML !== html) $('powers').innerHTML = html;
  $('speed-label').textContent = `${Math.round(p.speed * 3.6)} km/h`;
}

// ---------- Events → feedback ----------
const tmpV = new THREE.Vector3();
function feetPos() { return tmpV.set(run.p.x, run.p.y + 0.05, -run.p.s); }
function handleEvents(events) {
  const p = run.p;
  for (const e of events) {
    character?.trigger(e.type, e);
    if (e.type !== 'trick' && e.type !== 'hint') audio.play(e.type, e);
    switch (e.type) {
      case 'jump': world.emit(feetPos(), { n: 10, color: '#ffe6f4', speed: 2.5, up: 0.6, life: 0.45, size: 0.3, gravity: 2 }); break;
      case 'doubleJump': world.emit(feetPos(), { n: 26, color: '#7ff7ff', speed: 6, up: -1, life: 0.5, size: 0.22, gravity: 0, drag: 4 }); fovKick = 4; break;
      case 'land': {
        const k = clamp((e.fall || 0) / 18, 0.2, 1);
        world.emit(feetPos(), { n: Math.round(8 + 18 * k), color: '#ffe6f4', speed: 4 * k + 1, up: 0.4, life: 0.5, size: 0.35, gravity: 1, drag: 4 });
        shake = Math.max(shake, 0.08 * k);
        break;
      }
      case 'trick': {
        const big = e.name.startsWith('PERFECT') || e.name === 'WALL RUN';
        popTrick(e.name, e.pts, big);
        if (big) audio.play('trick');
        break;
      }
      case 'mult': {
        popTrick(`×${e.mult} COMBO!`, 0, true);
        const m = $('mult'); m.classList.add('pop'); setTimeout(() => m.classList.remove('pop'), 160);
        flash('rgba(255,95,184,.55)', 0.5);
        break;
      }
      case 'chip': world.emit(tmpV.set(p.x, p.y + 1.0, -p.s - 0.6), { n: 5, color: '#7ff7ff', speed: 2.5, up: 1.5, life: 0.35, size: 0.18, gravity: 3 }); break;
      case 'power': {
        const c = POWER_UI[e.kind][1];
        world.emit(tmpV.set(p.x, p.y + 1, -p.s), { n: 50, color: c, speed: 8, up: 2, life: 0.7, size: 0.3, gravity: 0, drag: 3 });
        flash(c + '99', 0.6);
        break;
      }
      case 'smash': {
        world.emit(tmpV.set(p.x, p.y + 0.8, -p.s - 1), { n: 40, color: '#ffb84d', speed: 9, up: 4, life: 0.7, size: 0.28, gravity: 14, drag: 1, vel: { x: 0, y: 0, z: -p.speed * 0.6 } });
        shake = Math.max(shake, 0.25); hitstop = 0.05;
        break;
      }
      case 'bump': shake = Math.max(shake, 0.3); flash('rgba(255,60,90,.6)', 0.55); break;
      case 'shieldBreak': world.emit(tmpV.set(p.x, p.y + 1, -p.s), { n: 60, color: '#7fe8ff', speed: 10, up: 2, life: 0.6, size: 0.25, gravity: 4, drag: 2 }); shake = 0.3; flash('rgba(127,232,255,.7)', 0.6); break;
      case 'pad': world.emit(feetPos(), { n: 40, color: '#68ffb0', speed: 5, up: 7, life: 0.6, size: 0.3, gravity: 6 }); fovKick = 8; break;
      case 'wallStart': world.emit(tmpV.set(p.x + e.side * 0.4, p.y + 0.4, -p.s), { n: 22, color: '#7ff7ff', speed: 4, up: 1, life: 0.4, size: 0.2, gravity: 4 }); break;
      case 'mantle': world.emit(feetPos(), { n: 10, color: '#ffffff', speed: 2, up: 1, life: 0.35, size: 0.25, gravity: 3 }); break;
      case 'hint': showHint(e.text); break;
      case 'crash':
        shake = 0.6; slowmo = 0.25; slowmoT = 0.7; flash('rgba(255,40,80,.7)', 0.7);
        world.emit(tmpV.set(p.x, p.y + 1, -p.s), { n: 50, color: '#ff8fb6', speed: 7, up: 3, life: 0.8, size: 0.3, gravity: 8 });
        gameOver();
        break;
    }
  }
}

// ---------- Camera ----------
const lookTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
const menuPos = new THREE.Vector3(), menuLook = new THREE.Vector3();
function updateCamera(dt) {
  const p = run.p;
  const speed = p.speed;
  menuBlend = damp(menuBlend, mode === 'menu' ? 1 : 0, 3.2, dt);
  // Chase: follow ground height smoothly, only partly follow jumps.
  const groundY = p.grounded || p.wall ? p.y : Math.min(p.y, Math.max(p.lastTop, p.y - 1.5) + (p.y - p.lastTop) * 0.45);
  camState.y = damp(camState.y, groundY, p.grounded ? 7 : 4, dt);
  const portrait = camera.userData.portrait;
  const back = (portrait ? 6.6 : 5.0) + (speed - 14) * 0.05 + (p.boost > 0 ? 1.2 : 0);
  const up = (portrait ? 3.2 : 2.45) - (p.slide > 0 ? 0.45 : 0);
  const wallShift = p.wall ? -p.wall.side * 0.9 : 0;
  camState.x = damp(camState.x, p.x * 0.62 + wallShift, 8, dt);
  camState.roll = damp(camState.roll, p.wall ? p.wall.side * 0.1 : 0, 6, dt);
  camPos.set(camState.x, camState.y + up, -p.s + back);
  lookTarget.set(p.x * 0.85, camState.y + 1.05, -p.s - 9);
  if (mode === 'dead') {
    // Swing up beside her and look down, so whatever she hit (ahead of her) does not
    // block the view. Desktop keeps her on the left; the result card sits on the right.
    deadT += dt;
    const k = THREE.MathUtils.smoothstep(deadT, 0.1, 1.4);
    const fall = p.cause === 'fall';
    const baseY = fall ? Math.max(p.y, p.lastTop - 3) : p.y;
    const narrow = camera.userData.portrait;
    const side = p.x > 0.5 ? -1 : 1;
    // Portrait: a high side view keeps her in the band above the result card.
    const high = narrow ? new THREE.Vector3(p.x + side * 3.4, baseY + 4.4, -p.s + 0.6) : new THREE.Vector3(p.x + side * 2.4, baseY + 3.6, -p.s + 2.2);
    camPos.lerp(high, k);
    lookTarget.lerp(narrow ? new THREE.Vector3(p.x - side * 0.3, baseY - 3.4, -p.s + 0.6) : new THREE.Vector3(p.x - side * 0.2, baseY + 0.1, -p.s - 1.9), k);
  }
  // Title: the character stands at the origin facing +Z, so the camera sits in front of her.
  if (camera.userData.portrait) { menuPos.set(0.15, 1.25, 5.4); menuLook.set(0.15, 0.1, 0); }
  else { menuPos.set(-1.45, 1.0, 4.2); menuLook.set(-1.05, 0.78, 0); }
  camera.position.copy(camPos).lerp(menuPos, menuBlend);
  const lt = lookTarget.lerp(menuLook, menuBlend);
  if (shake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    shake = Math.max(0, shake - dt * 1.6);
  }
  camera.up.set(Math.sin(camState.roll), Math.cos(camState.roll), 0);
  camera.lookAt(lt);
  if (qaCam) {
    // QA orbit camera relative to the runner (only with ?qa=1).
    camera.position.set(p.x + qaCam[0], p.y + qaCam[1], -p.s + qaCam[2]);
    camera.up.set(0, 1, 0);
    camera.lookAt(p.x, p.y + (qaCam[3] ?? 0.9), -p.s);
  }
  fovKick = Math.max(0, fovKick - dt * 14);
  const targetFov = (portrait ? 74 : 60) + (speed - 14) * 0.65 + (p.boost > 0 ? 9 : 0) + fovKick;
  camState.fov = damp(camState.fov, mode === 'menu' ? 40 : targetFov, 5, dt);
  if (Math.abs(camera.fov - camState.fov) > 0.01) { camera.fov = camState.fov; camera.updateProjectionMatrix(); }
}

let qaCam = null;
let qaFreeze = false;
// ---------- Loop ----------
let lastT = performance.now();
let perfAcc = 0, perfFrames = 0, perfChecks = 0;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (mode === 'loading') return;
  // Adaptive quality: drop resolution, then bloom, if frames are slow.
  perfAcc += dt; perfFrames++;
  if (perfAcc > 3) {
    const avg = perfAcc / perfFrames;
    if (avg > 0.026 && perfChecks < 3) {
      if (pixelRatio > 1) { pixelRatio = Math.max(1, pixelRatio - 0.5); resize(); }
      else if (useBloom) useBloom = false;
      perfChecks++;
    }
    perfAcc = 0; perfFrames = 0;
  }
  if (slowmoT > 0) { slowmoT -= dt; if (slowmoT <= 0) slowmo = 1; }
  let simDt = dt * slowmo;
  if (hitstop > 0) { hitstop -= dt; simDt = 0; }

  if (qaFreeze) simDt = 0;
  if (mode === 'run' || mode === 'dead') {
    if (mode === 'run' && bot) {
      const c = bot(run);
      for (const k in c) input[k] += c[k];
    }
    run.update(simDt, mode === 'run' ? input : {});
    for (const k in input) input[k] = 0;
    handleEvents(run.drainEvents());
    world.sync(run.track);
    if (mode === 'run') { updateHud(); updateMissions(dt); }
  }
  if (hintTimer > 0) { hintTimer -= dt; if (hintTimer <= 0) hideHint(); }

  const p = run.p;
  // Continuous effects
  if (mode === 'run') {
    if (p.slide > 0 && p.grounded) world.emit(tmpV.set(p.x + (Math.random() - 0.5) * 0.3, p.y + 0.05, -p.s + 0.2), { n: 2, color: '#ffb25a', speed: 2, up: 1.6, life: 0.3, size: 0.13, gravity: 9, vel: { x: 0, y: 0, z: p.speed * 0.5 } });
    if (p.wall) world.emit(tmpV.set(p.x + p.wall.side * 0.45, p.y + 0.1, -p.s + 0.2), { n: 2, color: '#7ff7ff', speed: 1.5, up: 0.5, life: 0.35, size: 0.14, gravity: 3, vel: { x: 0, y: 0, z: p.speed * 0.4 } });
    if (p.boost > 0) world.emit(tmpV.set(p.x + (Math.random() - 0.5) * 0.5, p.y + 0.4 + Math.random() * 1.2, -p.s + 0.5), { n: 3, color: '#ffd34d', speed: 0.6, up: 0, life: 0.4, size: 0.28, gravity: 0, vel: { x: 0, y: 0, z: p.speed * 0.3 } });
    audio.intensity = clamp((run.mult - 1) / 5, 0, 1);
    audio.boost = p.boost > 0;
  }
  bubble.visible = !!p.shield && mode !== 'menu';
  if (bubble.visible) { bubble.position.set(p.x, p.y + 0.9, -p.s); bubble.material.uniforms.time.value = now / 1000; }

  if (character) {
    const view = mode === 'menu' ? { mode: 'menu', p: { x: 0, y: 0, s: 0 }, time: now / 1000 } : { mode: mode === 'dead' ? 'dead' : 'run', p, time: now / 1000 };
    if (mode !== 'paused') character.update(dt * (mode === 'dead' ? slowmo : 1), view);
  }
  updateCamera(mode === 'paused' ? 0 : dt);
  world.update(mode === 'paused' ? 0 : simDt || dt * 0.0001, run, camera, { speedLines: mode === 'run' ? clamp((p.speed - 16) / 12, 0, 1) * 0.7 + (p.boost > 0 ? 0.6 : 0) : 0 });
  bloom.strength = 0.4 + world.neonLevel * 0.25;
  if (useBloom) composer.render(); else renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// ---------- QA hooks (read-only snapshot; ?auto=1 lets the autopilot play) ----------
window.__runner = {
  snapshot: () => ({ mode, s: run.p.s, x: run.p.x, y: run.p.y, lane: run.p.lane, alive: run.p.alive, cause: run.p.cause, score: Math.round(run.score), mult: run.mult, chips: run.chips, speed: run.p.speed, grounded: run.p.grounded, slide: run.p.slide, wall: !!run.p.wall }),
  start: () => startRun(),
  ...(params.has('qa') ? {
    cam: v => { qaCam = v; },
    freeze: v => { qaFreeze = !!v; },
    run: () => run,
    character: () => character,
    setMode: m => { mode = m; },
    palette: s => { world.paletteS = s; },
  } : {}),
  info: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, geos: renderer.info.memory.geometries, tex: renderer.info.memory.textures, pixelRatio, useBloom }),
};
