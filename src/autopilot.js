// Simple lookahead bot. Used by the Node fairness test and by ?auto=1 QA runs.
// It only reads the visible track and sends the same inputs a player can send.
import { laneX, topAt, droneX, G, WALL_X } from './sim.js';

export function createAutopilot() {
  let wallPressedFor = null;
  let lastLaneCmd = -9;

  function threats(run, lane, look) {
    const p = run.p, x = laneX(lane), out = [];
    for (const pl of run.track.platforms) {
      if (pl.kind === 'roof') continue;
      if (x < pl.x0 || x > pl.x1) continue;
      const d = pl.s0 - p.s;
      if (pl.s1 < p.s - 0.3 || d > look) continue;
      const top = topAt(pl, Math.max(p.s, pl.s0));
      if (pl.kind === 'ramp') continue;
      // A crate already underfoot is not a threat.
      if (p.y >= top - 0.05 && p.s >= pl.s0 - 0.3) continue;
      // Reachable from a ramp in the same lane.
      const ramp = run.track.platforms.find(r => r.kind === 'ramp' && r.lane === pl.lane && Math.abs(r.s1 - pl.s0) < 0.1 && r.x0 === pl.x0 + 0.05);
      if (ramp && ramp.s0 - p.s > -1) continue;
      out.push({ kind: 'crate', d: Math.max(0, d), cost: 4, top });
    }
    for (const hz of run.track.hazards) {
      if (hz.broken || hz.s1 < p.s - 0.3) continue;
      const d = hz.s0 - p.s;
      if (d > look) continue;
      let hx = hz.x;
      if (hz.kind === 'drone' && hz.sweep) {
        const arrive = run.time + Math.max(0, d) / p.speed;
        const xs = [droneX(hz, arrive - 0.15), droneX(hz, arrive), droneX(hz, arrive + 0.15)];
        if (xs.some(v => Math.abs(v - x) < 1.6)) out.push({ kind: 'drone', d: Math.max(0, d), cost: 2.5 });
        continue;
      }
      if (Math.abs(hx - x) > 1.0) continue;
      out.push({ kind: hz.kind, d: Math.max(0, d), cost: hz.kind === 'drone' ? 1.6 : 1 });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  return function decide(run) {
    const p = run.p, sp = p.speed, cmd = { left: 0, right: 0, jump: 0, down: 0 };
    if (!p.alive || p.wall) return cmd;
    const look = sp * 0.95;
    const roof = run.track.platforms.find(pl => pl.kind === 'roof' && p.s >= pl.s0 - 0.3 && p.s <= pl.s1);
    const next = run.track.platforms.filter(pl => pl.kind === 'roof' && pl.s0 > p.s + 0.2).sort((a, b) => a.s0 - b.s0)[0];
    const wallHere = side => run.track.walls.find(w => w.side === side && w.s0 <= p.s + 1 && w.s1 >= p.s + 4);

    // Lane choice
    const costs = [-1, 0, 1].map(l => {
      const th = threats(run, l, look);
      let c = th.reduce((m, t) => m + t.cost * (1.4 - Math.min(1, t.d / look)), 0);
      c += Math.abs(l - p.lane) * 0.15;
      return { l, c, th };
    });
    const nearLanes = l => {
      // Moving across lanes passes through the middle.
      const path = [];
      for (let i = Math.min(l, p.lane); i <= Math.max(l, p.lane); i++) path.push(i);
      return path.every(i => !threats(run, i, sp * 0.22).some(t => t.kind === 'crate'));
    };
    let best = costs.filter(c => nearLanes(c.l)).sort((a, b) => a.c - b.c)[0] || costs[p.lane + 1];
    // Wall gaps: line up with a panel before the ledge.
    if (roof && next && next.s0 - roof.s1 > sp * 0.8) {
      const w = run.track.walls.find(w => w.s0 <= roof.s1 && w.s1 >= next.s0);
      if (w && roof.s1 - p.s < sp * 1.6) best = costs[w.side + 1];
    }
    if (p.grounded && best.l !== p.lane && run.time - lastLaneCmd > 0.12) {
      if (best.l < p.lane) cmd.left = 1; else cmd.right = 1;
      lastLaneCmd = run.time;
    }

    const here = threats(run, p.lane, look)[0];
    if (p.grounded && here) {
      const tt = here.d / sp;
      if ((here.kind === 'barrier') && tt < 0.19) cmd.jump = 1;
      if (here.kind === 'drone' && tt < 0.2) cmd.jump = 1;
      if (here.kind === 'crate' && tt < 0.3 && best.l === p.lane) cmd.jump = 1;
      if (here.kind === 'bar' && tt < 0.22 && p.slide < 0.2) cmd.down = 1;
    }

    // Ledges
    if (roof && p.grounded && next) {
      const toEdge = roof.s1 - p.s;
      const gap = next.s0 - roof.s1;
      const wall = gap > sp * 0.8 ? run.track.walls.find(w => w.s0 <= roof.s1 && w.s1 >= next.s0) : null;
      const pad = run.track.pads.find(pd => pd.s > p.s && pd.s < roof.s1);
      if (!pad && toEdge > 0 && toEdge < 0.25 + sp * 0.03) {
        cmd.jump = 1;
        if (wall) wallPressedFor = wall;
      }
    }
    if (!p.grounded && wallPressedFor && !p.wall) {
      const side = wallPressedFor.side;
      if (p.s > wallPressedFor.s0 && run.time - p.jumpTime > 0.08 && wallHere(side)) {
        if (side < 0) cmd.left = 1; else cmd.right = 1;
        wallPressedFor = null;
      }
    }
    // Air: double jump when the landing falls short.
    if (!p.grounded && p.airJumps > 0 && p.vy < 0) {
      const below = run.supportBelow(p.x, p.s, p.y);
      if (below === null && next) {
        const dy = p.y - topAt(next, next.s0);
        const tFall = dy > 0 ? (p.vy + Math.sqrt(p.vy * p.vy + 2 * G * dy)) / G : 0;
        if (p.s + sp * tFall < next.s0 + 0.6) cmd.jump = 1;
      }
    }
    return cmd;
  };
}
