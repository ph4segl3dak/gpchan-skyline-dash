import * as THREE from 'three';
import { topAt, droneX, WALL_X, mulberry32 } from './sim.js';

// Visual world: sky, city, track objects and particles. Track coords map to world (x, y, -s).

const W = (x, y, s) => new THREE.Vector3(x, y, -s);
const lerp = THREE.MathUtils.lerp;

// Time of day by distance. The run starts at sunset, goes through night and dawn, then loops.
const PALETTES = [
  { at: 0, top: '#2c3c9a', mid: '#ff86b0', horizon: '#ffc58a', bottom: '#5a3a78', sun: '#fff1c8', sunY: 0.07, fog: '#ee9fb2',
    hemiSky: '#ffd6e6', hemiGround: '#4a3a70', key: '#ffd2a8', keyI: 1.35, hemiI: 1.05, windows: 0.25, neon: 0.55, stars: 0, roof: '#6d6a9a', facade: '#4b4a7c' },
  { at: 1400, top: '#191a5a', mid: '#7a3497', horizon: '#ff6f8e', bottom: '#2a1840', sun: '#ffb0a0', sunY: -0.02, fog: '#94508f',
    hemiSky: '#c9a6ff', hemiGround: '#2d1f4d', key: '#ff9fb8', keyI: 0.95, hemiI: 0.95, windows: 0.75, neon: 1.0, stars: 0.35, roof: '#4e4a7e', facade: '#2f2d5a' },
  { at: 2800, top: '#050819', mid: '#101848', horizon: '#3a2c86', bottom: '#0b0a1e', sun: '#d8e6ff', sunY: 0.35, fog: '#241f5a',
    hemiSky: '#8aa2ff', hemiGround: '#1a1538', key: '#a9c2ff', keyI: 0.75, hemiI: 0.85, windows: 1.0, neon: 1.25, stars: 1, roof: '#3a3c6e', facade: '#1f2149' },
  { at: 4200, top: '#3d6fc2', mid: '#9ec0f2', horizon: '#ffd9b8', bottom: '#5a6aa0', sun: '#fff6e0', sunY: 0.05, fog: '#b9c6ea',
    hemiSky: '#e8f0ff', hemiGround: '#5a5f8a', key: '#fff0d8', keyI: 1.4, hemiI: 1.1, windows: 0.18, neon: 0.4, stars: 0, roof: '#7680ad', facade: '#566092' },
  { at: 5600, ref: 0 },
];
const CYCLE = 5600;
const colorCache = new Map();
const col = hex => { if (!colorCache.has(hex)) colorCache.set(hex, new THREE.Color(hex)); return colorCache.get(hex); };

function paletteAt(s) {
  const d = ((s % CYCLE) + CYCLE) % CYCLE;
  let i = 0;
  while (i < PALETTES.length - 2 && d >= PALETTES[i + 1].at) i++;
  const a = PALETTES[i], bRaw = PALETTES[i + 1], b = bRaw.ref !== undefined ? PALETTES[bRaw.ref] : bRaw;
  const span = bRaw.at - a.at;
  // Hold each palette for a while, then blend over the last 35%.
  let u = (d - a.at) / span;
  u = THREE.MathUtils.smoothstep(u, 0.65, 1);
  return { a, b, u };
}

function gradientMap() {
  const data = new Uint8Array([90, 170, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

function canvasTex(w, h, draw, repeat = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function windowTextures(seed) {
  const rnd = mulberry32(seed);
  const cols = 8, rows = 16, w = 256, h = 512;
  const lit = [];
  const base = canvasTex(w, h, (g) => {
    g.fillStyle = '#9aa0c4'; g.fillRect(0, 0, w, h);
    for (let r = 0; r < rows; r++) {
      g.fillStyle = 'rgba(40,40,80,0.18)';
      g.fillRect(0, r * 32 + 28, w, 4);
      for (let c = 0; c < cols; c++) {
        const on = rnd() < 0.42;
        lit.push(on);
        g.fillStyle = on ? '#3b3a5a' : '#2a2c48';
        g.fillRect(c * 32 + 6, r * 32 + 6, 20, 20);
      }
    }
  }, true);
  let k = 0;
  const emis = canvasTex(w, h, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    const warm = ['#ffd38a', '#ffe7b0', '#ffb36b', '#9fe8ff', '#ff9fd6'];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (lit[k++]) {
        g.fillStyle = warm[Math.floor(rnd() * warm.length)];
        g.fillRect(c * 32 + 6, r * 32 + 6, 20, 20);
      }
    }
  }, true);
  return { base, emis };
}

// Box with UVs in world units so window grids keep their size on any building.
function cityBox(w, h, d, tile = 8) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    uv.setXY(i, uv.getX(i) * dims[f][0] / tile, uv.getY(i) * dims[f][1] / (tile * 2));
  }
  return g;
}

