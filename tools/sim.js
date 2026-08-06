#!/usr/bin/env node
//
// Headless balance harness for Tung Tung Tung Sahorror.
//
// index.html is split by the ">>> SIM CUT <<<" marker: everything above it is
// pure simulation, everything below is browser-only. This loads the top half
// into a vm with stubbed globals and a seeded Math.random, then drives it with
// a bot.
//
// Two bot dials, because they answer different questions:
//
//   knowledge  omniscient : knows every offering location. Gives the optimal
//                           route time -- a floor on how fast the game can be
//                           finished, useful for "is the clock even possible".
//              blind      : only knows offerings it has had line of sight to,
//                           and explores otherwise. Realistic play; this is the
//                           number to tune the night length against.
//
//   threat     greedy     : keeps walking to its goal even while hunted.
//              flee       : runs directly away from the creature while hunted.
//                           This is the one that answers "can you outrun him".
//
// Usage:
//   node tools/sim.js --runs 200
//   node tools/sim.js --knowledge blind --threat flee
//   node tools/sim.js --set CREATURE_HUNT_BASE=2.4
//   node tools/sim.js --verbose
//
// --set patches a top-level const in the extracted source before it is
// evaluated, so constants can be swept without editing the game.
//
// To ask whether a hunt can resolve at all, disable the clock and shorten the
// cap -- any run that reaches the cap is a chase the creature could neither
// finish nor be shaken off:
//
//   node tools/sim.js --threat flee --cap 300 --set NIGHT_SECONDS=100000

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAME_FILE = path.join(__dirname, '..', 'index.html');
const CUT = '>>> SIM CUT <<<';
const DT = 1 / 60;
// Backstop so a stuck bot cannot hang a sweep. Also the instrument for "does a
// hunt ever resolve": a run that reaches the cap with the clock disabled is one
// the creature could neither finish nor be shaken off. Override with --cap.
const DEFAULT_CAP_SECONDS = 900;

// ---------------------------------------------------------------------------
// seeded rng
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// load the simulation half of index.html
// ---------------------------------------------------------------------------
function extractSource() {
  const html = fs.readFileSync(GAME_FILE, 'utf8');
  const open = html.indexOf('<script>');
  if (open < 0) throw new Error('no <script> block in index.html');
  const body = html.slice(open + '<script>'.length);
  const cut = body.indexOf(CUT);
  if (cut < 0) throw new Error(`marker "${CUT}" not found in index.html`);
  return body.slice(0, cut);
}

function applyOverrides(src, overrides) {
  for (const [name, value] of Object.entries(overrides)) {
    const re = new RegExp(`^(const\\s+${name}\\s*=\\s*)[^;,]+`, 'm');
    if (!re.test(src)) throw new Error(`--set ${name}: no top-level const by that name`);
    src = src.replace(re, `$1${value}`);
  }
  return src;
}

function makeContext(src) {
  const fakeCtx = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : () => fakeCtx),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const sandbox = {
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx }) },
    window: {},
    performance: { now: () => 0 },
    Math: Object.create(Math),
    console,
  };
  vm.createContext(sandbox);
  // `class`/`const` at script top level are lexical, not properties of the
  // global object, so hand them out explicitly. `peek` resolves any top-level
  // binding by name for constants the harness wants to read back.
  const exporter = '\n;globalThis.__sim = { Game, peek: (name) => eval(name) };\n';
  vm.runInContext(src + exporter, sandbox, { filename: 'index.html' });
  if (!sandbox.__sim || typeof sandbox.__sim.Game !== 'function') {
    throw new Error('extracted source did not expose Game');
  }
  return { sandbox, sim: sandbox.__sim };
}

