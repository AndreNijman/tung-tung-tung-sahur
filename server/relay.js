#!/usr/bin/env node
//
// Tung Tung Tung Sahorror -- multiplayer relay.
//
// Zero dependencies: node stdlib only, including the WebSocket implementation.
// The game itself has no build step and no packages, and a relay you can copy
// to a box and start with `node relay.js` keeps that property. It also means
// there is nothing to `npm install` on the Orange Pi / VPS / whatever ends up
// hosting it.
//
//   node server/relay.js                     # ws on :8787
//   node server/relay.js --port 9000
//   node server/relay.js --serve .           # also serve index.html from here
//
// With --serve the whole game runs from one process, which is what the
// multiplayer smoke test drives and the simplest thing to put behind a TLS
// terminator in production (see README).
//
// ---------------------------------------------------------------------------
// Authority model
// ---------------------------------------------------------------------------
// The relay is deliberately maze-blind. It never generates or parses a map.
// The host client generates the level from the server's seed and uploads a
// manifest of the *points that matter* -- offerings, alcoves, alcove pairing,
// the surau -- and from then on the relay owns every decision that two clients
// could disagree about:
//
//   - the night clock
//   - who is holding which offering, and when one is delivered
//   - who has been caught
//   - which alcove an alcove-swap comes out of
//   - how the match ends
//
// Clients own exactly one thing: their own position. That is the standard
// trade for a game with a chase in it -- server-authoritative movement would
// put a round trip between the key press and the step, which a horror chase
// cannot afford. Positions are speed-checked, not simulated.
//
// Consequence, documented rather than hidden: every client is sent every live
// position, so a modified client can see through walls. This is a game for a
// lobby of friends, not a ranked ladder. The one thing that IS withheld
// is which alcove a hidden player is inside -- see `snapshot()`.
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// constants shared with index.html
//
// These five have to agree with the client or the relay will resolve pickups
// and catches at distances that do not match what the player sees. They are
// intentionally the *only* game numbers on this side of the wire.
// ---------------------------------------------------------------------------
const CATCH_DIST = 0.52;      // index.html: CATCH_DIST_MP
const PICKUP_DIST = 0.62;     // index.html: PICKUP_DIST
const SURAU_DIST = 0.9;       // index.html: SURAU_DIST_MP
const HIDE_DIST = 0.85;       // index.html: HIDE_DIST (+ slack for latency)
const MAX_SPEED = 3.85;       // index.html: TUNG_SURGE_SPEED
const WALK_SPEED = 2.2;       // index.html: WALK_SPEED
const MOVE_BURST = 1.0;       // one small latency/reconciliation burst
const SWAP_COOLDOWN_MS = 12000;

const TICK_HZ = 20;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const ROOM_IDLE_MS = 45 * 60 * 1000;
const PING_MS = 25000;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const PASSWORD_ATTEMPT_MAX = 6;
const PASSWORD_ATTEMPT_WINDOW_MS = 60000;

// A room code you can read out loud over a call: no O/0, no I/1, no vowels
// that could accidentally spell something.
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
const PLAYER_COLORS = ['#e0a040', '#68c0d8', '#8ad06a', '#d878b8', '#c8c0a8', '#e07058', '#7890d8', '#b098e0', '#58b890', '#d0cc58'];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const DEFAULT_SETTINGS = {
  mapN: 21,        // odd, 15..33
  lanterns: 6,     // offerings to gather
  night: 300,      // seconds on the clock
  torch: 125,      // seconds of torch battery; 0 is infinite
  stamina: 'medium',
  tungIntel: false,
  tungs: 1,
  tracks: 'normal',// footprint visibility for the tung: off|faint|normal|strong
};

function clampSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return s;
  if (Number.isFinite(raw.mapN)) {
    let n = Math.round(raw.mapN);
    if (n % 2 === 0) n += 1;
    s.mapN = Math.max(15, Math.min(33, n));
  }
  if (Number.isFinite(raw.lanterns)) s.lanterns = Math.max(2, Math.min(12, Math.round(raw.lanterns)));
  if (Number.isFinite(raw.night)) s.night = Math.max(60, Math.min(900, Math.round(raw.night)));
  if (Number.isFinite(raw.torch)) s.torch = raw.torch === 0 ? 0 : Math.max(20, Math.min(1800, Math.round(raw.torch)));
  if (['veryLow', 'low', 'medium', 'high', 'veryHigh', 'infinite'].includes(raw.stamina)) s.stamina = raw.stamina;
  if (typeof raw.tungIntel === 'boolean') s.tungIntel = raw.tungIntel;
  if (Number.isFinite(raw.tungs)) s.tungs = Math.max(1, Math.min(3, Math.round(raw.tungs)));
  if (['off', 'faint', 'normal', 'strong'].includes(raw.tracks)) s.tracks = raw.tracks;
  return s;
}