const SIGN_WORDS = ['지피짱', 'SKYLINE', 'NEON', 'ラーメン', '24H', 'DASH', '★GP★', '카페', 'ROOFTOP', 'つかまえて', 'NIGHT', '옥상'];
function signTexture(word, hue) {
  return canvasTex(512, 160, (g, w, h) => {
    g.fillStyle = 'rgba(10,8,30,0.92)'; g.fillRect(0, 0, w, h);
    g.strokeStyle = `hsl(${hue},100%,70%)`; g.lineWidth = 8; g.strokeRect(10, 10, w - 20, h - 20);
    g.font = '900 92px "Apple SD Gothic Neo","Hiragino Sans","Malgun Gothic",sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = `hsl(${hue},100%,60%)`; g.shadowBlur = 24;
    g.fillStyle = `hsl(${hue},100%,85%)`; g.fillText(word, w / 2, h / 2 + 4);
  });
}

function stripeTexture(a, b, n = 6) {
  return canvasTex(256, 64, (g, w, h) => {
    g.fillStyle = a; g.fillRect(0, 0, w, h);
    g.fillStyle = b;
    for (let i = -2; i < n * 2; i++) {
      g.beginPath();
      const x = i * (w / n);
      g.moveTo(x, h); g.lineTo(x + w / n / 2, h); g.lineTo(x + w / n, 0); g.lineTo(x + w / n / 2, 0); g.closePath(); g.fill();
    }
  });
}

function chevronTexture(dirLeft) {
  return canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = '#0c0f2a'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#59f3ff'; g.lineWidth = 6; g.strokeRect(8, 8, w - 16, h - 16);
    g.fillStyle = '#7ff7ff';
    for (let i = 0; i < 4; i++) {
      const x = 70 + i * 110;
      g.beginPath();
      if (dirLeft) { g.moveTo(x + 50, 60); g.lineTo(x, 128); g.lineTo(x + 50, 196); g.lineTo(x + 75, 196); g.lineTo(x + 25, 128); g.lineTo(x + 75, 60); }
      else { g.moveTo(x, 60); g.lineTo(x + 50, 128); g.lineTo(x, 196); g.lineTo(x + 25, 196); g.lineTo(x + 75, 128); g.lineTo(x + 25, 60); }
      g.closePath(); g.fill();
    }
  });
}