// ---------------------------------------------------------------------------
// navigation
// ---------------------------------------------------------------------------
// BFS distance from one cell to every reachable open cell.
function distFrom(grid, gx, gy) {
  const n = grid.length;
  const dist = new Int32Array(n * n).fill(-1);
  if (gx < 0 || gy < 0 || gx >= n || gy >= n || grid[gy][gx] !== 0) return dist;
  dist[gy * n + gx] = 0;
  const q = [[gx, gy]];
  let qi = 0;
  while (qi < q.length) {
    const [cx, cy] = q[qi++];
    const d = dist[cy * n + cx];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      if (grid[ny][nx] !== 0 || dist[ny * n + nx] >= 0) continue;
      dist[ny * n + nx] = d + 1;
      q.push([nx, ny]);
    }
  }
  return dist;
}

const NO_KEYS = { w: false, a: false, s: false, d: false, shift: false, left: false, right: false };

class Bot {
  constructor(game, opts) {
    this.g = game;
    this.n = game.grid.length;
    this.knowledge = opts.knowledge;
    this.threat = opts.threat;
    this.goalKey = null;
    this.goalDist = null;
    this.knownItems = new Set();   // "x,y" of offerings the player has laid eyes on
    this.seenCells = new Set();    // cells the player has had line of sight to
    this.stuckFrames = 0;
    this.lastCell = null;
    this.fleeKey = null;
    this.fleeDist = null;
  }

  key(x, y) { return x + ',' + y; }

  // Everything within torch reach and line of sight becomes known.
  observe() {
    const g = this.g;
    const reach = g.flashlight ? 9.0 : 4.0;
    const cx = Math.floor(g.px), cy = Math.floor(g.py);
    const r = Math.ceil(reach);
    for (let y = Math.max(0, cy - r); y <= Math.min(this.n - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(this.n - 1, cx + r); x++) {
        if (g.grid[y][x] !== 0) continue;
        const k = this.key(x, y);
        if (this.seenCells.has(k)) continue;
        if (g.hasLos(g.px, g.py, x + 0.5, y + 0.5, reach)) this.seenCells.add(k);
      }
    }
    for (const it of g.items) {
      const k = this.key(Math.floor(it[0]), Math.floor(it[1]));
      if (this.seenCells.has(k)) this.knownItems.add(k);
    }
  }

  // Where the bot wants to be standing.
  pickGoal() {
    const g = this.g;
    const cx = Math.floor(g.px), cy = Math.floor(g.py);

    if (g.items.length === 0) {
      const s = g.surau || [1.5, 1.5];
      return [Math.floor(s[0]), Math.floor(s[1])];
    }

    const here = distFrom(g.grid, cx, cy);
    const candidates = g.items
      .map(it => [Math.floor(it[0]), Math.floor(it[1])])
      .filter(c => this.knowledge === 'omniscient' || this.knownItems.has(this.key(c[0], c[1])));

    let best = null, bestD = Infinity;
    for (const c of candidates) {
      const d = here[c[1] * this.n + c[0]];
      if (d >= 0 && d < bestD) { bestD = d; best = c; }
    }
    if (best) return best;

    // Nothing known: head for the nearest cell we have never laid eyes on.
    for (let y = 0; y < this.n; y++) {
      for (let x = 0; x < this.n; x++) {
        if (g.grid[y][x] !== 0 || this.seenCells.has(this.key(x, y))) continue;
        const d = here[y * this.n + x];
        if (d >= 0 && d < bestD) { bestD = d; best = [x, y]; }
      }
    }
    return best || [cx, cy];
  }