function normalizePassword(value) {
  return String(value || '').slice(0, 64);
}

function hashPassword(value) {
  const password = normalizePassword(value);
  if (!password) return null;
  return crypto.createHash('sha256').update(password, 'utf8').digest();
}

function passwordMatches(expected, value) {
  if (!expected) return true;
  const actual = hashPassword(value);
  return !!actual && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// minimal RFC6455 server
// ---------------------------------------------------------------------------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;       // { opcode, chunks }
    this.open = true;
    this.alive = true;
    this.onmessage = null;
    this.onclose = null;

    socket.on('data', (d) => this.feed(d));
    socket.on('end', () => this.destroy());
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // Frames arrive coalesced or split arbitrarily across TCP reads, so parse
    // in a loop and stop the moment the buffer holds less than a full frame.
    for (;;) {
      const frame = this.readFrame();
      if (!frame) break;
      this.handleFrame(frame);
      if (!this.open) break;
    }
  }

  readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    if (b[0] & 0x70) { this.close(1002); return null; }
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off); off += 8;
      if (big > BigInt(MAX_MESSAGE_BYTES)) { this.close(1009); return null; }
      len = Number(big);
    }
    let mask = null;
    // RFC6455 requires every client-to-server frame to be masked.
    if (!masked) { this.close(1002); return null; }
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  handleFrame(f) {
    if (f.opcode === 0x8) { this.close(1000); return; }
    if (f.opcode === 0x9) { this.sendRaw(0xa, f.payload); return; }
    if (f.opcode === 0xa) { this.alive = true; return; }

    if (f.opcode === 0x0) {
      if (!this.frag) { this.close(1002); return; }
      this.frag.chunks.push(f.payload);
      this.frag.size += f.payload.length;
      if (this.frag.size > MAX_MESSAGE_BYTES) { this.close(1009); return; }
    } else if (f.opcode === 0x1 || f.opcode === 0x2) {
      if (this.frag) { this.close(1002); return; }
      if (!f.fin) { this.frag = { opcode: f.opcode, chunks: [f.payload], size: f.payload.length }; return; }
      this.deliver(f.payload);
      return;
    } else return;

    if (f.fin && this.frag) {
      const full = Buffer.concat(this.frag.chunks);
      this.frag = null;
      this.deliver(full);
    }
  }

  deliver(payload) {
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); }
    catch { return; }
    if (msg && typeof msg === 'object' && this.onmessage) this.onmessage(msg);
  }

  sendRaw(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try { this.socket.write(Buffer.concat([header, payload])); }
    catch { this.destroy(); }
  }

  send(obj) { this.sendRaw(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); }
  ping() { this.sendRaw(0x9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (!this.open) return;
    const b = Buffer.alloc(2); b.writeUInt16BE(code, 0);
    this.sendRaw(0x8, b);
    this.destroy();
  }

  destroy() {
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch { /* already gone */ }
    if (this.onclose) this.onclose();
  }
}

function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  return new Conn(socket);
}

// ---------------------------------------------------------------------------
// rooms
// ---------------------------------------------------------------------------
const rooms = new Map();
const passwordAttempts = new Map();
let nextPlayerId = 1;

function passwordAttemptKey(session, code) {
  return `${session.ip || 'unknown'}|${code}`;
}

function recentPasswordAttempts(key) {
  const now = Date.now();
  const recent = (passwordAttempts.get(key) || []).filter(at => now - at < PASSWORD_ATTEMPT_WINDOW_MS);
  if (recent.length) passwordAttempts.set(key, recent);
  else passwordAttempts.delete(key);
  return recent;
}

function makeCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return 'R' + Date.now().toString(36).slice(-3).toUpperCase();
}