function cloudTexture(seed) {
  const rnd = mulberry32(seed);
  return canvasTex(512, 256, (g, w, h) => {
    for (let i = 0; i < 26; i++) {
      const x = 80 + rnd() * (w - 160), y = 110 + (rnd() - 0.5) * 70, r = 30 + rnd() * 70;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  });
}

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.time = 0;
    this.objects = new Map();
    this.grad = gradientMap();
    this.rng = mulberry32(99);
    this.buildMaterials();
    this.buildSky();
    this.buildLights();
    this.buildSkyline();
    this.buildParticles();
    this.buildSpeedLines();
    this.buildChips();
    this.buildShadow();
    this.sceneryCursor = -60;
    this.scenery = [];
    this.neonLevel = 1;
  }

  buildMaterials() {
    const win = windowTextures(7);
    this.winTex = win;
    const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap: this.grad, ...extra });
    this.mat = {
      facade: toon('#4b4a7c', { map: win.base, emissiveMap: win.emis, emissive: '#ffffff', emissiveIntensity: 0.3 }),
      sideFacade: toon('#3e3d6c', { map: win.base, emissiveMap: win.emis, emissive: '#ffffff', emissiveIntensity: 0.3 }),
      roof: toon('#6d6a9a'),
      roofLine: new THREE.MeshBasicMaterial({ color: '#6ff4ff', toneMapped: false }),
      ledge: new THREE.MeshBasicMaterial({ color: '#ff5fb8', toneMapped: false }),
      crate: ['#2fb3b0', '#ff8a4c', '#8b6cff', '#ffd25a'].map(c => toon(c, { map: stripeTexture('#ffffff', '#e4e4f0', 10) })),
      crateTop: toon('#e8e6ff'),
      ramp: toon('#ffd25a', { map: stripeTexture('#ffd25a', '#2b2440', 5) }),
      barrier: toon('#ffffff', { map: stripeTexture('#ffcf3a', '#1d1a30', 6), emissive: '#3a2a00', emissiveIntensity: 0.4 }),
      barrierGlow: new THREE.MeshBasicMaterial({ color: '#ffe066', toneMapped: false }),
      post: toon('#2b2d52'),
      droneBody: toon('#e9ecff'),
      droneDark: toon('#272a4d'),
      droneEye: new THREE.MeshBasicMaterial({ color: '#ff3b6b', toneMapped: false }),
      rotor: new THREE.MeshBasicMaterial({ color: '#bfefff', transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
      pad: new THREE.MeshBasicMaterial({ color: '#68ffb0', toneMapped: false }),
      padBase: toon('#232548'),
      wall: toon('#2a2c56', { map: win.base, emissiveMap: win.emis, emissive: '#ffffff', emissiveIntensity: 0.3 }),
      deco: toon('#8a87b8'),
      decoDark: toon('#45436e'),
      tank: toon('#c66b5a'),
      railing: new THREE.MeshBasicMaterial({ color: '#2a2850' }),
      blink: new THREE.MeshBasicMaterial({ color: '#ff3355', toneMapped: false }),
    };
    this.chevL = chevronTexture(true);
    this.chevR = chevronTexture(false);
    this.signTex = SIGN_WORDS.map((w, i) => signTexture(w, (i * 47 + 290) % 360));
    this.geo = {
      box: new THREE.BoxGeometry(1, 1, 1),
      cyl: new THREE.CylinderGeometry(1, 1, 1, 14),
      ring: new THREE.TorusGeometry(0.8, 0.07, 6, 32),
    };
  }

  buildSky() {
    const uniforms = {
      top: { value: new THREE.Color() }, mid: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
      bottom: { value: new THREE.Color() }, sunColor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 0.1, -1).normalize() },
      stars: { value: 0 }, time: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
      fragmentShader: `
        uniform vec3 top, mid, horizon, bottom, sunColor, sunDir; uniform float stars, time; varying vec3 vDir;
        float hash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
        void main(){
          vec3 d = normalize(vDir); float h = d.y;
          vec3 c = mix(horizon, mid, smoothstep(0.0, 0.22, h));
          c = mix(c, top, smoothstep(0.18, 0.75, h));
          c = mix(c, bottom, smoothstep(0.0, -0.25, h));
          float sd = max(dot(d, normalize(sunDir)), 0.0);
          c += sunColor * (smoothstep(0.9975, 0.9985, sd) * 1.4 + pow(sd, 90.0) * 0.55 + pow(sd, 9.0) * 0.22);
          if (stars > 0.0 && h > 0.05) {
            vec3 g = floor(d * 220.0); float s = hash(g);
            float tw = 0.6 + 0.4 * sin(time * 2.0 + s * 40.0);
            c += vec3(step(0.9965, s) * stars * tw * smoothstep(0.05, 0.3, h));
          }
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.skyU = uniforms;
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog('#ee9fb2', 60, 520);
    // Clouds: big soft sprites far away, tinted by the palette.
    this.clouds = [];
    for (let i = 0; i < 14; i++) {
      const m = new THREE.SpriteMaterial({ map: cloudTexture(i + 3), transparent: true, depthWrite: false, fog: false, opacity: 0.8 });
      const sp = new THREE.Sprite(m);
      const sc = 140 + this.rng() * 160;
      sp.scale.set(sc, sc * 0.4, 1);
      sp.userData = { ox: (this.rng() - 0.5) * 1400, oy: 60 + this.rng() * 150, oz: -300 - this.rng() * 400, drift: 0.5 + this.rng() };
      sp.renderOrder = -9;
      this.scene.add(sp);
      this.clouds.push(sp);
    }
  }

  buildLights() {
    this.hemi = new THREE.HemisphereLight('#ffd6e6', '#4a3a70', 1.0);
    this.key = new THREE.DirectionalLight('#ffd2a8', 1.3);
    this.key.position.set(-6, 10, -8);
    this.scene.add(this.hemi, this.key, this.key.target);
    this.rim = new THREE.DirectionalLight('#7fdcff', 0.6);
    this.rim.position.set(5, 4, 8);
    this.scene.add(this.rim);
  }

  buildSkyline() {
    const count = 260;
    const geo = cityBox(1, 1, 1, 0.12);
    this.skyline = new THREE.InstancedMesh(geo, this.mat.sideFacade, count);
    this.skyline.frustumCulled = false;
    this.skylineData = [];
    for (let i = 0; i < count; i++) {
      const side = i % 2 ? 1 : -1;
      const tall = this.rng() < 0.3;
      this.skylineData.push({ x: side * (45 + this.rng() * 260), base: this.rng() * 1000 - 80, s: 0, w: 12 + this.rng() * 26, h: tall ? 110 + this.rng() * 120 : 40 + this.rng() * 60, dd: 12 + this.rng() * 26 });
    }
    this.resetSkyline();
    this.scene.add(this.skyline);
  }

  resetSkyline() {
    const m = new THREE.Matrix4();
    this.skylineData.forEach((d, i) => {
      d.s = d.base;
      m.compose(W(d.x, d.h / 2 - 90, d.s), new THREE.Quaternion(), new THREE.Vector3(d.w, d.h, d.dd));
      this.skyline.setMatrixAt(i, m);
    });
    this.skyline.instanceMatrix.needsUpdate = true;
  }

  buildParticles() {
    const N = 900;
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(N * 3);
    this.pCol = new Float32Array(N * 3);
    this.pSize = new Float32Array(N);
    this.pAlpha = new Float32Array(N);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.pAlpha, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { scale: { value: 600 } },
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying vec3 vC; varying float vA; uniform float scale;
        void main(){ vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vC; varying float vA; void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard; float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC * (0.6 + a), a * vA); }`,
    });
    this.particleMat = mat;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.parts = Array.from({ length: N }, () => ({ life: 0 }));
    this.pCursor = 0;
  }

  emit(pos, { n = 10, color = '#ffffff', speed = 4, up = 2, life = 0.6, size = 0.25, gravity = 8, spread = 1, drag = 1.5, vel = null } = {}) {
    const c = col(color);
    for (let i = 0; i < n; i++) {
      const p = this.parts[this.pCursor];
      this.pCursor = (this.pCursor + 1) % this.parts.length;
      const a = Math.random() * Math.PI * 2, r = Math.random();
      p.x = pos.x + (Math.random() - 0.5) * 0.3 * spread; p.y = pos.y + (Math.random() - 0.5) * 0.3 * spread; p.z = pos.z + (Math.random() - 0.5) * 0.3 * spread;
      p.vx = Math.cos(a) * speed * r + (vel ? vel.x : 0);
      p.vy = up * (0.4 + Math.random()) + (Math.random() - 0.5) * speed * 0.5 + (vel ? vel.y : 0);
      p.vz = Math.sin(a) * speed * r + (vel ? vel.z : 0);
      p.life = p.max = life * (0.6 + Math.random() * 0.6);
      p.size = size * (0.6 + Math.random() * 0.8);
      p.g = gravity; p.drag = drag;
      p.r = c.r; p.gc = c.g; p.b = c.b;
    }
  }

  buildSpeedLines() {
    const N = 90;
    const geo = new THREE.BufferGeometry();
    this.slPos = new Float32Array(N * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.slPos, 3));
    this.speedMat = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.speedLines = new THREE.LineSegments(geo, this.speedMat);
    this.speedLines.frustumCulled = false;
    this.scene.add(this.speedLines);
    this.sl = Array.from({ length: N }, () => this.resetLine({}, true));
  }

  resetLine(l, initial = false) {
    const a = Math.random() * Math.PI * 2, r = 2.5 + Math.random() * 6;
    l.ox = Math.cos(a) * r; l.oy = Math.sin(a) * r * 0.7 + 1.5;
    l.dz = initial ? Math.random() * 40 : 40 + Math.random() * 10;
    l.len = 2 + Math.random() * 4;
    return l;
  }

  buildChips() {
    const g = new THREE.OctahedronGeometry(0.26, 0);
    const m = new THREE.MeshBasicMaterial({ color: '#7ff7ff', toneMapped: false });
    this.chipMesh = new THREE.InstancedMesh(g, m, 600);
    this.chipMesh.frustumCulled = false;
    this.chipMesh.count = 0;
    this.scene.add(this.chipMesh);
    const gl = new THREE.OctahedronGeometry(0.36, 0);
    const ml = new THREE.MeshBasicMaterial({ color: '#2bd0ff', transparent: true, opacity: 0.35, wireframe: true, toneMapped: false });
    this.chipGlow = new THREE.InstancedMesh(gl, ml, 600);
    this.chipGlow.frustumCulled = false;
    this.chipGlow.count = 0;
    this.scene.add(this.chipGlow);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._v = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1);
  }

  buildShadow() {
    const tex = canvasTex(128, 128, (g, w, h) => {
      const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, 'rgba(10,6,30,0.75)'); gr.addColorStop(0.6, 'rgba(10,6,30,0.35)'); gr.addColorStop(1, 'rgba(10,6,30,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    tex.colorSpace = THREE.NoColorSpace;
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 2;
    this.scene.add(this.shadow);
  }

  // ---------- Track object meshes ----------
  makeRoof(pl, track) {
    const g = new THREE.Group();
    const len = pl.s1 - pl.s0, top = pl.y0, depth = 90;
    const wid = 12.5;
    const body = new THREE.Mesh(cityBox(wid, depth, len), this.mat.facade);
    body.position.copy(W(0, top - depth / 2 - 0.25, (pl.s0 + pl.s1) / 2));
    const slab = new THREE.Mesh(this.geo.box, this.mat.roof);
    slab.scale.set(wid + 0.3, 0.5, len + 0.3);
    slab.position.copy(W(0, top - 0.25, (pl.s0 + pl.s1) / 2));
    g.add(body, slab);
    // Lane guides and a glowing ledge so the jump point always reads.
    for (const x of [-1.15, 1.15]) {
      const line = new THREE.Mesh(this.geo.box, this.mat.roofLine);
      line.scale.set(0.05, 0.02, len - 1);
      line.position.copy(W(x, top + 0.011, (pl.s0 + pl.s1) / 2));
      line.material = this.mat.roofLine;
      g.add(line);
    }
    const ledge = new THREE.Mesh(this.geo.box, this.mat.ledge);
    ledge.scale.set(wid + 0.4, 0.14, 0.22);
    ledge.position.copy(W(0, top + 0.02, pl.s1 - 0.1));
    const lip = ledge.clone(); lip.position.copy(W(0, top + 0.02, pl.s0 + 0.1)); lip.material = this.mat.roofLine;
    g.add(ledge, lip);
    // Rooftop dressing outside the lanes.
    const rnd = mulberry32(pl.id * 31 + 7);
    for (let s = pl.s0 + 4; s < pl.s1 - 4; s += 7 + rnd() * 10) {
      for (const side of [-1, 1]) {
        if (rnd() < 0.35) continue;
        const x = side * (4.9 + rnd() * 1.0);
        const kind = rnd();
        if (kind < 0.4) {
          const ac = new THREE.Mesh(this.geo.box, this.mat.deco);
          ac.scale.set(1.2, 0.9 + rnd() * 0.5, 1.6); ac.position.copy(W(x, top + ac.scale.y / 2, s)); g.add(ac);
        } else if (kind < 0.6) {
          const tank = new THREE.Mesh(this.geo.cyl, this.mat.tank);
          tank.scale.set(0.8, 1.8, 0.8); tank.position.copy(W(x, top + 2.2, s));
          const legs = new THREE.Mesh(this.geo.box, this.mat.decoDark); legs.scale.set(1.2, 1.3, 1.2); legs.position.copy(W(x, top + 0.65, s));
          g.add(tank, legs);
        } else if (kind < 0.8) {
          const pole = new THREE.Mesh(this.geo.box, this.mat.decoDark);
          const h = 3 + rnd() * 4; pole.scale.set(0.08, h, 0.08); pole.position.copy(W(x, top + h / 2, s));
          const b = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), this.mat.blink); b.position.copy(W(x, top + h, s)); b.userData.blink = rnd() * 6;
          g.add(pole, b);
        } else {
          const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.0), new THREE.MeshBasicMaterial({ map: this.signTex[Math.floor(rnd() * this.signTex.length)], toneMapped: false, side: THREE.DoubleSide }));
          sign.position.copy(W(side * 6.1, top + 2.2 + rnd() * 1.5, s));
          sign.rotation.y = side * 0.9;
          const leg = new THREE.Mesh(this.geo.box, this.mat.post); leg.scale.set(0.1, 2.2, 0.1); leg.position.copy(W(side * 6.1, top + 1.1, s));
          sign.userData.neon = true;
          g.add(sign, leg);
        }
      }
    }
    // Railing posts at the far edges.
    const rail = new THREE.Mesh(this.geo.box, this.mat.railing);
    rail.scale.set(0.06, 0.06, len); const rail2 = rail.clone();
    rail.position.copy(W(-6.2, top + 1.0, (pl.s0 + pl.s1) / 2)); rail2.position.copy(W(6.2, top + 1.0, (pl.s0 + pl.s1) / 2));
    g.add(rail, rail2);
    return g;
  }

  makeCrate(pl) {
    const g = new THREE.Group();
    const len = pl.s1 - pl.s0, h = pl.y0 - pl.base;
    const body = new THREE.Mesh(this.geo.box, this.mat.crate[pl.tint || 0]);
    body.scale.set(pl.x1 - pl.x0, h, len);
    body.position.copy(W((pl.x0 + pl.x1) / 2, pl.base + h / 2, (pl.s0 + pl.s1) / 2));
    const top = new THREE.Mesh(this.geo.box, this.mat.roofLine);
    top.scale.set(pl.x1 - pl.x0 + 0.02, 0.05, 0.12);
    top.position.copy(W((pl.x0 + pl.x1) / 2, pl.y0, pl.s0));
    g.add(body, top);
    return g;
  }

  makeRamp(pl) {
    const len = pl.s1 - pl.s0, h = pl.y1 - pl.y0, w = pl.x1 - pl.x0;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(len, 0); shape.lineTo(len, h); shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
    geo.rotateY(Math.PI / 2);
    const m = new THREE.Mesh(geo, this.mat.ramp);
    // After rotation: shape x → -z, extrude depth → +x.
    m.position.copy(W(pl.x0, pl.y0, pl.s0));
    m.position.x = pl.x0;
    const g = new THREE.Group(); g.add(m);
    return g;
  }

  makeHazard(hz) {
    const g = new THREE.Group();
    if (hz.kind === 'barrier') {
      const w = hz.x1 - hz.x0 - 0.2;
      const board = new THREE.Mesh(this.geo.box, this.mat.barrier);
      board.scale.set(w, 0.55, 0.18); board.position.set(0, 0.68, 0);
      const glow = new THREE.Mesh(this.geo.box, this.mat.barrierGlow);
      glow.scale.set(w, 0.06, 0.2); glow.position.set(0, 0.98, 0);
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(this.geo.box, this.mat.post);
        leg.scale.set(0.12, 1.0, 0.5); leg.position.set(sx * (w / 2 - 0.15), 0.5, 0);
        g.add(leg);
      }
      g.add(board, glow);
      g.position.copy(W(hz.x, hz.yb, (hz.s0 + hz.s1) / 2));
    } else if (hz.kind === 'bar') {
      const w = hz.x1 - hz.x0;
      const sign = new THREE.Mesh(this.geo.box, new THREE.MeshBasicMaterial({ map: this.signTex[Math.floor(Math.random() * this.signTex.length)], toneMapped: false }));
      sign.scale.set(w, 1.1, 0.25);
      const under = new THREE.Mesh(this.geo.box, this.mat.ledge);
      under.scale.set(w, 0.06, 0.28); under.position.y = 1.12;
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(this.geo.box, this.mat.post);
        leg.scale.set(0.1, 3.4, 0.1); leg.position.set(sx * (w / 2 - 0.05), 1.7, 0);
        g.add(leg);
      }
      sign.position.y = 1.12 + 0.6;
      g.add(sign, under);
      g.userData.neon = sign;
      g.position.copy(W(hz.x, hz.yb - 1.12, (hz.s0 + hz.s1) / 2));
    } else if (hz.kind === 'drone') {
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 10), this.mat.droneBody);
      body.scale.set(1.1, 0.75, 1.1);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.06, 6, 24), this.mat.droneDark); band.rotation.x = Math.PI / 2;
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), this.mat.droneEye); eye.position.set(0, 0, 0.38);
      g.add(body, band, eye);
      const rotors = [];
      for (const [rx, rz] of [[-0.62, -0.62], [0.62, -0.62], [-0.62, 0.62], [0.62, 0.62]]) {
        const arm = new THREE.Mesh(this.geo.box, this.mat.droneDark); arm.scale.set(0.08, 0.06, 0.08);
        const r = new THREE.Mesh(new THREE.CircleGeometry(0.32, 16), this.mat.rotor); r.rotation.x = -Math.PI / 2; r.position.set(rx, 0.28, rz);
        const hub = new THREE.Mesh(this.geo.box, this.mat.droneDark); hub.scale.set(0.5, 0.06, 0.06); hub.position.set(rx * 0.6, 0.18, rz * 0.6); hub.rotation.y = Math.atan2(rx, rz) + Math.PI / 2;
        g.add(r, hub); rotors.push(r);
      }
      // Warning disc on the floor below the drone.
      const warn = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.75, 24), new THREE.MeshBasicMaterial({ color: '#ff3b6b', transparent: true, opacity: 0.6, toneMapped: false, depthWrite: false }));
      warn.rotation.x = -Math.PI / 2;
      g.userData = { rotors, warn };
      this.scene.add(warn);
      g.position.copy(W(hz.x, (hz.yb + hz.yt) / 2, (hz.s0 + hz.s1) / 2));
      g.userData.baseY = g.position.y;
      g.userData.ground = hz.yb - 0.3;
    }
    return g;
  }

  makeWall(w) {
    const g = new THREE.Group();
    const len = w.s1 - w.s0;
    const bw = 10, top = w.y1 + 3;
    const body = new THREE.Mesh(cityBox(bw, 100, len), this.mat.wall);
    body.position.copy(W(w.side * (WALL_X + bw / 2), top - 50, (w.s0 + w.s1) / 2));
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(len - 2, 2.6), new THREE.MeshBasicMaterial({ map: w.side < 0 ? this.chevR : this.chevL, toneMapped: false }));
    panel.material.map.wrapS = THREE.RepeatWrapping;
    panel.position.copy(W(w.side * (WALL_X - 0.02), w.y0 + 2 + 1.6, (w.s0 + w.s1) / 2));
    panel.rotation.y = -w.side * Math.PI / 2;
    const edge = new THREE.Mesh(this.geo.box, this.mat.roofLine);
    edge.scale.set(0.12, 0.12, len); edge.position.copy(W(w.side * (WALL_X + 0.05), top, (w.s0 + w.s1) / 2));
    g.add(body, panel, edge);
    return g;
  }

  makePad(pd) {
    const g = new THREE.Group();
    const base = new THREE.Mesh(this.geo.cyl, this.mat.padBase); base.scale.set(0.95, 0.16, 0.95); base.position.y = 0.08;
    const ring = new THREE.Mesh(this.geo.ring, this.mat.pad); ring.rotation.x = Math.PI / 2; ring.position.y = 0.18;
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.6, 4), this.mat.pad); arrow.position.y = 0.9;
    g.add(base, ring, arrow);
    g.userData.arrow = arrow;
    g.position.copy(W(pd.x, pd.y, pd.s));
    return g;
  }

  makePower(it) {
    const g = new THREE.Group();
    const colors = { magnet: '#ff6fb5', shield: '#7fe8ff', boost: '#ffd34d' };
    const c = colors[it.kind];
    const ring = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color: c, toneMapped: false }));
    ring.scale.setScalar(0.7);
    const icon = canvasTex(128, 128, (g2, w, h) => {
      g2.fillStyle = c; g2.beginPath(); g2.arc(64, 64, 58, 0, Math.PI * 2); g2.fill();
      g2.fillStyle = '#1a1438'; g2.font = '900 72px sans-serif'; g2.textAlign = 'center'; g2.textBaseline = 'middle';
      g2.fillText({ magnet: 'U', shield: '◆', boost: '»' }[it.kind], 64, 70);
    });
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: icon, toneMapped: false }));
    sp.scale.setScalar(0.85);
    g.add(ring, sp);
    g.userData.ring = ring;
    g.position.copy(W(it.x, it.y, it.s));
    return g;
  }

  sync(track) {
    const { added, removed } = track.drain();
    for (const o of added) {
      let mesh = null;
      if (track.platforms.includes(o)) {
        mesh = o.kind === 'roof' ? this.makeRoof(o, track) : o.kind === 'ramp' ? this.makeRamp(o) : this.makeCrate(o);
      } else if (track.hazards.includes(o)) mesh = this.makeHazard(o);
      else if (track.walls.includes(o)) mesh = this.makeWall(o);
      else if (track.pads.includes(o)) mesh = this.makePad(o);
      else if (track.pickups.includes(o) && o.kind !== 'chip') mesh = this.makePower(o);
      if (mesh) { this.scene.add(mesh); this.objects.set(o.id, { o, mesh }); }
    }
    for (const o of removed) this.removeObj(o.id);
  }

  removeObj(id) {
    const entry = this.objects.get(id);
    if (!entry) return;
    this.scene.remove(entry.mesh);
    if (entry.mesh.userData.warn) this.scene.remove(entry.mesh.userData.warn);
    this.objects.delete(id);
  }

  clear() {
    for (const id of [...this.objects.keys()]) this.removeObj(id);
    for (const s of this.scenery) this.scene.remove(s.mesh);
    this.scenery = [];
    this.sceneryCursor = -60;
    this.resetSkyline();
    for (const p of this.parts) p.life = 0;
  }

  // Low buildings beside the route for depth; they follow the route height.
  updateScenery(track, s) {
    while (this.sceneryCursor < s + 420) {
      const sc = this.sceneryCursor;
      const roof = track.platforms.find(p => p.kind === 'roof' && sc >= p.s0 && sc <= p.s1);
      const h = roof ? roof.y0 : (this.lastSceneryH ?? 0);
      this.lastSceneryH = h;
      for (const side of [-1, 1]) {
        if (this.rng() < 0.15) continue;
        const w = 8 + this.rng() * 14, d = 10 + this.rng() * 18;
        const x = side * (12 + w / 2 + this.rng() * 30);
        const top = h + (this.rng() < 0.1 ? 3 + this.rng() * 14 : -4 - this.rng() * 22);
        const m = new THREE.Mesh(cityBox(w, 100, d), this.mat.sideFacade);
        m.position.copy(W(x, top - 50, sc + d / 2));
        this.scene.add(m);
        this.scenery.push({ mesh: m, end: sc + d });
        if (this.rng() < 0.18) {
          const sign = new THREE.Mesh(new THREE.PlaneGeometry(7, 2.2), new THREE.MeshBasicMaterial({ map: this.signTex[Math.floor(this.rng() * this.signTex.length)], toneMapped: false, side: THREE.DoubleSide }));
          sign.position.copy(W(x - side * w / 2 - 0.1, top - 3 - this.rng() * 6, sc + d / 2));
          sign.rotation.y = side * Math.PI / 2;
          this.scene.add(sign);
          this.scenery.push({ mesh: sign, end: sc + d });
        }
      }
      this.sceneryCursor += 9 + this.rng() * 12;
    }
    this.scenery = this.scenery.filter(it => { if (it.end < s - 40) { this.scene.remove(it.mesh); it.mesh.geometry.dispose?.(); return false; } return true; });
  }

  applyPalette(s) {
    const { a, b, u } = paletteAt(s);
    const mix = (k, out) => out.copy(col(a[k])).lerp(col(b[k]), u);
    mix('top', this.skyU.top.value); mix('mid', this.skyU.mid.value); mix('horizon', this.skyU.horizon.value);
    mix('bottom', this.skyU.bottom.value); mix('sun', this.skyU.sunColor.value);
    mix('fog', this.scene.fog.color);
    mix('hemiSky', this.hemi.color); mix('hemiGround', this.hemi.groundColor); mix('key', this.key.color);
    this.hemi.intensity = lerp(a.hemiI, b.hemiI, u);
    this.key.intensity = lerp(a.keyI, b.keyI, u);
    const sunY = lerp(a.sunY, b.sunY, u);
    this.skyU.sunDir.value.set(-0.25, sunY, -1).normalize();
    this.skyU.stars.value = lerp(a.stars, b.stars, u);
    const win = lerp(a.windows, b.windows, u);
    this.mat.facade.emissiveIntensity = win; this.mat.sideFacade.emissiveIntensity = win * 0.9; this.mat.wall.emissiveIntensity = win;
    mix('roof', this.mat.roof.color); mix('facade', this.mat.facade.color); mix('facade', this.mat.sideFacade.color);
    this.mat.sideFacade.color.multiplyScalar(0.85);
    this.neonLevel = lerp(a.neon, b.neon, u);
    for (const c of this.clouds) c.material.color.copy(this.skyU.horizon.value).lerp(col('#ffffff'), 0.35).lerp(this.skyU.mid.value, 0.25);
  }

  update(dt, run, camera, fx) {
    this.time += dt;
    const t = this.time, p = run.p, track = run.track;
    this.sky.position.copy(camera.position);
    this.skyU.time.value = t;
    this.applyPalette(this.paletteS ?? p.s);
    this.key.position.set(p.x - 6, p.y + 12, -p.s + 6);
    this.key.target.position.set(p.x, p.y, -p.s - 10);
    // Clouds keep their distance in front of the camera with slow parallax.
    for (const c of this.clouds) {
      const d = c.userData;
      const x = ((d.ox + t * d.drift * 3 + 700) % 1400 + 1400) % 1400 - 700;
      c.position.set(camera.position.x + x, d.oy, camera.position.z + d.oz);
    }
    // Skyline recycling
    const m = this._m;
    let dirty = false;
    for (let i = 0; i < this.skylineData.length; i++) {
      const d = this.skylineData[i];
      if (d.s < p.s - 100) {
        d.s += 1000;
        m.compose(W(d.x, d.h / 2 - 90 + p.y * 0.5, d.s), this._q.identity(), this._v.set(d.w, d.h, d.dd));
        this.skyline.setMatrixAt(i, m);
        dirty = true;
      }
    }
    if (dirty) this.skyline.instanceMatrix.needsUpdate = true;
    this.updateScenery(track, p.s);

    // Hazards and pickups animation
    for (const { o, mesh } of this.objects.values()) {
      if (o.kind === 'drone') {
        if (o.broken) { mesh.visible = false; if (mesh.userData.warn) mesh.userData.warn.visible = false; continue; }
        const x = droneX(o, run.time);
        mesh.position.x = x;
        mesh.position.y = mesh.userData.baseY + Math.sin(t * 3 + o.id) * 0.08;
        mesh.rotation.z = (o.sweep ? Math.sin(run.time * 1.9 + o.phase) * 0.25 : 0);
        for (const r of mesh.userData.rotors) r.rotation.z += dt * 40;
        const warn = mesh.userData.warn;
        warn.position.set(x, mesh.userData.ground + 0.03, mesh.position.z);
        warn.material.opacity = 0.35 + 0.3 * Math.sin(t * 10);
      } else if ((o.kind === 'barrier' || o.kind === 'bar') && o.broken && mesh.visible) {
        mesh.visible = false;
      } else if (o.kind === 'magnet' || o.kind === 'shield' || o.kind === 'boost') {
        if (o.taken) { mesh.visible = false; continue; }
        mesh.position.y = o.y + Math.sin(t * 3 + o.id) * 0.15;
        mesh.userData.ring.rotation.y = t * 2.5;
        mesh.userData.ring.rotation.x = Math.PI / 2 + Math.sin(t * 2) * 0.4;
      } else if (mesh.userData.arrow) {
        mesh.userData.arrow.position.y = 0.8 + Math.abs(Math.sin(t * 5)) * 0.35;
      }
    }
    // Blinking antenna lights and neon flicker
    this.mat.blink.color.setScalar(Math.sin(t * 3) > 0.6 ? 1 : 0.15).multiply(col('#ff3355'));
    this.mat.roofLine.color.copy(col('#6ff4ff')).multiplyScalar(0.55 + 0.45 * this.neonLevel);
    this.mat.ledge.color.copy(col('#ff5fb8')).multiplyScalar(0.8 + 0.5 * this.neonLevel);

    // Chips (instanced)
    let n = 0;
    const spin = t * 3;
    for (const it of track.pickups) {
      if (it.kind !== 'chip' || it.taken) continue;
      if (it.s < p.s - 5 || it.s > p.s + 220) continue;
      if (n >= 600) break;
      this._q.setFromEuler(this._e.set(0, spin + it.s * 0.3, 0));
      const bob = Math.sin(t * 4 + it.s) * 0.08;
      m.compose(W(it.x, it.y + bob, it.s), this._q, this._s.set(1, 1.3, 1));
      this.chipMesh.setMatrixAt(n, m);
      this.chipGlow.setMatrixAt(n, m);
      n++;
    }
    this.chipMesh.count = this.chipGlow.count = n;
    this.chipMesh.instanceMatrix.needsUpdate = this.chipGlow.instanceMatrix.needsUpdate = true;

    // Blob shadow on whatever is below
    const below = run.supportBelow(p.x, p.s, p.y + 0.05);
    if (below !== null && p.alive) {
      const hgt = Math.max(0, p.y - below);
      this.shadow.visible = true;
      this.shadow.position.set(p.x, below + 0.03, -p.s);
      const k = Math.max(0.35, 1 - hgt * 0.18);
      this.shadow.scale.setScalar(k * (p.slide > 0 ? 1.5 : 1));
      this.shadow.material.opacity = k;
    } else this.shadow.visible = false;

    // Particles
    for (let i = 0; i < this.parts.length; i++) {
      const q = this.parts[i];
      if (q.life > 0) {
        q.life -= dt;
        q.vy -= q.g * dt;
        const dr = Math.exp(-q.drag * dt);
        q.vx *= dr; q.vz *= dr;
        q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
        const a = Math.max(0, q.life / q.max);
        this.pPos[i * 3] = q.x; this.pPos[i * 3 + 1] = q.y; this.pPos[i * 3 + 2] = q.z;
        this.pCol[i * 3] = q.r; this.pCol[i * 3 + 1] = q.gc; this.pCol[i * 3 + 2] = q.b;
        this.pSize[i] = q.size * (0.5 + a * 0.5);
        this.pAlpha[i] = a;
      } else this.pAlpha[i] = 0;
    }
    const ga = this.points.geometry.attributes;
    ga.position.needsUpdate = ga.color.needsUpdate = ga.size.needsUpdate = ga.alpha.needsUpdate = true;
    this.particleMat.uniforms.scale.value = this.renderer.domElement.height * 0.9;

    // Speed lines around the camera
    const intensity = fx.speedLines;
    this.speedMat.opacity = intensity * 0.55;
    this.speedMat.color.set(p.boost > 0 ? '#ffe28a' : '#ffffff');
    for (let i = 0; i < this.sl.length; i++) {
      const l = this.sl[i];
      l.dz -= dt * (p.speed * 2.2 + 20);
      if (l.dz < -6) this.resetLine(l);
      const z0 = camera.position.z - l.dz, x = camera.position.x + l.ox, y = camera.position.y - 2 + l.oy;
      const len = l.len * (0.5 + intensity);
      this.slPos.set([x, y, z0, x, y, z0 - len], i * 6);
    }
    this.speedLines.geometry.attributes.position.needsUpdate = true;
  }
}
