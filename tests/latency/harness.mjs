// Item-1 latency harness: how a remote body looks to another player over a
// 200 ms round trip with ±40 ms of jitter (each leg 100 ms ± 20 ms; websocket
// order kept, so a late packet holds up the ones behind it).
//
// A remote player walks, sprints, stops and turns on a seeded path. Their
// client sends its position 20 times a second (as Net.sendInput does); the
// relay ticks at 20 Hz, keeps the newest position it has received and sends a
// snapshot with its tick k; the viewer draws at 60 fps. Deterministic: no
// sockets, no timers, one seeded random stream.
//
// "before" is the old per-frame chase toward the newest snapshot, copied from
// origin/main (68dfd35) index.html:5937-5945; "after" is SnapBuffer lifted out
// of the current index.html. For each it prints:
//   stutter   % of moving frames whose drawn speed is off the true speed by
//             more than half (stalls, lurches)
//   shape     mean distance from the true path once each method's own delay
//             is taken out (best-fit delay below), tiles
//   delay     that best-fit delay, ms: how far in the past the body is drawn
//   raw       mean distance from where the player really is now, tiles
//
//   node tests/latency/harness.mjs
import { loadSnapBuffer } from './load-snapbuffer.mjs';

const SnapBuffer = loadSnapBuffer();

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// index.html:1228-1231
function pymod(a, b) { return ((a % b) + b) % b; }
function angDiff(a, b) { return pymod(b - a + Math.PI, 2 * Math.PI) - Math.PI; }

// origin/main 68dfd35 index.html:5937-5945, Net.update, one remote body.
function chase(p, dt) {
  const k = Math.min(1, dt * 12);
  p.pos[0] += (p.target[0] - p.pos[0]) * k;
  p.pos[1] += (p.target[1] - p.pos[1]) * k;
  p.a += angDiff(p.a, p.targetA) * k;
}

const RUN_MS = 60000, SKIP_MS = 3000, FRAME_MS = 1000 / 60;
const CLIENT_CLOCK = 987654;        // the remote player's performance.now() is not ours

// A path of straight legs: stop, walk (2.2 tiles/s) or sprint (3.85), turning
// between legs. Returns where the player is at any time.
function makePath(rand) {
  const legs = [];
  let t = 0, x = 10, y = 10, heading = 0;
  while (t < RUN_MS + 2000) {
    const roll = rand();
    const speed = roll < 0.15 ? 0 : roll < 0.6 ? 2.2 : 3.85;
    const ms = 400 + rand() * 2100;
    const turn = rand();
    heading += turn < 0.35 ? Math.PI / 2 : turn < 0.7 ? -Math.PI / 2 : (rand() - 0.5) * 0.6;
    legs.push({ t0: t, t1: t + ms, x, y, vx: Math.cos(heading) * speed / 1000, vy: Math.sin(heading) * speed / 1000, a: heading });
    x += Math.cos(heading) * speed * ms / 1000;
    y += Math.sin(heading) * speed * ms / 1000;
    t += ms;
  }
  let i = 0;
  return (time) => {
    while (i > 0 && legs[i].t0 > time) i--;
    while (i < legs.length - 1 && legs[i].t1 <= time) i++;
    const leg = legs[i], dt = Math.max(0, time - leg.t0);
    return { x: leg.x + leg.vx * dt, y: leg.y + leg.vy * dt, a: leg.a, speed: Math.hypot(leg.vx, leg.vy) * 1000 };
  };
}

// What the viewer receives: [{ arrival, k, x, y, a }], arrival ordered.
function network(path, rand, oneWay, jitter) {
  const leg = () => oneWay + (rand() * 2 - 1) * jitter;
  const inputs = [];
  let sendT = 0, up = 0;
  for (let t = 0; t < RUN_MS; t += FRAME_MS) {          // the remote player's frames
    sendT -= FRAME_MS;
    if (sendT <= 0) {
      sendT = 50;
      const p = path(t);
      up = Math.max(up, t + leg());
      inputs.push({ arrival: up, x: p.x, y: p.y, a: p.a, s: Math.round(t + CLIENT_CLOCK) });
    }
  }
  const snaps = [];
  let down = 0, seen = 0, latest = { ...path(0), s: undefined };
  for (let k = 1; k * 50 < RUN_MS; k++) {
    const at = 200 + k * 50 + (rand() * 2 - 1) * 3;      // relay tick, setInterval jitter
    while (seen < inputs.length && inputs[seen].arrival <= at) latest = inputs[seen++];
    down = Math.max(down, at + leg());
    snaps.push({ arrival: down, k, x: latest.x, y: latest.y, a: latest.a, s: latest.s });
  }
  return snaps;
}