function sanitizeName(n) {
  const s = String(n || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 14);
  return s || 'guest';
}
function sanitizeChat(value) {
  return String(value || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 160);
}
function sanitizeCosmetics(message) {
  const clean = value => String(value || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  const look = {};
  if (message.look && typeof message.look === 'object') {
    for (const [slot, value] of Object.entries(message.look).slice(0, 16)) look[clean(slot)] = clean(value);
  }
  return { sigil: clean(message.sigil), look };
}

class Player {
  constructor(conn, name, cosmetics = {}) {
    this.id = nextPlayerId++;
    this.conn = conn;
    this.name = sanitizeName(name);
    this.sigil = cosmetics.sigil || '';
    this.look = cosmetics.look || {};
    this.vote = null;          // player id, 'random', or null
    this.role = 'survivor';
    this.x = 1.5; this.y = 1.5; this.a = 0;
    this.flags = 0;
    this.hidden = false;
    this.alive = true;
    this.carrying = -1;        // item index, -1 for empty handed
    this.delivered = 0;
    this.caught = 0;
    this.caughtAt = null;
    this.lastInput = 0;
    this.lastMoveAt = 0;
    this.moveTokens = MOVE_BURST;
    this.motionSpeed = 0;
    this.swapCooldownUntil = 0;
    this.colorIdx = 0;
    this.spawnIdx = 0;
    this.chatTimes = [];
  }
  publicLobby() {
    return { id: this.id, name: this.name, sigil: this.sigil, look: this.look, vote: this.vote, color: PLAYER_COLORS[this.colorIdx] };
  }
}

const FLAG_MOVING = 1, FLAG_SPRINT = 2, FLAG_HIDDEN = 4, FLAG_SURGE = 32;

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.hostId = null;
    this.phase = 'lobby';       // lobby | play | over
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.seed = 0;
    this.manifest = null;
    this.items = [];
    this.timeLeft = 0;
    this.tick = 0;
    this.timer = null;
    this.lastTickAt = 0;
    this.touched = Date.now();
    this.result = null;
    this.manifestWaitSince = 0;
    this.manifestRequestedAt = 0;
    this.passwordHash = null;
  }

  broadcast(msg, exceptId) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.id === exceptId) continue;
      p.conn.sendRaw(0x1, Buffer.from(s, 'utf8'));
    }
  }

  add(player) {
    if (this.players.size >= MAX_PLAYERS) return false;
    const used = new Set([...this.players.values()].map(p => p.colorIdx));
    let idx = 0;
    while (used.has(idx) && idx < PLAYER_COLORS.length - 1) idx++;
    player.colorIdx = idx;
    this.players.set(player.id, player);
    if (this.hostId === null) this.hostId = player.id;
    this.touched = Date.now();
    return true;
  }

  remove(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    for (const other of this.players.values()) {
      if (other.vote === id) other.vote = null;
    }
    if (this.hostId === id) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    if (this.phase === 'play') {
      if (p.role === 'tung' && !this.tungs().length) {
        this.finish('abandoned', 'the tung left the street');
      } else {
        // A survivor rage-quitting must not strand the Tung in an empty room.
        if (p.carrying >= 0) this.dropItem(p);
        if (!this.survivors().length) {
          this.finish('abandoned', 'the survivors left the street');
        } else {
          this.checkEnd();
        }
      }
    }
    if (this.players.size === 0) {
      this.stopTick();
      rooms.delete(this.code);
    } else if (this.phase === 'lobby') {
      this.sendLobby();
    } else {
      this.broadcast({ t: 'roster', players: [...this.players.values()].map(q => q.publicLobby()), host: this.hostId });
    }
  }

  sendLobby() {
    this.broadcast({
      t: 'lobby',
      code: this.code,
      host: this.hostId,
      phase: this.phase,
      settings: this.settings,
      max: MAX_PLAYERS,
      min: MIN_PLAYERS,
      players: [...this.players.values()].map(p => p.publicLobby()),
    });
  }

  lobbySummary() {
    const host = this.players.get(this.hostId);
    return {
      code: this.code,
      players: this.players.size,
      max: MAX_PLAYERS,
      locked: !!this.passwordHash,
      host: host ? host.name : 'guest',
      settings: this.settings,
    };
  }

  // -------------------------------------------------------------------------
  // the vote
  //
  // A vote for a specific player wins if it is the strict plurality. Anything
  // else -- nobody voted, a tie, or "random" being the most popular answer --
  // falls through to a draw, because those are all the same statement: the
  // lobby did not pick.
  // -------------------------------------------------------------------------
  pickTung() {
    const ids = [...this.players.keys()];
    const counts = new Map();
    let randomVotes = 0;
    for (const p of this.players.values()) {
      if (p.vote === 'random') randomVotes++;
      else if (p.vote !== null && this.players.has(p.vote)) {
        counts.set(p.vote, (counts.get(p.vote) || 0) + 1);
      }
    }
    let best = 0, winners = [];
    for (const [id, n] of counts) {
      if (n > best) { best = n; winners = [id]; }
      else if (n === best) winners.push(id);
    }
    if (best === 0 || randomVotes >= best || winners.length !== 1) {
      return { id: ids[crypto.randomInt(ids.length)], how: 'random' };
    }
    return { id: winners[0], how: 'vote' };
  }

  start() {
    if (this.phase === 'play') return;
    if (this.players.size < MIN_PLAYERS) {
      this.toHost({ t: 'err', m: `need at least ${MIN_PLAYERS} players` });
      return;
    }
    const { id: firstTungId, how } = this.pickTung();
    const tungIds = [firstTungId];
    const candidates = [...this.players.keys()].filter(id => id !== firstTungId);
    const wanted = Math.min(this.settings.tungs, this.players.size - 1);
    while (tungIds.length < wanted && candidates.length) {
      tungIds.push(candidates.splice(crypto.randomInt(candidates.length), 1)[0]);
    }
    this.seed = crypto.randomInt(0x7fffffff);
    this.phase = 'play';
    this.manifest = null;
    this.items = [];
    this.timeLeft = this.settings.night;
    this.tick = 0;
    this.result = null;
    this.manifestWaitSince = Date.now();
    this.manifestRequestedAt = 0;

    const order = [...this.players.values()];
    order.forEach((p, i) => {
      p.role = tungIds.includes(p.id) ? 'tung' : 'survivor';
      p.alive = true;
      p.hidden = false;
      p.carrying = -1;
      p.delivered = 0;
      p.caught = 0;
      p.caughtAt = null;
      p.flags = 0;
      p.spawnIdx = i;
      p.lastInput = 0;
      p.lastMoveAt = 0;
      p.moveTokens = MOVE_BURST;
      p.motionSpeed = 0;
      p.swapCooldownUntil = 0;
    });

    this.broadcast({
      t: 'begin',
      seed: this.seed,
      settings: this.settings,
      tung: firstTungId,
      tungs: tungIds,
      how,
      players: order.map(p => ({
        id: p.id, name: p.name, sigil: p.sigil, look: p.look, role: p.role,
        color: PLAYER_COLORS[p.colorIdx], spawnIdx: p.spawnIdx,
      })),
    });

    this.lastTickAt = Date.now();
    this.startTick();
  }

  // The host derives the level from the seed and tells the relay where the
  // things it must adjudicate ended up. Until this lands the clock does not
  // move -- see tickOnce.
  setManifest(m) {
    if (this.manifest) return;
    const reject = () => { this.toHost({ t: 'err', m: 'level manifest rejected; retrying' }); return false; };
    const pt = (v) => Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);
    if (!m || !Array.isArray(m.items) || !Array.isArray(m.hides) || !pt(m.surau)) return reject();
    if (!m.items.every(pt) || !m.hides.every(pt)) return reject();
    if (m.items.length !== this.settings.lanterns || m.items.length > 12) return reject();
    if (m.hides.length < 2 || m.hides.length > 24 || m.hides.length % 2) return reject();
    const pairs = Array.isArray(m.pairs) ? m.pairs : [];
    const cleanPairs = pairs.filter(p => Array.isArray(p) && p.length === 2 &&
      Number.isInteger(p[0]) && Number.isInteger(p[1]) && p[0] !== p[1] &&
      p[0] >= 0 && p[1] >= 0 && p[0] < m.hides.length && p[1] < m.hides.length);
    const paired = new Set(cleanPairs.flat());
    if (cleanPairs.length * 2 !== m.hides.length || paired.size !== m.hides.length) return reject();
    const spawns = Array.isArray(m.spawns) ? m.spawns : [];
    const spawnById = new Map(spawns.filter(s => s && Number.isInteger(s.id)).map(s => [s.id, s]));
    if ([...this.players.keys()].some(id => !spawnById.has(id))) return reject();
    for (const s of spawns) {
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) ||
          s.x < 0 || s.y < 0 || s.x >= this.settings.mapN || s.y >= this.settings.mapN) return reject();
    }
    this.manifest = {
      items: m.items.map(p => [p[0], p[1]]),
      hides: m.hides.map(p => [p[0], p[1]]),
      pairs: cleanPairs,
      surau: [m.surau[0], m.surau[1]],
    };
    for (const s of spawns) {
      const p = this.players.get(s.id);
      if (!p) continue; // disconnected between begin and manifest
      p.x = s.x; p.y = s.y; p.a = Number.isFinite(s.a) ? s.a : 0;
      p.lastMoveAt = Date.now();
      p.moveTokens = MOVE_BURST;
    }
    this.items = this.manifest.items.map(p => ({
      x: p[0], y: p[1], home: [p[0], p[1]], state: 0, carrier: -1,
    }));
    this.broadcast({ t: 'manifest', m: this.manifest });
    this.lastTickAt = Date.now();
    return true;
  }

  toHost(msg) {
    const h = this.players.get(this.hostId);
    if (h) h.conn.send(msg);
  }

  startTick() {
    this.stopTick();
    this.timer = setInterval(() => this.tickOnce(), 1000 / TICK_HZ);
  }
  stopTick() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  tickOnce() {
    const now = Date.now();
    const dt = Math.min(0.5, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;
    if (this.phase !== 'play') return;
    // No manifest yet means the host is still building the level; freeze the
    // clock rather than burning night on a loading screen.
    if (!this.manifest) {
      const waited = now - this.manifestWaitSince;
      if (waited >= 30000) {
        this.finish('abandoned', 'the street failed to form');
      } else if (waited >= 5000 && now - this.manifestRequestedAt >= 5000) {
        this.manifestRequestedAt = now;
        this.toHost({ t: 'need-manifest' });
      }
      return;
    }

    this.tick++;
    this.timeLeft -= dt;

    this.resolvePickups();
    this.resolveDeliveries();
    this.resolveCatches();
    this.broadcastSnapshot();

    this.checkEnd();
    if (this.phase === 'play' && this.timeLeft <= 0) {
      this.finish('dawn', 'the call to Subuh went up without them');
    }
  }

  survivors() {
    return [...this.players.values()].filter(p => p.role === 'survivor');
  }
  tungs() {
    return [...this.players.values()].filter(p => p.role === 'tung');
  }

  resolvePickups() {
    for (const p of this.survivors()) {
      if (!p.alive || p.hidden || p.carrying >= 0) continue;
      for (let i = 0; i < this.items.length; i++) {
        const it = this.items[i];
        if (it.state !== 0) continue;
        if ((p.x - it.x) ** 2 + (p.y - it.y) ** 2 > PICKUP_DIST ** 2) continue;
        it.state = 1; it.carrier = p.id;
        p.carrying = i;
        this.broadcast({ t: 'ev', e: 'pickup', by: p.id, i });
        break;
      }
    }
  }

  resolveDeliveries() {
    const s = this.manifest.surau;
    for (const p of this.survivors()) {
      if (!p.alive || p.hidden || p.carrying < 0) continue;
      if ((p.x - s[0]) ** 2 + (p.y - s[1]) ** 2 > SURAU_DIST ** 2) continue;
      const it = this.items[p.carrying];
      it.state = 2; it.carrier = -1;
      it.x = s[0]; it.y = s[1];
      this.broadcast({ t: 'ev', e: 'deliver', by: p.id, i: p.carrying });
      p.carrying = -1;
      p.delivered++;
    }
  }

  // Catches are resolved here rather than claimed by the tung's client, so the
  // catch cannot be faked and does not need a round trip to be believed.
  resolveCatches() {
    if (!this.manifest) return;
    for (const t of this.tungs()) {
      if (!t.alive) continue;
      for (const p of this.survivors()) {
        if (!p.alive) continue;
        if ((p.x - t.x) ** 2 + (p.y - t.y) ** 2 > CATCH_DIST ** 2) continue;
        p.alive = false;
        t.caught++;
        p.caughtAt = [p.x, p.y];
        if (p.carrying >= 0) this.dropItem(p);
        this.broadcast({ t: 'ev', e: 'caught', who: p.id, by: t.id, x: p.x, y: p.y });
      }
    }
  }

  dropItem(p) {
    if (p.carrying < 0) return;
    const it = this.items[p.carrying];
    it.state = 0; it.carrier = -1;
    it.x = p.x; it.y = p.y;
    this.broadcast({ t: 'ev', e: 'drop', i: p.carrying, x: it.x, y: it.y });
    p.carrying = -1;
  }

  // The snapshot deliberately omits x/y/a for a hidden player. Which alcove
  // someone is inside is the one piece of state a modified tung client must
  // not be able to read -- it is the whole point of the paired alcoves.
  snapshot(viewer) {
    const ps = [];
    for (const p of this.players.values()) {
      const concealed = p.hidden || !p.alive ||
        (viewer && viewer.role === 'survivor' && !viewer.alive && p.id !== viewer.id);
      const carrying = !viewer || p.id === viewer.id || !p.hidden ? p.carrying : -1;
      const row = [p.id, p.flags | (p.hidden ? FLAG_HIDDEN : 0), p.alive ? 1 : 0, carrying];
      if (concealed) ps.push(row);
      else ps.push(row.concat([round2(p.x), round2(p.y), round3(p.a)]));
    }
    return {
      t: 'snap',
      k: this.tick,
      tl: Math.max(0, round2(this.timeLeft)),
      p: ps,
      it: this.items.map(it => viewer?.role === 'tung' && !this.settings.tungIntel
        ? [it.state, -1, 0, 0] : [it.state, it.carrier, round2(it.x), round2(it.y)]),
    };
  }

  broadcastSnapshot() {
    for (const p of this.players.values()) p.conn.send(this.snapshot(p));
  }

  checkEnd() {
    if (this.phase !== 'play' || !this.manifest) return;
    const alive = this.survivors().filter(p => p.alive);
    if (this.items.length && this.items.every(it => it.state === 2)) {
      this.finish('escaped', 'every offering reached the surau');
      return;
    }
    if (this.survivors().length && alive.length === 0) {
      this.finish('hunted', 'the street is empty of the living');
    }
  }

  finish(result, blurb) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.result = result;
    this.stopTick();
    const delivered = this.items.filter(it => it.state === 2).length;
    this.broadcast({
      t: 'over',
      result,
      blurb,
      delivered,
      total: this.items.length,
      timeLeft: Math.max(0, round2(this.timeLeft)),
      scores: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, sigil: p.sigil, look: p.look, role: p.role, alive: p.alive,
        delivered: p.delivered, caught: p.caught, color: PLAYER_COLORS[p.colorIdx],
      })),
    });
  }

  backToLobby() {
    this.phase = 'lobby';
    this.stopTick();
    this.manifest = null;
    this.items = [];
    for (const p of this.players.values()) {
      p.role = 'survivor'; p.alive = true; p.hidden = false;
      p.carrying = -1; p.vote = null;
    }
    this.sendLobby();
  }
}

