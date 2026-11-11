// Safe-zone geometry and schedule. The server owns the zone state and sends it
// to clients; both sides use zoneCircleAt() to get the circle at any moment.

export const ZONE_START_RADIUS = 215;

// wait: seconds the circle holds still, shrink: seconds it takes to close in,
// frac: new radius as a fraction of the previous one, dps: damage per second
// taken outside the circle during this phase.
export const ZONE_PHASES = [
  { wait: 50, shrink: 30, frac: 0.55, dps: 1 },
  { wait: 35, shrink: 25, frac: 0.6, dps: 2 },
  { wait: 30, shrink: 22, frac: 0.55, dps: 4 },
  { wait: 25, shrink: 20, frac: 0.5, dps: 7 },
  { wait: 20, shrink: 16, frac: 0.45, dps: 10 },
  { wait: 15, shrink: 15, frac: 0, dps: 14 },
];

export function insideCircle(c, x, z) {
  const dx = x - c.x;
  const dz = z - c.z;
  return dx * dx + dz * dz <= c.r * c.r;
}

// Picks the next circle so that it lies completely inside `cur`.
// isOk(x, z) lets the caller reject centres on unreachable terrain.
export function pickNextCircle(cur, frac, rnd, isOk) {
  const r = cur.r * frac;
  const slack = cur.r - r;
  let best = { x: cur.x, z: cur.z, r };
  for (let i = 0; i < 30; i++) {
    // Rejection-sample a point in the unit disc (no trigonometry needed).
    let ux;
    let uz;
    do {
      ux = rnd() * 2 - 1;
      uz = rnd() * 2 - 1;
    } while (ux * ux + uz * uz > 1);
    const c = { x: cur.x + ux * slack, z: cur.z + uz * slack, r };
    if (!isOk || isOk(c.x, c.z)) return c;
    best = c;
  }
  return isOk ? { x: cur.x, z: cur.z, r } : best;
}

export function createZone(scale = 1) {
  const from = { x: 0, z: 0, r: ZONE_START_RADIUS };
  return {
    phase: 0,
    mode: 'wait', // 'wait' | 'shrink' | 'closed'
    from,
    to: { ...from },
    t0: 0,
    t1: 0,
    dps: ZONE_PHASES[0].dps,
    scale, // time multiplier, lets tests run fast matches
  };
}

// Starts phase 0. Call once when the match begins.
export function startZone(zone, time, rnd, isOk) {
  const ph = ZONE_PHASES[0];
  zone.phase = 0;
  zone.mode = 'wait';
  zone.to = pickNextCircle(zone.from, ph.frac, rnd, isOk);
  zone.t0 = time;
  zone.t1 = time + ph.wait * 1000 * zone.scale;
  zone.dps = ph.dps;
}

// Advances the state machine. Returns true when the state changed and must be
// re-broadcast to clients.
export function updateZone(zone, time, rnd, isOk) {
  if (zone.mode === 'closed' || time < zone.t1) return false;
  const ph = ZONE_PHASES[zone.phase];
  if (zone.mode === 'wait') {
    zone.mode = 'shrink';
    zone.t0 = zone.t1;
    zone.t1 = zone.t0 + ph.shrink * 1000 * zone.scale;
    return true;
  }
  // A shrink finished.
  zone.from = { ...zone.to };
  if (zone.phase + 1 >= ZONE_PHASES.length) {
    zone.mode = 'closed';
    zone.t0 = zone.t1;
    return true;
  }
  zone.phase++;
  const next = ZONE_PHASES[zone.phase];
  zone.mode = 'wait';
  zone.to = pickNextCircle(zone.from, next.frac, rnd, isOk);
  zone.t0 = zone.t1;
  zone.t1 = zone.t0 + next.wait * 1000 * zone.scale;
  zone.dps = next.dps;
  return true;
}

// Circle that is in force at `time`.
export function zoneCircleAt(zone, time, out = {}) {
  if (zone.mode !== 'shrink') {
    out.x = zone.from.x;
    out.z = zone.from.z;
    out.r = zone.from.r;
    return out;
  }
  let k = (time - zone.t0) / (zone.t1 - zone.t0);
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  out.x = zone.from.x + (zone.to.x - zone.from.x) * k;
  out.z = zone.from.z + (zone.to.z - zone.from.z) * k;
  out.r = zone.from.r + (zone.to.r - zone.from.r) * k;
  return out;
}
