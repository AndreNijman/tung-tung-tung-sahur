// netstats.js v2 (canonical copy: games-site shared/net/). v2 adds where each
// player connects from (seat's third argument; see netplace.js).
//
// Lag statistics for one online match, sent to the games-guard NetLog when the
// match ends so laggy games can be found later at
// games.andrenijman.com/_guard/admin/lag. Clients report their ping and frame
// rate about once a second; the relay adds what it sees itself (gaps between a
// player's messages, reconnects, its own tick loop falling behind).
// Shared, unchanged, by every game relay; see fart-together's src/server/netlog.ts.

/** Millisecond histogram in 10 ms buckets up to 5 s. */
class Hist {
  constructor() { this.n = new Uint32Array(501); this.count = 0; this.max = 0; }
  add(ms) {
    this.n[Math.min(500, Math.max(0, Math.round(ms / 10)))]++;
    this.count++;
    this.max = Math.max(this.max, ms);
  }
  /** Percentile in ms (bucket resolution), 0 when empty. */
  q(p) {
    if (!this.count) return 0;
    let k = Math.ceil(this.count * p);
    for (let i = 0; i < this.n.length; i++) if ((k -= this.n[i]) <= 0) return i * 10;
    return 5000;
  }
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const r1 = (x) => Math.round(x * 10) / 10;

export class NetStats {
  constructor() {
    this.seats = new Map();
    this.startedAt = Date.now();
    this.wallMs = 0;
    this.simMs = 0;
    this.tickGapMax = 0;
    this.stalls = 0;
    this.lostMs = 0;
    this.loops = 0;
  }

  /** `where` is netplace.js's `{ country, edge }` for this player, when the relay knows it. */
  seat(key, name, where) {
    let s = this.seats.get(key);
    if (!s) {
      s = { name: String(name || '?'), country: '', edge: '', rtt: new Hist(), gaps: new Hist(), fps: [], frameMax: 0, lastMsg: 0, reconnects: 0 };
      this.seats.set(key, s);
    } else if (name) s.name = String(name);
    if (where?.country) s.country = String(where.country);
    if (where?.edge) s.edge = String(where.edge);
    return s;
  }

  /** A client's ping report: its last measured round trip, frame rate and worst frame (ms). */
  ping(key, rtt, fps, frameMax) {
    const s = this.seats.get(key);
    if (!s) return;
    if (typeof rtt === 'number' && rtt >= 0 && rtt < 60000) s.rtt.add(rtt);
    if (typeof fps === 'number' && fps > 0 && fps < 1000) { s.fps.push(fps); if (s.fps.length > 3600) s.fps.shift(); }
    if (typeof frameMax === 'number' && frameMax > 0 && frameMax < 60000) s.frameMax = Math.max(s.frameMax, frameMax);
  }

  /** Any message from a player whose client sends at a steady rate (inputs); gaps are the network or a stalled tab. */
  message(key, now = Date.now()) {
    const s = this.seats.get(key);
    if (!s) return;
    if (s.lastMsg) s.gaps.add(now - s.lastMsg);
    s.lastMsg = now;
  }

  reconnect(key) {
    const s = this.seats.get(key);
    if (s) { s.reconnects++; s.lastMsg = 0; }
  }

  /** One pass of a server tick loop: wall ms since the last, simulated ms, ms dropped by a catch-up cap. */
  loop(gapMs, simMs, lostMs = 0) {
    this.loops++;
    this.wallMs += gapMs;
    this.simMs += simMs;
    this.tickGapMax = Math.max(this.tickGapMax, gapMs);
    if (gapMs > 100) this.stalls++;
    this.lostMs += lostMs;
  }

  /** The record for NetLog. `base` carries code, mode, outcome and colo, and region and moved when the room was placed or moved (netplace.js). */
  record(base = {}) {
    const seats = [...this.seats.values()].map((s) => ({
      name: s.name, country: s.country, edge: s.edge,
      rttMed: s.rtt.q(0.5), rttP95: s.rtt.q(0.95), rttMax: Math.round(s.rtt.max),
      gapP95: s.gaps.q(0.95), gapMax: Math.round(s.gaps.max),
      fpsMed: r1(median(s.fps)), fpsMin: r1(s.fps.length ? Math.min(...s.fps) : 0), frameMax: Math.round(s.frameMax),
      reconnects: s.reconnects,
    }));
    const server = this.loops ? {
      simSpeed: this.wallMs ? Math.round((this.simMs / this.wallMs) * 1000) / 1000 : 1,
      tickGapMax: Math.round(this.tickGapMax), stalls: this.stalls, lostMs: Math.round(this.lostMs),
    } : undefined;
    return { at: new Date().toISOString(), runTime: Math.round((Date.now() - this.startedAt) / 100) / 10, ...base, server, seats };
  }
}

/** Send a finished match to games-guard. Never throws; a relay without the binding (local dev) skips it. */
export function sendNetLog(env, ctx, game, record) {
  if (!env?.NETLOG || !record?.seats?.length) return;
  const p = Promise.resolve()
    .then(() => env.NETLOG.record(game, record))
    .catch((error) => console.error('netlog failed', error));
  ctx?.waitUntil?.(p);
  return p;
}

/** Where this Durable Object runs (Cloudflare colo), looked up once per object. */
export async function coloOf() {
  try {
    const r = await fetch('https://cloudflare.com/cdn-cgi/trace');
    return /colo=([A-Z]{3})/.exec(await r.text())?.[1] || '';
  } catch { return ''; }
}