function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }

// ---------------------------------------------------------------------------
// message handling
// ---------------------------------------------------------------------------
function handle(session, msg) {
  const t = msg.t;
  if (t === 'ping') { session.conn.send({ t: 'pong', c: msg.c }); return; }

  if (t === 'create' || t === 'join') {
    if (t === 'join') {
      const now = Date.now();
      session.joinAttempts = (session.joinAttempts || []).filter(at => now - at < 10000);
      if (session.joinAttempts.length >= 8) {
        session.conn.send({ t: 'err', m: 'too many join attempts; wait a moment', fatal: true });
        return;
      }
      session.joinAttempts.push(now);
    }
    if (session.room) leaveRoom(session);
    const player = new Player(session.conn, msg.name, sanitizeCosmetics(msg));
    let room;
    if (t === 'create') {
      room = new Room(makeCode());
      room.settings = clampSettings(msg.settings);
      room.passwordHash = hashPassword(msg.password);
      rooms.set(room.code, room);
    } else {
      const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      room = rooms.get(code);
      if (!room) { session.conn.send({ t: 'err', m: 'no lobby with that code', fatal: true }); return; }
      if (room.phase !== 'lobby') { session.conn.send({ t: 'err', m: 'that night has already started', fatal: true }); return; }
      if (room.players.size >= MAX_PLAYERS) { session.conn.send({ t: 'err', m: `lobby is full (${MAX_PLAYERS})`, fatal: true }); return; }
      if (room.passwordHash) {
        const attemptKey = passwordAttemptKey(session, code);
        const attempts = recentPasswordAttempts(attemptKey);
        if (attempts.length >= PASSWORD_ATTEMPT_MAX) {
          session.conn.send({ t: 'err', m: 'too many password attempts; wait a minute', fatal: true });
          return;
        }
        if (!passwordMatches(room.passwordHash, msg.password)) {
          attempts.push(Date.now()); passwordAttempts.set(attemptKey, attempts);
          session.conn.send({ t: 'err', m: 'wrong lobby password', fatal: true });
          return;
        }
        passwordAttempts.delete(attemptKey);
      }
    }
    room.add(player);
    session.conn.socket.setTimeout(0);
    session.room = room;
    session.player = player;
    session.conn.send({ t: 'welcome', you: player.id, code: room.code, color: PLAYER_COLORS[player.colorIdx] });
    room.sendLobby();
    return;
  }

  const room = session.room, me = session.player;
  if (!room || !me) return;
  room.touched = Date.now();

  switch (t) {
    case 'name':
      if (room.phase !== 'lobby') break;
      me.name = sanitizeName(msg.name);
      room.sendLobby();
      break;

    case 'settings':
      if (me.id !== room.hostId || room.phase !== 'lobby') break;
      room.settings = clampSettings(msg.settings);
      room.sendLobby();
      break;

    case 'vote': {
      if (room.phase !== 'lobby') break;
      const v = msg.v;
      const id = Number(v);
      me.vote = (v === 'random') ? 'random' : (room.players.has(id) ? id : null);
      room.sendLobby();
      break;
    }

    case 'start':
      if (me.id !== room.hostId || room.phase !== 'lobby') break;
      room.start();
      break;

    case 'manifest':
      if (me.id !== room.hostId || room.phase !== 'play') break;
      room.setManifest(msg.m);
      break;

    case 'in': {
      if (room.phase !== 'play' || !me.alive) break;
      const now = Date.now();
      let moved = 0, moveDt = 0, acceptedMove = false;
      if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
        const inBounds = msg.x >= 0 && msg.y >= 0 &&
          msg.x < room.settings.mapN && msg.y < room.settings.mapN;
        moveDt = Math.max(0, (now - (me.lastMoveAt || now)) / 1000);
        me.moveTokens = Math.min(MOVE_BURST, me.moveTokens + MAX_SPEED * Math.min(moveDt, 1.0));
        me.lastMoveAt = now;
        moved = Math.hypot(msg.x - me.x, msg.y - me.y);
        if (inBounds && moved <= me.moveTokens + 1e-6) {
          me.x = msg.x; me.y = msg.y;
          me.moveTokens = Math.max(0, me.moveTokens - moved);
          acceptedMove = true;
        }
        // Over budget: keep the previous position. Tokens replenish by elapsed
        // wall time, not by packet count, so flooding tiny steps gains nothing.
      }
      if (Number.isFinite(msg.a)) me.a = msg.a;
      const speed = acceptedMove && moveDt > 0 ? moved / moveDt : 0;
      const alpha = 1 - Math.exp(-Math.min(moveDt, 0.5) / 0.20);
      me.motionSpeed += (speed - me.motionSpeed) * alpha;
      const wasSprinting = !!(me.flags & FLAG_SPRINT);
      const sprinting = wasSprinting ? me.motionSpeed > WALK_SPEED + 0.25 : me.motionSpeed > WALK_SPEED + 0.65;
      me.flags = (me.motionSpeed > 0.15 ? FLAG_MOVING : 0) |
        (sprinting ? FLAG_SPRINT : 0) |
        (me.role === 'tung' && (msg.f & FLAG_SURGE) ? FLAG_SURGE : 0);
      // A hidden flag is only honoured next to an actual alcove. Everything
      // else about the position is trusted; this one is not, because "hidden"
      // means the relay stops telling anyone where you are.
      let hidden = !!(msg.f & FLAG_HIDDEN) && me.role === 'survivor';
      if (hidden && room.manifest) {
        hidden = room.manifest.hides.some(h =>
          (h[0] - me.x) ** 2 + (h[1] - me.y) ** 2 < HIDE_DIST ** 2);
      }
      me.hidden = hidden;
      me.lastInput = now;
      break;
    }

    case 'swap': {
      if (room.phase !== 'play' || !me.alive || !me.hidden || !room.manifest) {
        me.conn.send({ t: 'ev', e: 'swap-no', wait: 0.5 });
        break;
      }
      const now = Date.now();
      if (now < me.swapCooldownUntil) {
        me.conn.send({ t: 'ev', e: 'swap-no', wait: Math.ceil((me.swapCooldownUntil - now) / 1000) });
        break;
      }
      const hides = room.manifest.hides;
      let from = -1, bd = HIDE_DIST ** 2;
      for (let i = 0; i < hides.length; i++) {
        const d = (hides[i][0] - me.x) ** 2 + (hides[i][1] - me.y) ** 2;
        if (d < bd) { bd = d; from = i; }
      }
      if (from < 0) { me.conn.send({ t: 'ev', e: 'swap-no', wait: 0.5 }); break; }
      let to = -1;
      for (const [a, b] of room.manifest.pairs) {
        if (a === from) { to = b; break; }
        if (b === from) { to = a; break; }
      }
      if (to < 0 || !hides[to]) { me.conn.send({ t: 'ev', e: 'swap-no', wait: 0.5 }); break; }
      me.x = hides[to][0]; me.y = hides[to][1];
      me.moveTokens = 0;
      me.lastMoveAt = now;
      me.swapCooldownUntil = now + SWAP_COOLDOWN_MS;
      // Only the mover is told. Broadcasting a swap would hand the tung the
      // very information the paired alcoves exist to deny it.
      me.conn.send({ t: 'ev', e: 'swap', from, to, x: me.x, y: me.y });
      break;
    }

    case 'chat': {
      if (room.phase !== 'play' || !me.alive) break;
      const now = Date.now();
      me.chatTimes = me.chatTimes.filter(at => now - at < 5000);
      if (me.chatTimes.length >= 5) break;
      me.chatTimes.push(now);
      const message = sanitizeChat(msg.m);
      if (message) room.broadcast({ t: 'chat', from: me.id, name: me.name, sigil: me.sigil, m: message });
      break;
    }

    case 'again':
      if (me.id !== room.hostId || room.phase !== 'over') break;
      room.backToLobby();
      break;

    case 'leave':
      leaveRoom(session);
      break;
  }
}

