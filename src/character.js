import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// Procedural parkour animation on the original GPChan v026a VRM.
// Normalized VRM bones share a T-pose basis; the model faces local +Z.
// Upper arm: negative X swings forward, Z lowers the arm. Lower arm: Y bends the elbow.

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;
const smooth = v => { v = clamp(v, 0, 1); return v * v * (3 - 2 * v); };
const BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand',
  'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes'];

export const MODEL_HEIGHT = 1.72;

// Sprint cycle for one leg, phase 0 = foot strike. [phase, forward z, lift above ground] in leg lengths.
// Strike → stance (planted) → toe-off → heel kick → knee drive → reach → strike.
const RUN_KEYS = [
  [0.00, 0.20, 0.00],
  [0.11, 0.00, 0.00],
  [0.24, -0.40, 0.02],
  [0.38, -0.36, 0.40],
  [0.56, 0.08, 0.50],
  [0.72, 0.38, 0.34],
  [0.88, 0.34, 0.08],
  [1.00, 0.20, 0.00],
];
const catmull = (p0, p1, p2, p3, t) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};
// Smooth looping sample of the sprint keys: returns [z, lift].
function runFoot(ph) {
  const n = RUN_KEYS.length - 1;
  let i = 0;
  while (i < n - 1 && ph >= RUN_KEYS[i + 1][0]) i++;
  const k = j => RUN_KEYS[((j % n) + n) % n];
  const a = RUN_KEYS[i], b = RUN_KEYS[i + 1];
  const t = (ph - a[0]) / (b[0] - a[0]);
  const z = catmull(k(i - 1)[1], a[1], b[1], k(i + 2)[1], t);
  const lift = catmull(k(i - 1)[2], a[2], b[2], k(i + 2)[2], t);
  // Planted from strike to toe-off.
  return [z, ph < 0.24 ? 0 : Math.max(0, lift)];
}