  // One orthogonal step that descends `field` from the current cell.
  descend(field, cell) {
    let bestD = field[cell[1] * this.n + cell[0]], bestCell = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cell[0] + dx, ny = cell[1] + dy;
      if (nx < 0 || ny < 0 || nx >= this.n || ny >= this.n) continue;
      const d = field[ny * this.n + nx];
      if (d >= 0 && d < bestD) { bestD = d; bestCell = [nx, ny]; }
    }
    return bestCell;
  }

  // One orthogonal step that increases distance from the creature.
  ascend(field, cell) {
    let bestD = field[cell[1] * this.n + cell[0]], bestCell = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cell[0] + dx, ny = cell[1] + dy;
      if (nx < 0 || ny < 0 || nx >= this.n || ny >= this.n) continue;
      const d = field[ny * this.n + nx];
      if (d > bestD) { bestD = d; bestCell = [nx, ny]; }
    }
    return bestCell;
  }

  aimAt(x, y) { this.g.angle = Math.atan2(y - this.g.py, x - this.g.px); }

  step() {
    const g = this.g;
    if (this.knowledge === 'blind') this.observe();

    const cell = [Math.floor(g.px), Math.floor(g.py)];

    // An alcove is the only place nerve comes back, so a competent player does
    // not leave the moment the coast is clear -- they leave when they have
    // their breath back, or when the clock forces them out.
    if (g.hidden) {
      const safe = g.cstate === 'wander' && g.alert < 0.2;
      const rested = g.composure > 0.5;
      const rushed = g.timeLeft !== undefined && g.timeLeft < 60;
      if (safe && (rested || rushed)) g.toggleHide();
      return NO_KEYS;
    }
    // in arm's reach of cover, and either hunted or too rattled to think
    const panicking = g.composure < 0.25;
    if ((g.cstate === 'hunt' || panicking) && g.nearHide) { g.toggleHide(); return NO_KEYS; }

    if (this.threat === 'flee' && g.cstate === 'hunt') {
      // Recomputed on a fixed interval rather than every frame: a player does
      // not re-plan 60 times a second, and a full BFS per frame dominates the
      // harness runtime.
      const ck = Math.floor(g.cx) + ',' + Math.floor(g.cy);
      if (ck !== this.fleeKey) { this.fleeKey = ck; this.fleeDist = distFrom(g.grid, Math.floor(g.cx), Math.floor(g.cy)); }
      const next = this.ascend(this.fleeDist, cell);
      if (next) {
        this.aimAt(next[0] + 0.5, next[1] + 0.5);
        this.bumpStuck(cell);
        return { ...NO_KEYS, w: true, shift: g.stamina > 0.08 };
      }
    }

    const goal = this.pickGoal();
    const k = this.key(goal[0], goal[1]);
    if (k !== this.goalKey) {
      this.goalKey = k;
      this.goalDist = distFrom(g.grid, goal[0], goal[1]);
    }
    const next = this.descend(this.goalDist, cell);
    if (next) this.aimAt(next[0] + 0.5, next[1] + 0.5);
    else this.aimAt(goal[0] + 0.5, goal[1] + 0.5);

    this.bumpStuck(cell);
    return { ...NO_KEYS, w: true, shift: g.cstate === 'hunt' && g.stamina > 0.08 };
  }

  bumpStuck(cell) {
    const k = this.key(cell[0], cell[1]);
    if (k === this.lastCell) this.stuckFrames++;
    else { this.stuckFrames = 0; this.lastCell = k; }
  }
}