function render(snaps, method, path) {
  const frames = [];
  const p = { pos: null, target: null, a: 0, targetA: 0 };
  const buffer = new SnapBuffer();
  let next = 0, last = 0;
  for (let t = 7; t < RUN_MS; t += FRAME_MS) {           // the viewer's frames
    while (next < snaps.length && snaps[next].arrival <= t) {
      const s = snaps[next++];
      if (method === 'before') {
        p.target = [s.x, s.y]; p.targetA = s.a;
        if (!p.pos) { p.pos = [s.x, s.y]; p.a = s.a; }
      } else {
        buffer.snap(s.k, s.arrival);
        buffer.add(1, s.x, s.y, s.a, method === 'after' ? s.s : undefined);
      }
    }
    const dt = Math.min(0.05, (t - (last || t - FRAME_MS)) / 1000);
    last = t;
    let pose = null;
    if (method === 'before') {
      if (p.pos) { chase(p, dt); pose = { x: p.pos[0], y: p.pos[1] }; }
    } else {
      buffer.frame(t);
      pose = buffer.pose(1);
    }
    if (pose && t >= SKIP_MS) frames.push({ t, x: pose.x, y: pose.y });
  }
  return frames;
}

function score(frames, path) {
  const errAt = (lag) => {
    let sum = 0;
    for (const f of frames) { const p = path(f.t - lag); sum += Math.hypot(f.x - p.x, f.y - p.y); }
    return sum / frames.length;
  };
  let best = { lag: 0, err: Infinity };
  for (let lag = 0; lag <= 600; lag += 2) {
    const err = errAt(lag);
    if (err < best.err) best = { lag, err };
  }
  let moving = 0, stutter = 0;
  for (let i = 1; i < frames.length; i++) {
    const truth = path(frames[i].t - best.lag);
    const before = path(frames[i - 1].t - best.lag);
    if (truth.speed < 0.5 || before.speed < 0.5) continue;
    moving++;
    const drawn = Math.hypot(frames[i].x - frames[i - 1].x, frames[i].y - frames[i - 1].y) / ((frames[i].t - frames[i - 1].t) / 1000);
    if (Math.abs(drawn - truth.speed) > truth.speed * 0.5) stutter++;
  }
  return { stutter: (stutter / moving) * 100, shape: best.err, delay: best.lag, raw: errAt(0) };
}

const METHODS = ['before', 'after-tick', 'after'];

function measure(oneWay, jitter, seeds = [1, 2, 3, 4, 5]) {
  const total = {};
  for (const method of METHODS) total[method] = { stutter: 0, shape: 0, delay: 0, raw: 0 };
  for (const seed of seeds) {
    const path = makePath(mulberry32(seed));
    const snaps = network(path, mulberry32(seed * 7919), oneWay, jitter);
    for (const method of METHODS) {
      const s = score(render(snaps, method, path), path);
      for (const key of Object.keys(s)) total[method][key] += s[key] / seeds.length;
    }
  }
  return total;
}

const f = (n, d = 1) => n.toFixed(d);
const row = (name, key, d, unit, { before, tick, after }) =>
  console.log(`  ${name.padEnd(15)} ${f(before[key], d).padStart(6)} ${unit} -> ${f(after[key], d).padStart(6)} ${unit}   (tick clock only: ${f(tick[key], d)})`);
for (const [label, oneWay, jitter] of [
  ['200 ms RTT ± 40 ms (each leg 100 ± 20)', 100, 20],
  ['200 ms RTT ± 80 ms (each leg 100 ± 40), stress', 100, 40],
  ['40 ms RTT, no jitter (near the room)', 20, 0],
]) {
  const m = measure(oneWay, jitter);
  const r = { before: m.before, tick: m['after-tick'], after: m.after };
  console.log(label);
  row('stutter frames', 'stutter', 1, '% ', r);
  row('path shape err', 'shape', 3, 't ', r);
  row('drawn delay', 'delay', 0, 'ms', r);
  row('raw error now', 'raw', 3, 't ', r);
}
