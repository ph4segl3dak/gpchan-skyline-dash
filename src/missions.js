// Three active missions at a time. Each clear adds a star; every star adds +5% score for good.
const POOL = [
  { key: 'dist', text: n => `한 판에 ${n.toLocaleString()} m 달리기`, sizes: [500, 1000, 1600, 2400, 3500, 5000] },
  { key: 'chips', text: n => `한 판에 칩 ${n}개 모으기`, sizes: [60, 120, 200, 320, 450] },
  { key: 'wallRuns', text: n => `한 판에 벽타기 ${n}번`, sizes: [2, 4, 7, 10] },
  { key: 'flips', text: n => `한 판에 공중제비(2단 점프) ${n}번`, sizes: [3, 6, 10, 15] },
  { key: 'perfects', text: n => `한 판에 퍼펙트 ${n}번`, sizes: [3, 8, 15, 25] },
  { key: 'nearMiss', text: n => `한 판에 아슬아슬 회피 ${n}번`, sizes: [2, 5, 9, 14] },
  { key: 'bestMult', text: n => `배율 ×${n} 달성`, sizes: [3, 4, 5, 6, 7, 8] },
  { key: 'smashes', text: n => `오버드라이브로 ${n}개 부수기`, sizes: [2, 5, 9] },
  { key: 'score', text: n => `한 판에 ${n.toLocaleString()}점`, sizes: [3000, 8000, 15000, 30000, 60000, 100000] },
];

export function createMissionState(saved) {
  const st = saved && Array.isArray(saved.active) ? saved : { stars: 0, level: {}, active: [] };
  st.level ||= {};
  while (st.active.length < 3) st.active.push(nextMission(st));
  return st;
}

function nextMission(st) {
  const used = new Set(st.active.map(m => m.key));
  const options = POOL.filter(p => !used.has(p.key) && (st.level[p.key] || 0) < p.sizes.length);
  const pick = options.length ? options[Math.floor(Math.random() * options.length)] : POOL[0];
  const lv = Math.min(st.level[pick.key] || 0, pick.sizes.length - 1);
  return { key: pick.key, goal: pick.sizes[lv], done: false };
}

export function missionText(m) {
  return POOL.find(p => p.key === m.key).text(m.goal);
}

export function missionValue(m, run) {
  switch (m.key) {
    case 'dist': return Math.floor(run.distance);
    case 'chips': return run.chips;
    case 'score': return Math.floor(run.score);
    default: return run.stats[m.key] || 0;
  }
}

// Marks newly finished missions during a run; returns the ones just completed.
export function checkMissions(st, run) {
  const out = [];
  for (const m of st.active) {
    if (!m.done && missionValue(m, run) >= m.goal) { m.done = true; out.push(m); }
  }
  return out;
}

// After a run: bank stars, raise levels, refill.
export function settleMissions(st) {
  let gained = 0;
  st.active = st.active.filter(m => {
    if (!m.done) return true;
    gained++;
    st.stars++;
    st.level[m.key] = (st.level[m.key] || 0) + 1;
    return false;
  });
  while (st.active.length < 3) st.active.push(nextMission(st));
  return gained;
}

export const bonusFor = stars => 1 + stars * 0.05;