// ---------------------------------------------------------------------------
// one run
// ---------------------------------------------------------------------------
function runOnce(env, seed, opts) {
  const cap = opts.cap;
  env.sandbox.Math.random = mulberry32(seed);

  const game = new env.sim.Game();
  game.state = 'play';
  const bot = new Bot(game, opts);

  let t = 0, minComposure = 1, panicFrames = 0, huntFrames = 0;
  let hitZero = false, recoveredFromZero = false;
  let hideCount = 0, wasHidden = false;
  let extractStart = null, extractSeconds = null;

  while (game.state === 'play' && t < cap) {
    const keys = bot.step();
    if (game.hidden && !wasHidden) hideCount++;
    wasHidden = game.hidden;

    game.update(DT, keys, 0);
    t += DT;

    if (extractStart === null && game.items.length === 0) extractStart = t;
    minComposure = Math.min(minComposure, game.composure);
    if (game.composure <= 0.001) { hitZero = true; panicFrames++; }
    else if (hitZero && game.composure > 0.35) recoveredFromZero = true;
    if (game.cstate === 'hunt') huntFrames++;

    if (bot.stuckFrames > 60 * 25) return { outcome: 'STUCK', t, collected: game.collected };
  }
  if (extractStart !== null && game.state === 'win') extractSeconds = t - extractStart;

  return {
    outcome: game.state === 'play' ? 'HARDCAP' : game.state,
    t,
    collected: game.collected,
    minComposure,
    panicSeconds: panicFrames * DT,
    huntSeconds: huntFrames * DT,
    extractSeconds,
    hitZero,
    recoveredFromZero,
    hideCount,
  };
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------
function pct(xs, p) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function f(x, d = 1) { return Number.isFinite(x) ? x.toFixed(d) : '--'; }

function report(results, runs, opts, overrides) {
  const by = {};
  for (const r of results) by[r.outcome] = (by[r.outcome] || 0) + 1;
  const wins = results.filter(r => r.outcome === 'win');
  const caught = results.filter(r => r.outcome === 'caught');
  const all = results.filter(r => r.outcome !== 'STUCK');
  const wt = wins.map(r => r.t);

  console.log(`bot: knowledge=${opts.knowledge} threat=${opts.threat} cap=${opts.cap}s   runs: ${runs}`);
  if (Object.keys(overrides).length) {
    console.log('overrides: ' + Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join(' '));
  }
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${String(v).padStart(4)}  ${f((v / runs) * 100)}%`);
  }
  console.log(`win time    mean ${f(mean(wt))}s  p50 ${f(pct(wt, 50))}s  p75 ${f(pct(wt, 75))}s  p90 ${f(pct(wt, 90))}s  p99 ${f(pct(wt, 99))}s`);
  const ext = wins.map(r => r.extractSeconds).filter(Number.isFinite);
  if (ext.length) console.log(`extract leg mean ${f(mean(ext))}s  p90 ${f(pct(ext, 90))}s`);
  console.log(`caught at   mean ${f(mean(caught.map(r => r.t)))}s with ${f(mean(caught.map(r => r.collected)), 2)}/6 offerings`);
  console.log(`hunt time   mean ${f(mean(all.map(r => r.huntSeconds)))}s per run`);
  console.log(`nerve       mean per-run minimum ${f(mean(all.map(r => r.minComposure)), 2)}`);
  const zeroed = all.filter(r => r.hitZero);
  console.log(`panic       ${zeroed.length}/${all.length} runs bottomed out; ${zeroed.filter(r => r.recoveredFromZero).length} of those climbed back over 0.35`);
  console.log(`hides       mean ${f(mean(all.map(r => r.hideCount)), 2)} per run`);
}

// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  let runs = 300, verbose = false;
  const opts = { knowledge: 'omniscient', threat: 'greedy', cap: DEFAULT_CAP_SECONDS };
  const overrides = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') runs = parseInt(argv[++i], 10);
    else if (a === '--verbose') verbose = true;
    else if (a === '--knowledge') opts.knowledge = argv[++i];
    else if (a === '--threat') opts.threat = argv[++i];
    else if (a === '--cap') opts.cap = parseFloat(argv[++i]);
    else if (a === '--set') { const [k, v] = argv[++i].split('='); overrides[k] = v; }
    else throw new Error(`unknown arg ${a}`);
  }
  if (!['omniscient', 'blind'].includes(opts.knowledge)) throw new Error('--knowledge omniscient|blind');
  if (!['greedy', 'flee'].includes(opts.threat)) throw new Error('--threat greedy|flee');

  let src = extractSource();
  if (Object.keys(overrides).length) src = applyOverrides(src, overrides);
  const env = makeContext(src);

  const results = [];
  for (let i = 0; i < runs; i++) {
    const seed = 1337 + i * 7919;
    const r = runOnce(env, seed, opts);
    results.push(r);
    if (verbose) console.log(`seed ${seed}  ${r.outcome.padEnd(10)} t=${f(r.t)}s items=${r.collected}`);
  }
  report(results, runs, opts, overrides);
}

main();