function leaveRoom(session) {
  if (!session.room) return;
  const room = session.room;
  session.room = null;
  const p = session.player;
  session.player = null;
  if (p) room.remove(p.id);
}

// ---------------------------------------------------------------------------
// http + static
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function main() {
  const argv = process.argv.slice(2);
  let port = Number(process.env.PORT) || 8787;
  let serveDir = null;
  let host = process.env.HOST || '0.0.0.0';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[++i]);
    else if (argv[i] === '--serve') serveDir = path.resolve(argv[++i] || '.');
    else if (argv[i] === '--host') host = argv[++i];
    else if (argv[i] === '--help') {
      console.log('usage: node relay.js [--port N] [--host H] [--serve DIR]');
      process.exit(0);
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/lobbies') {
      const available = [...rooms.values()]
        .filter(room => room.phase === 'lobby' && room.players.size > 0 && room.players.size < MAX_PLAYERS)
        .sort((a, b) => b.touched - a.touched)
        .map(room => room.lobbySummary());
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({ lobbies: available }));
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
      return;
    }
    if (!serveDir) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('tung relay. connect over websocket.\n');
      return;
    }
    let p;
    try { p = decodeURIComponent(url.pathname); }
    catch { res.writeHead(400); res.end('bad path'); return; }
    if (p === '/') p = '/index.html';
    if (p.split('/').some(part => part.startsWith('.'))) { res.writeHead(404); res.end('not found'); return; }
    // The production game is one HTML file. Do not turn --serve into an
    // accidental source-code server for server/, tools/ or node_modules/.
    if (p !== '/index.html' && p !== '/CNAME') { res.writeHead(404); res.end('not found'); return; }
    const file = path.join(serveDir, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(serveDir)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(req.headers.origin || '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const conn = acceptUpgrade(req, socket);
    if (!conn) return;
    // A connection that never creates or joins a room is outside the room ping
    // loop. Do not let it hold a megabyte parse buffer forever.
    socket.setTimeout(15000, () => conn.destroy());
    const forwarded = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const session = { conn, room: null, player: null, joinAttempts: [], ip: forwarded || socket.remoteAddress };
    conn.onmessage = (msg) => {
      try { handle(session, msg); }
      catch (e) { console.error('handler:', e && e.stack || e); }
    };
    conn.onclose = () => leaveRoom(session);
    if (head && head.length) conn.feed(head);
  });

  setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      if (now - room.touched > ROOM_IDLE_MS) {
        for (const p of room.players.values()) p.conn.close(1000);
        room.stopTick();
        rooms.delete(room.code);
        continue;
      }
      for (const p of room.players.values()) {
        if (!p.conn.alive) { p.conn.destroy(); continue; }
        p.conn.alive = false;
        p.conn.ping();
      }
    }
  }, PING_MS);

  server.listen(port, host, () => {
    console.log(`tung relay listening on ${host}:${port}` + (serveDir ? `  (serving ${serveDir})` : ''));
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    for (const room of rooms.values()) {
      room.stopTick();
      for (const p of room.players.values()) p.conn.close(1001);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();
module.exports = { Room, clampSettings, DEFAULT_SETTINGS };