export async function loadCharacter(onProgress = () => {}) {
  const loader = new GLTFLoader();
  loader.register(parser => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync('./assets/jibbi_chan_bunny_vroid_v026a_stocking_neutral.vrm',
    // Pages serves the VRM gzip-compressed, so the decoded byte count can exceed Content-Length.
    e => onProgress(e.loaded / Math.max(e.total || 0, 19421260)));
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('VRM 캐릭터 데이터가 없습니다.');
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });

  const bones = {}, targets = {};
  for (const name of BONES) {
    const b = vrm.humanoid.getNormalizedBoneNode(name);
    if (b) { bones[name] = b; targets[name] = new THREE.Quaternion(); }
  }
  vrm.update(0);
  vrm.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const scale = MODEL_HEIGHT / (box.max.y - box.min.y);
  vrm.scene.scale.setScalar(scale);
  const footY = -box.min.y * scale;
  const hipWorld = new THREE.Vector3();
  bones.hips.getWorldPosition(hipWorld);
  const hipHeight = hipWorld.y * scale + footY;

  // root (track position, yaw) → pivot at the hips (flips, rolls) → holder → vrm.scene
  const root = new THREE.Group();
  const pivot = new THREE.Group();
  pivot.position.y = hipHeight;
  const holder = new THREE.Group();
  holder.position.y = -hipHeight;
  vrm.scene.position.y = footY;
  holder.add(vrm.scene);
  pivot.add(holder);
  root.add(pivot);

  // Hair and ears simulate relative to the runner, not the world, so 30 m/s does not tear them.
  const sbm = vrm.springBoneManager;
  if (sbm) for (const j of sbm.joints) j.center = root;

  const hipsRestY = bones.hips.position.y;
  const legs = ['left', 'right'].map((side, i) => {
    const lower = bones[`${side}LowerLeg`], foot = bones[`${side}Foot`];
    return { side, sign: i === 0 ? 1 : -1, a: lower.position.length(), b: foot.position.length(),
      restA: lower.position.clone().normalize(), restB: foot.position.clone().normalize() };
  });
  const L = legs[0].a + legs[0].b;

  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion(), euler = new THREE.Euler();
  const down = new THREE.Vector3(0, -1, 0), axisX = new THREE.Vector3(1, 0, 0), axisZ = new THREE.Vector3(0, 0, 1), dir = new THREE.Vector3();
  const set = (name, x = 0, y = 0, z = 0) => { if (targets[name]) targets[name].setFromEuler(euler.set(x, y, z)); };
  const blend = (name, x, y, z, w) => { if (targets[name] && w > 0.0001) targets[name].slerp(qa.setFromEuler(euler.set(x, y, z)), clamp(w, 0, 1)); };

  // Two-bone leg IK toward a foot target relative to the hip joint (model units, +Z forward).
  const legIK = (leg, x, y, z, toe, w) => {
    const { side, a, b } = leg;
    const dist = clamp(Math.hypot(x, y, z), Math.abs(a - b) + 0.001, a + b - 0.003);
    const knee = Math.acos(clamp((dist * dist - a * a - b * b) / (2 * a * b), -1, 1));
    const pitch = -Math.atan2(z, Math.hypot(x, y)) - Math.atan2(b * Math.sin(knee), a + b * Math.cos(knee));
    const roll = Math.atan2(x, -y);
    dir.copy(down).applyAxisAngle(axisX, pitch).applyAxisAngle(axisZ, roll);
    qa.setFromUnitVectors(leg.restA, dir);
    targets[`${side}UpperLeg`].slerp(qa, w);
    dir.copy(down).applyAxisAngle(axisX, pitch + knee).applyAxisAngle(axisZ, roll);
    qb.setFromUnitVectors(leg.restB, dir);
    qc.copy(qa).invert().multiply(qb);
    targets[`${side}LowerLeg`].slerp(qc, w);
    targets[`${side}Foot`].slerp(qb.invert().multiply(qa.setFromEuler(euler.set(toe, 0, 0))), w);
  };

  // Arm by swing about world Y, lowering about Z, then twist about the arm's own axis,
  // so the elbow bend plane can be turned (hand on hip, waving forearm).
  const qy = new THREE.Quaternion(), qz = new THREE.Quaternion(), qx = new THREE.Quaternion(), qArm = new THREE.Quaternion();
  const axisY = new THREE.Vector3(0, 1, 0);
  const armQuat = (name, yaw, roll, twist, w = 1) => {
    if (!targets[name]) return;
    qArm.copy(qy.setFromAxisAngle(axisY, yaw)).multiply(qz.setFromAxisAngle(axisZ, roll)).multiply(qx.setFromAxisAngle(axisX, twist));
    if (w >= 1) targets[name].copy(qArm); else targets[name].slerp(qArm, w);
  };
  const arms = (lx, lz, lElbow, rx, rz, rElbow, w = 1, ly = 0, ry = 0) => {
    blend('leftUpperArm', lx, ly, lz, w); blend('rightUpperArm', rx, ry, rz, w);
    blend('leftLowerArm', 0, -lElbow, 0, w); blend('rightLowerArm', 0, rElbow, 0, w);
  };

  // Animation state
  let phase = 0, runW = 0, airW = 0, slideW = 0, wallW = 0, boostW = 0, crashW = 0, menuW = 1;
  let flipAngle = 0, roll = 0, pitch = 0, crouch = 0, landKick = 0, mantle = 0, stumble = 0;
  let glance = 0, lastX = 0, latVel = 0, wallSide = 1, flipT = 0, lastFlip = 0;
  let exprHappy = 0, exprSurprise = 0, exprSad = 0, blinkT = 0;

  function trigger(type, data = {}) {
    if (type === 'land') landKick = Math.max(landKick, clamp((data.fall || 0) / 22, 0.15, 1));
    if (type === 'mantle') mantle = 1;
    if (type === 'bump') { stumble = 1; exprSurprise = 1; }
    if (type === 'doubleJump') flipT = 0.0001;
    if (type === 'mult' && data.mult >= 3) { glance = 1.1; exprHappy = 1; }
    if (type === 'trick') exprHappy = Math.max(exprHappy, 0.55);
    if (type === 'power') exprHappy = 1;
    if (type === 'crash') { exprSurprise = 1; exprSad = 0; }
    if (type === 'wallStart') wallSide = data.side;
  }

  // view: { mode: 'menu'|'run'|'dead', p, time }
  function update(dt, view) {
    dt = clamp(dt, 0, 0.05);
    const p = view.p || {};
    const mode = view.mode;
    const t = view.time || 0;
    const running = mode === 'run';
    const grounded = running && p.grounded && !p.wall;
    const sliding = running && p.slide > 0 && p.grounded;
    const onWall = running && !!p.wall;
    const air = running && !p.grounded && !p.wall;
    const boosting = running && p.boost > 0;

    menuW = damp(menuW, mode === 'menu' ? 1 : 0, 6, dt);
    runW = damp(runW, (grounded && !sliding) || onWall ? 1 : 0, 14, dt);
    airW = damp(airW, air ? 1 : 0, air ? 16 : 22, dt);
    slideW = damp(slideW, sliding ? 1 : 0, sliding ? 22 : 12, dt);
    wallW = damp(wallW, onWall ? 1 : 0, 14, dt);
    boostW = damp(boostW, boosting && !air ? 1 : 0, 6, dt);
    crashW = damp(crashW, mode === 'dead' ? 1 : 0, 9, dt);
    if (p.wall) wallSide = p.wall.side;

    const speed = p.speed || 0;
    phase = (phase + dt * (running ? 2.5 + speed * 0.03 : 0)) % 1;
    latVel = damp(latVel, ((p.x ?? 0) - lastX) / Math.max(dt, 1e-4), 10, dt);
    lastX = p.x ?? 0;
    landKick = Math.max(0, landKick - dt * 4.2);
    mantle = Math.max(0, mantle - dt / 0.34);
    stumble = Math.max(0, stumble - dt / 0.55);
    glance = Math.max(0, glance - dt);
    if (flipT > 0) flipT += dt;
    if (!air || (p.flip || 0) <= 0) { if (flipT > 0.6 || !air) flipT = 0; }

    for (const n in targets) targets[n].identity();

    // ---- Menu idle: left hand on hip, right hand waving, gentle sway.
    const sway = Math.sin(t * 1.6);
    set('spine', 0.03, 0.04, 0.035 * sway);
    set('chest', 0.02, 0.06 + 0.03 * sway, 0.02);
    set('neck', 0, 0, 0.05);
    set('head', -0.06, -0.1 - 0.05 * sway, 0.13);
    armQuat('leftUpperArm', 0.3, -1.12, 1.45);
    set('leftLowerArm', 0, -1.75, 0);
    set('leftHand', 0, 0.3, 0);
    const wave = Math.sin(t * 8);
    armQuat('rightUpperArm', 0.45, 0.55, -1.5);
    set('rightLowerArm', 0, 1.75 + wave * 0.32, 0);
    set('rightHand', 0, 0, 0.1);

    // ---- Run cycle (also used on walls)
    const w = 1 - menuW;
    const lean = 0.36 + speed * 0.006 + boostW * 0.28;
    // c > 0 while the left leg reaches forward (its z peaks near phase 0.75).
    const c = Math.cos((phase - 0.75) * Math.PI * 2);
    const twist = c * 0.13;
    blend('hips', 0, twist, 0, w);
    blend('spine', lean, -twist * 0.6, 0, w);
    blend('chest', 0.08, -twist * 0.9, 0, w);
    blend('upperChest', 0, -twist * 0.3, 0, w);
    blend('neck', -lean * 0.2, twist * 0.4, 0, w);
    blend('head', -lean * 0.4, twist * 0.4, 0, w);
    // Sprint arms pump from the shoulder, opposite to the legs: forward hand rises
    // toward the chin with a tight elbow, the back arm opens with the elbow behind.
    arms(-0.3 + 1.05 * c, -1.3, 1.3 - 0.45 * c, -0.3 - 1.05 * c, 1.3, 1.3 + 0.45 * c, w);
    blend('leftHand', 0, 0, -0.15, w); blend('rightHand', 0, 0, 0.15, w);
    // Overdrive: arms swept back (the classic ninja run).
    arms(0.95, -1.15, 0.12, 0.95, 1.15, 0.12, boostW * w, -0.1, 0.1);

    // ---- Air: tuck on the way up, reach down on the way down.
    const vy = p.vy || 0;
    const rising = smooth((vy + 2) / 10);
    if (airW > 0.001) {
      blend('spine', 0.12 + 0.18 * rising, 0, 0, airW);
      blend('head', -0.18, 0, 0, airW);
      arms(-1.0 - 0.4 * rising, -0.7, 0.7, -0.4 + 0.6 * rising, 0.95, 1.0, airW);
      if (p.fastFall) arms(-2.4, -0.5, 0.2, -2.4, 0.5, 0.2, airW);
    }
    // Flip: tuck and hug the knees.
    const flipping = flipT > 0 && flipT < 0.55;
    const flipK = flipping ? Math.sin(Math.min(1, flipT / 0.55) * Math.PI) : 0;
    if (flipK > 0) {
      blend('spine', 0.55, 0, 0, flipK); blend('chest', 0.25, 0, 0, flipK); blend('head', 0.2, 0, 0, flipK);
      arms(-1.3, -0.8, 1.6, -1.3, 0.8, 1.6, flipK, 0.3, -0.3);
    }
    // ---- Slide: lean back, one leg forward, hand trailing.
    if (slideW > 0.001) {
      blend('spine', -0.15, 0.2, 0, slideW); blend('chest', 0.05, 0.15, 0, slideW); blend('head', 0.55, -0.25, 0, slideW);
      arms(0.9, -1.15, 0.15, -0.35, 1.0, 1.5, slideW, 0, 0);
    }
    // ---- Wall run: the arm on the wall side reaches toward it.
    if (wallW > 0.001) {
      const wl = wallSide < 0; // wall on the screen-left = character's left
      blend(wl ? 'leftUpperArm' : 'rightUpperArm', -0.6, 0, wl ? -0.1 : 0.1, wallW * 0.9);
      blend(wl ? 'leftLowerArm' : 'rightLowerArm', 0, wl ? -0.3 : 0.3, 0, wallW * 0.9);
      blend('head', -0.25, wl ? 0.2 : -0.2, 0, wallW);
    }
    // ---- Mantle: hands push down on the ledge, knees up.
    if (mantle > 0) {
      const m = Math.sin(mantle * Math.PI);
      arms(-0.9, -0.9, 0.3, -0.9, 0.9, 0.3, m);
      blend('spine', 0.5, 0, 0, m);
    }
    if (stumble > 0) {
      const s = Math.sin(stumble * Math.PI);
      arms(-1.6, -0.4, 0.6, 0.6, 0.6, 0.4, s);
      blend('spine', -0.15, 0.3, 0, s);
    }
    // ---- Crash
    if (crashW > 0.001) {
      const fall = p.cause === 'fall';
      const flail = Math.sin(t * 13);
      blend('spine', fall ? -0.2 : -0.35, 0, 0, crashW); blend('head', 0.3, 0, 0, crashW);
      arms(-2.2 + flail * 0.4, -0.5, 0.4, -2.2 - flail * 0.4, 0.5, 0.4, crashW);
    }
    // ---- Glance back at the camera after a big combo.
    if (glance > 0) {
      const g = Math.sin(Math.min(1, glance / 1.1) * Math.PI);
      const side = lastX > 0 ? -1 : 1;
      if (targets.neck) targets.neck.premultiply(qa.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, side * 0.7 * g));
      if (targets.head) targets.head.premultiply(qa.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, side * 0.45 * g));
      blend(side > 0 ? 'rightUpperArm' : 'leftUpperArm', -2.6, 0, side > 0 ? 0.5 : -0.5, g * 0.8);
      blend(side > 0 ? 'rightLowerArm' : 'leftLowerArm', 0, side > 0 ? 1.4 : -1.4, 0, g * 0.8);
    }

    // ---- Legs
    // Hips sink at mid-stance of each step and float during the flight phase.
    const stepU = (phase * 2) % 1;
    const bob = runW * (0.012 + 0.05 * Math.exp(-(((stepU - 0.11) / 0.09) ** 2))) * L;
    const desiredCrouch = landKick * 0.32 * L + runW * 0.035 * L + bob + mantle * 0.25 * L;
    crouch = damp(crouch, desiredCrouch, 30, dt);
    bones.hips.position.y = hipsRestY - crouch * (1 - menuW);
    for (const leg of legs) {
      const off = leg.sign > 0 ? 0 : 0.5;
      const ph = (phase + off) % 1;
      // Run: stance 0..0.38 pushes the foot back, swing drives the knee high.
      const [kz, lift] = runFoot(ph);
      const reach = 1 + Math.min(0.25, Math.max(0, speed - 14) * 0.015);
      let rx = leg.sign * 0.025 * L;
      let rz = kz * reach * L;
      let ry = -0.975 * L + crouch + lift * L;
      // Toe points down during push-off and the heel kick, flat on strike.
      let toe = ph < 0.11 ? 0 : ph < 0.45 ? 0.45 * Math.sin(Math.PI * (ph - 0.11) / 0.34) : -0.1 * Math.sin(Math.PI * (ph - 0.45) / 0.55);
      // Air: tuck rising, legs reach when falling; flip tucks tight.
      const front = leg.sign > 0 ? 1 : -0.6;
      const ax = leg.sign * 0.08 * L;
      const ay = THREE.MathUtils.lerp(-0.86, -0.55, rising) * L + (front > 0 ? 0.08 * L : 0);
      const az = (front > 0 ? 0.28 : -0.22) * L;
      // Slide: front leg straight, back leg folded under.
      const sy = (front > 0 ? -0.96 : -0.55) * L, sz = (front > 0 ? 0.12 : -0.12) * L, sx = leg.sign * (front > 0 ? 0.06 : 0.12) * L;
      // Menu: relaxed contrapposto
      const my = (leg.sign > 0 ? -0.995 : -0.97) * L, mz = (leg.sign > 0 ? 0.03 : -0.02) * L, mx = leg.sign * (leg.sign > 0 ? 0.03 : 0.08) * L;
      let fx = THREE.MathUtils.lerp(mx, rx, 1 - menuW), fy = THREE.MathUtils.lerp(my, ry, 1 - menuW), fz = THREE.MathUtils.lerp(mz, rz, 1 - menuW);
      fx = THREE.MathUtils.lerp(fx, ax, airW); fy = THREE.MathUtils.lerp(fy, ay, airW); fz = THREE.MathUtils.lerp(fz, az, airW);
      if (p.fastFall) { fy = THREE.MathUtils.lerp(fy, -0.95 * L, airW); fz = THREE.MathUtils.lerp(fz, front * 0.05 * L, airW); }
      if (flipK > 0) { fx = THREE.MathUtils.lerp(fx, leg.sign * 0.1 * L, flipK); fy = THREE.MathUtils.lerp(fy, -0.38 * L, flipK); fz = THREE.MathUtils.lerp(fz, 0.32 * L, flipK); }
      fx = THREE.MathUtils.lerp(fx, sx, slideW); fy = THREE.MathUtils.lerp(fy, sy, slideW); fz = THREE.MathUtils.lerp(fz, sz, slideW);
      if (mantle > 0) { const m = Math.sin(mantle * Math.PI); fy = THREE.MathUtils.lerp(fy, -0.5 * L, m); fz = THREE.MathUtils.lerp(fz, 0.15 * L, m); }
      if (crashW > 0.001) { fy = THREE.MathUtils.lerp(fy, (front > 0 ? -0.7 : -0.9) * L, crashW); fz = THREE.MathUtils.lerp(fz, front * 0.3 * L, crashW); }
      legIK(leg, fx, fy, fz, toe * (1 - airW), 1);
    }

    // ---- Whole-body pivot: flips, slide lean, wall roll, lane-change bank.
    const flipTarget = flipping ? smooth(flipT / 0.5) * Math.PI * 2 : 0;
    flipAngle = flipping ? flipTarget : damp(flipAngle, flipAngle > Math.PI ? Math.PI * 2 : 0, 20, dt);
    if (!flipping && Math.abs(flipAngle - Math.PI * 2) < 0.01) flipAngle = 0;
    const bank = clamp(-latVel * 0.035, -0.3, 0.3);
    const wallRoll = -wallSide * 0.62 * wallW;
    roll = damp(roll, bank * runW + wallRoll + bank * airW * 0.5, 12, dt);
    const crashPitch = mode === 'dead' ? (p.cause === 'fall' ? Math.sin(t * 3) * 0.8 - 0.4 : -1.25) : 0;
    pitch = damp(pitch, -1.1 * slideW + 0.25 * (p.fastFall ? airW : 0) + crashPitch * crashW + stumble * 0.25, 16, dt);
    pivot.rotation.set(pitch + flipAngle, 0, roll, 'YXZ');
    // Keep the slide close to the ground.
    pivot.position.y = hipHeight - slideW * 0.5 - (crashW * (p.cause === 'fall' ? 0 : 0.55));

    // Pose smoothing
    // The run cycle is ~3 Hz: slow smoothing would shrink and delay it, so track it tightly.
    const k = 1 - Math.exp(-dt * (flipping || mantle > 0 ? 40 : 26 + 54 * runW));
    for (const n in bones) bones[n].quaternion.slerp(targets[n], k);
    if (api.debugPose) for (const [n, e] of Object.entries(api.debugPose)) bones[n]?.quaternion.setFromEuler(euler.set(...e));

    // Root placement: track coords → world (forward is -Z).
    root.position.set(p.x ?? 0, p.y ?? 0, -(p.s ?? 0));
    // Blend from facing the title camera to running away from the chase camera.
    root.rotation.y = -0.12 * menuW + (Math.PI + clamp(-latVel * 0.012, -0.25, 0.25)) * (1 - menuW);

    // Expressions
    exprHappy = Math.max(0, exprHappy - dt * 0.9);
    exprSurprise = Math.max(0, exprSurprise - dt * 1.4);
    if (mode === 'dead') exprSad = damp(exprSad, 0.8, 3, dt); else exprSad = 0;
    blinkT += dt;
    const blink = blinkT % 3.7 > 3.55 ? Math.sin((blinkT % 3.7 - 3.55) / 0.15 * Math.PI) : 0;
    const em = vrm.expressionManager;
    if (em) {
      em.setValue('happy', mode === 'menu' ? 0.45 : Math.min(1, exprHappy) * (1 - exprSad));
      em.setValue('surprised', Math.min(1, exprSurprise));
      em.setValue('sad', exprSad);
      em.setValue('blink', glance > 0.2 ? 0 : Math.max(0, blink));
      em.setValue('blinkRight', glance > 0.2 ? Math.sin(Math.min(1, glance / 1.1) * Math.PI) : 0);
    }
    vrm.update(dt);
  }

  const api = { root, vrm, update, trigger, hipHeight, debugPose: null };
  return api;
}
