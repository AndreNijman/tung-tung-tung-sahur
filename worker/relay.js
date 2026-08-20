const CATCH_DIST = 0.52;
const PICKUP_DIST = 0.62;
const SURAU_DIST = 0.9;
const HIDE_DIST = 0.85;
const MAX_SPEED = 3.85;
const WALK_SPEED = 2.2;
const MOVE_BURST = 1.0;
const SWAP_COOLDOWN_MS = 12000;

const TICK_HZ = 20;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const ROOM_IDLE_MS = 45 * 60 * 1000;
const MAINTENANCE_MS = 25000;
const HANDSHAKE_MS = 15000;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const PASSWORD_ATTEMPT_MAX = 6;
const PASSWORD_ATTEMPT_WINDOW_MS = 60000;
const RESERVATION_MS = 15000;
const REGISTRY_STALE_MS = 60 * 60 * 1000;

const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
const PLAYER_COLORS = ['#e0a040', '#68c0d8', '#8ad06a', '#d878b8', '#c8c0a8', '#e07058', '#7890d8', '#b098e0', '#58b890', '#d0cc58'];
const PRODUCTION_ORIGIN = 'https://tung.andrenijman.com';

const DEFAULT_SETTINGS = {
  mapN: 21,
  lanterns: 6,
  night: 300,
  torch: 125,
  stamina: 'medium',
  tungIntel: false,
  tungs: 1,
  tracks: 'normal',
};

const FLAG_MOVING = 1;
const FLAG_SPRINT = 2;
const FLAG_HIDDEN = 4;
const FLAG_SURGE = 32;

function clampSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return settings;
  if (Number.isFinite(raw.mapN)) {
    let n = Math.round(raw.mapN);
    if (n % 2 === 0) n += 1;
    settings.mapN = Math.max(15, Math.min(33, n));
  }
  if (Number.isFinite(raw.lanterns)) {
    settings.lanterns = Math.max(2, Math.min(12, Math.round(raw.lanterns)));
  }
  if (Number.isFinite(raw.night)) {
    settings.night = Math.max(60, Math.min(900, Math.round(raw.night)));
  }
  if (Number.isFinite(raw.torch)) {
    settings.torch = raw.torch === 0 ? 0 : Math.max(20, Math.min(1800, Math.round(raw.torch)));
  }
  if (['veryLow', 'low', 'medium', 'high', 'veryHigh', 'infinite'].includes(raw.stamina)) {
    settings.stamina = raw.stamina;
  }
  if (typeof raw.tungIntel === 'boolean') settings.tungIntel = raw.tungIntel;
  if (Number.isFinite(raw.tungs)) settings.tungs = Math.max(1, Math.min(3, Math.round(raw.tungs)));
  if (['off', 'faint', 'normal', 'strong'].includes(raw.tracks)) {
    settings.tracks = raw.tracks;
  }
  return settings;
}

function normalizePassword(value) {
  return String(value || '').slice(0, 64);
}

async function digestPassword(password) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return new Uint8Array(digest);
}

async function hashPassword(value) {
  const password = normalizePassword(value);
  return password ? digestPassword(password) : null;
}

function constantTimeEqual(expected, actual) {
  if (!(expected instanceof Uint8Array) || !(actual instanceof Uint8Array) ||
      expected.byteLength !== actual.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < expected.byteLength; i++) difference |= expected[i] ^ actual[i];
  return difference === 0;
}

async function passwordMatches(expected, value) {
  if (!expected) return true;
  return constantTimeEqual(expected, await digestPassword(normalizePassword(value)));
}

function sanitizeName(name) {
  const clean = String(name || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 14);
  return clean || 'guest';
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

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function randomInt(max) {
  const range = 0x100000000;
  const limit = range - (range % max);
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= limit);
  return values[0] % max;
}

function makeCode() {
  let code = '';
  for (let i = 0; i < 5; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

function originAllowed(origin) {
  if (origin === PRODUCTION_ORIGIN || origin === 'null') return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && url.hostname === 'localhost';
  } catch {
    return false;
  }
}

async function isAndreAdmin(request) {
  const cookie = request.headers.get('Cookie');
  if (!cookie) return false;
  try {
    const response = await fetch('https://tung.andrenijman.com/_guard/status', {
      headers: { Cookie: cookie, Accept: 'application/json' },
      redirect: 'manual',
    });
    if (!response.ok) return false;
    const identity = await response.json();
    return identity.signedIn === true && String(identity.username).toLowerCase() === 'andrenijman';
  } catch (error) {
    console.error('admin identity check failed', error);
    return false;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

const lobbyKey = code => `lobby:${code}`;
const activeRoomKey = code => `active:${code}`;
const reservationKey = code => `reservation:${code}`;

function cleanLobbySummary(raw) {
  const code = normalizeCode(raw?.code);
  const players = Number(raw?.players);
  if (code.length !== 5 || !Number.isInteger(players) || players < 1 || players > 100) {
    return null;
  }
  return {
    code,
    players,
    max: MAX_PLAYERS,
    locked: !!raw.locked,
    host: sanitizeName(raw.host),
    phase: ['lobby', 'play', 'over'].includes(raw.phase) ? raw.phase : 'lobby',
    settings: clampSettings(raw.settings),
  };
}

export class Registry {
  constructor(state) {
    this.state = state;
    this.operationQueue = Promise.resolve();
  }

  fetch(request) {
    const operation = this.operationQueue.then(() => this.handleRequest(request));
    this.operationQueue = operation.catch(() => {});
    return operation;
  }

  async handleRequest(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/lobbies') return this.listLobbies();
    if (request.method === 'POST' && url.pathname === '/allocate') return this.allocate();
    if (request.method === 'POST' && url.pathname === '/lobby') return this.upsert(request);
    if (request.method === 'DELETE' && url.pathname === '/lobby') return this.remove(request);
    return new Response('not found', { status: 404 });
  }

  async listLobbies() {
    const now = Date.now();
    const [storedLobbies, storedRooms, storedReservations] = await Promise.all([
      this.state.storage.list({ prefix: 'lobby:' }),
      this.state.storage.list({ prefix: 'active:' }),
      this.state.storage.list({ prefix: 'reservation:' }),
    ]);
    const expired = [];
    const available = [];

    for (const [key, entry] of storedLobbies) {
      const summary = cleanLobbySummary(entry?.summary);
      if (!summary || !Number.isFinite(entry?.updatedAt) || now - entry.updatedAt > REGISTRY_STALE_MS) {
        expired.push(key);
        continue;
      }
      available.push({ summary, updatedAt: entry.updatedAt });
    }
    for (const [key, reservation] of storedReservations) {
      if (!Number.isFinite(reservation?.expiresAt) || reservation.expiresAt <= now) expired.push(key);
    }
    for (const [key, room] of storedRooms) {
      if (!Number.isFinite(room?.updatedAt) || now - room.updatedAt > REGISTRY_STALE_MS) expired.push(key);
    }
    await Promise.all(expired.map(key => this.state.storage.delete(key)));
    available.sort((a, b) => b.updatedAt - a.updatedAt);

    return Response.json({ lobbies: available.map(entry => entry.summary) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  async allocate() {
    const now = Date.now();
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = makeCode();
      const [lobby, activeRoom, reservation] = await Promise.all([
        this.state.storage.get(lobbyKey(code)),
        this.state.storage.get(activeRoomKey(code)),
        this.state.storage.get(reservationKey(code)),
      ]);
      const lobbyActive = lobby && Number.isFinite(lobby.updatedAt) &&
        now - lobby.updatedAt <= REGISTRY_STALE_MS;
      const roomActive = activeRoom && Number.isFinite(activeRoom.updatedAt) &&
        now - activeRoom.updatedAt <= REGISTRY_STALE_MS;
      const reservationActive = reservation && Number.isFinite(reservation.expiresAt) &&
        reservation.expiresAt > now;
      if (lobbyActive || roomActive || reservationActive) continue;

      if (lobby) await this.state.storage.delete(lobbyKey(code));
      if (activeRoom) await this.state.storage.delete(activeRoomKey(code));
      await this.state.storage.put(reservationKey(code), { expiresAt: now + RESERVATION_MS });
      return Response.json({ code }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return Response.json({ error: 'could not allocate a lobby code' }, { status: 503 });
  }

  async upsert(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('invalid registry update', { status: 400 });
    }
    const summary = cleanLobbySummary(body?.summary);
    if (!summary) return new Response('invalid lobby summary', { status: 400 });

    if (body.confirm) {
      const reservation = await this.state.storage.get(reservationKey(summary.code));
      if (!reservation || !Number.isFinite(reservation.expiresAt) || reservation.expiresAt <= Date.now()) {
        if (reservation) await this.state.storage.delete(reservationKey(summary.code));
        return new Response('lobby reservation expired', { status: 409 });
      }
    }
    const updatedAt = Date.now();
    await Promise.all([
      this.state.storage.put(lobbyKey(summary.code), { summary, updatedAt }),
      this.state.storage.put(activeRoomKey(summary.code), { updatedAt }),
    ]);
    if (body.confirm) await this.state.storage.delete(reservationKey(summary.code));
    return new Response(null, { status: 204 });
  }

  async remove(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('invalid registry removal', { status: 400 });
    }
    const code = normalizeCode(body?.code);
    if (code.length !== 5) return new Response('invalid room code', { status: 400 });
    await this.state.storage.delete(lobbyKey(code));
    if (body.release) {
      await this.state.storage.delete(activeRoomKey(code));
    } else {
      await this.state.storage.put(activeRoomKey(code), { updatedAt: Date.now() });
    }
    return new Response(null, { status: 204 });
  }
}

class Player {
  constructor(id, socket, name, cosmetics = {}, admin = false) {
    this.id = id;
    this.socket = socket;
    this.name = admin ? 'Dev Andre' : sanitizeName(name);
    this.admin = admin;
    this.sigil = cosmetics.sigil || '';
    this.look = cosmetics.look || {};
    this.vote = null;
    this.role = 'survivor';
    this.x = 1.5;
    this.y = 1.5;
    this.a = 0;
    this.flags = 0;
    this.hidden = false;
    this.alive = true;
    this.carrying = -1;
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
    return {
      id: this.id,
      name: this.name,
      sigil: this.sigil,
      look: this.look,
      vote: this.vote,
      color: PLAYER_COLORS[this.colorIdx],
      role: this.role,
      admin: this.admin,
    };
  }
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    this.tickTimer = null;
    this.maintenanceTimer = null;
    this.initializationQueue = Promise.resolve();
    this.registryQueue = Promise.resolve();
    this.resetRoom();
  }

  resetRoom(notifyRegistry = false) {
    const previousCode = this.code;
    if (notifyRegistry && previousCode) this.removeFromRegistry(previousCode, true);
    this.stopTick();
    this.created = false;
    this.code = null;
    this.players = new Map();
    this.nextPlayerId = 1;
    this.hostId = null;
    this.phase = 'lobby';
    this.settings = { ...DEFAULT_SETTINGS };
    this.seed = 0;
    this.manifest = null;
    this.items = [];
    this.timeLeft = 0;
    this.tick = 0;
    this.lastTickAt = 0;
    this.touched = Date.now();
    this.result = null;
    this.manifestWaitSince = 0;
    this.manifestRequestedAt = 0;
    this.passwordHash = null;
    this.passwordAttempts = new Map();
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('websocket upgrade required', { status: 426 });
    }

    const action = request.headers.get('X-Tung-Room-Action');
    const code = request.headers.get('X-Tung-Room-Code');
    if (!['create', 'join'].includes(action) || !code) {
      return new Response('invalid room route', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const session = {
      socket: server,
      action,
      code,
      player: null,
      initialized: false,
      closed: false,
      handshakeTimer: null,
      messageQueue: Promise.resolve(),
      ip: request.headers.get('CF-Connecting-IP') || 'unknown',
      admin: request.headers.get('X-Tung-Admin') === '1',
    };

    server.accept();
    this.sessions.add(session);
    this.ensureMaintenance();
    session.handshakeTimer = setTimeout(() => {
      if (!session.initialized) this.closeSession(session, 1008, 'create or join required');
    }, HANDSHAKE_MS);

    server.addEventListener('message', (event) => {
      session.messageQueue = session.messageQueue
        .then(() => this.onSocketMessage(session, event.data))
        .catch((error) => {
          console.error('room message handler failed', error);
          this.closeSession(session, 1011, 'relay error');
        });
    });
    server.addEventListener('close', () => this.closeSession(session));
    server.addEventListener('error', () => this.closeSession(session));

    return new Response(null, { status: 101, webSocket: client });
  }

  async onSocketMessage(session, data) {
    if (session.closed) return;
    if (typeof data !== 'string') {
      this.closeSession(session, 1003, 'text messages only');
      return;
    }
    if (data.length > MAX_MESSAGE_BYTES || new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES) {
      this.closeSession(session, 1009, 'message too large');
      return;
    }

    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;

    if (!session.initialized) {
      const initialization = this.initializationQueue
        .then(() => {
          if (session.initialized || session.closed) return;
          return this.initializeSession(session, message);
        });
      this.initializationQueue = initialization.catch(() => {});
      await initialization;
      return;
    }

    if (message.t === 'ping') {
      this.send(session.socket, { t: 'pong', c: message.c });
      return;
    }
    if (!session.player) return;
    this.touched = Date.now();
    this.handleMessage(session, message);
  }

  async initializeSession(session, message) {
    clearTimeout(session.handshakeTimer);
    session.handshakeTimer = null;
    session.initialized = true;

    if (message.t !== session.action) {
      this.fatal(session, `expected ${session.action} as the first message`);
      return;
    }

    if (session.action === 'create') {
      if (this.created) {
        this.fatal(session, 'lobby code collision; create another lobby');
        return;
      }
      this.created = true;
      this.code = session.code;
      this.settings = clampSettings(message.settings);
      try {
        this.passwordHash = await hashPassword(message.password);
      } catch (error) {
        this.resetRoom(true);
        throw error;
      }
      if (session.closed) {
        this.resetRoom(true);
        return;
      }
    } else {
      const requestedCode = normalizeCode(message.code);
      if (requestedCode !== session.code) {
        this.fatal(session, 'room code does not match the connection');
        return;
      }
      if (!this.created || this.code !== session.code || this.players.size === 0) {
        this.fatal(session, 'no lobby with that code');
        return;
      }
      if (this.phase !== 'lobby' && !(session.admin && this.phase === 'play')) {
        this.fatal(session, 'that night has already started');
        return;
      }
      if (this.players.size >= MAX_PLAYERS && !session.admin) {
        this.fatal(session, `lobby is full (${MAX_PLAYERS})`);
        return;
      }
      const now = Date.now();
      const attempts = (this.passwordAttempts.get(session.ip) || [])
        .filter(at => now - at < PASSWORD_ATTEMPT_WINDOW_MS);
      if (this.passwordHash && attempts.length >= PASSWORD_ATTEMPT_MAX) {
        this.passwordAttempts.set(session.ip, attempts);
        this.fatal(session, 'too many password attempts; wait a minute');
        return;
      }
      const matches = session.admin || await passwordMatches(this.passwordHash, message.password);
      if (session.closed) return;
      if (!this.created || this.code !== session.code || this.players.size === 0) {
        this.fatal(session, 'no lobby with that code');
        return;
      }
      if (this.phase !== 'lobby' && !(session.admin && this.phase === 'play')) {
        this.fatal(session, 'that night has already started');
        return;
      }
      if (this.players.size >= MAX_PLAYERS && !session.admin) {
        this.fatal(session, `lobby is full (${MAX_PLAYERS})`);
        return;
      }
      if (!matches) {
        attempts.push(Date.now()); this.passwordAttempts.set(session.ip, attempts);
        this.fatal(session, 'wrong lobby password');
        return;
      }
      this.passwordAttempts.delete(session.ip);
    }

    const player = new Player(this.nextPlayerId++, session.socket, message.name, sanitizeCosmetics(message), session.admin);
    this.addPlayer(player);
    session.player = player;
    if (session.action === 'create') {
      try {
        await this.syncRegistry(true);
      } catch {
        session.player = null;
        this.players.delete(player.id);
        this.resetRoom(true);
        this.fatal(session, 'lobby reservation expired; create another lobby');
        return;
      }
      if (session.closed) return;
    } else {
      this.syncRegistry();
    }
    this.send(session.socket, {
      t: 'welcome',
      you: player.id,
      code: this.code,
      color: PLAYER_COLORS[player.colorIdx],
    });
    if (this.phase === 'play' && player.admin) this.joinRunningGame(player);
    else this.sendLobby();
  }

  handleMessage(session, message) {
    const me = session.player;
    switch (message.t) {
      case 'name':
        if (this.phase !== 'lobby') break;
        me.name = me.admin ? 'Dev Andre' : sanitizeName(message.name);
        this.sendLobby();
        this.syncRegistry();
        break;

      case 'settings':
        if (me.id !== this.hostId || this.phase !== 'lobby') break;
        this.settings = clampSettings(message.settings);
        this.sendLobby();
        this.syncRegistry();
        break;

      case 'vote': {
        if (this.phase !== 'lobby') break;
        const vote = message.v;
        const id = Number(vote);
        me.vote = vote === 'random' ? 'random' : (this.players.has(id) ? id : null);
        this.sendLobby();
        break;
      }

      case 'start':
        if (me.id === this.hostId && this.phase === 'lobby') this.start();
        break;

      case 'manifest':
        if (me.id === this.hostId && this.phase === 'play') this.setManifest(message.m);
        break;

      case 'in':
        this.handleInput(me, message);
        break;

      case 'swap':
        this.handleSwap(me);
        break;

      case 'chat': {
        if (this.phase !== 'play' || !me.alive) break;
        const now = Date.now();
        me.chatTimes = me.chatTimes.filter(at => now - at < 5000);
        if (me.chatTimes.length >= 5) break;
        me.chatTimes.push(now);
        const chat = sanitizeChat(message.m);
        if (chat) this.broadcast({ t: 'chat', from: me.id, name: me.name, sigil: me.sigil, m: chat });
        break;
      }

      case 'again':
        if (me.id === this.hostId && this.phase === 'over') this.backToLobby();
        break;

      case 'leave':
        this.leaveSession(session);
        break;

      case 'admin-start':
        if (me.admin && this.phase === 'lobby') this.start();
        break;

      case 'admin-end':
        if (me.admin && this.phase === 'play') this.finish('abandoned', 'Dev Andre ended the night');
        break;

      case 'admin-kick': {
        if (!me.admin) break;
        const target = [...this.sessions].find(candidate => candidate.player?.id === Number(message.id));
        if (target && !target.player.admin) {
          this.send(target.socket, { t: 'ev', e: 'kicked', m: 'removed by Dev Andre' });
          this.closeSession(target, 1008, 'removed by admin');
        }
        break;
      }
    }
  }

  joinRunningGame(player) {
    player.role = 'survivor';
    player.alive = true;
    player.hidden = false;
    player.carrying = -1;
    player.spawnIdx = Math.max(0, ...[...this.players.values()].map(existing => existing.spawnIdx)) + 1;
    const spawn = this.manifest?.surau || [1.5, 1.5];
    player.x = spawn[0];
    player.y = spawn[1];
    player.a = 0;
    player.lastMoveAt = Date.now();
    player.moveTokens = MOVE_BURST;

    this.send(player.socket, {
      t: 'begin',
      seed: this.seed,
      settings: this.settings,
      tung: this.tungs()[0]?.id || null,
      tungs: this.tungs().map(tung => tung.id),
      how: 'admin-join',
      players: [...this.players.values()].map(existing => ({
        id: existing.id,
        name: existing.name,
        sigil: existing.sigil,
        look: existing.look,
        role: existing.role,
        admin: existing.admin,
        color: PLAYER_COLORS[existing.colorIdx],
        spawnIdx: existing.spawnIdx,
        spawn: existing.id === player.id ? { x: player.x, y: player.y, a: player.a } : null,
      })),
    });
    if (this.manifest) this.send(player.socket, { t: 'manifest', m: this.manifest });
    this.send(player.socket, this.snapshot(player));
    this.broadcast({
      t: 'roster',
      players: [...this.players.values()].map(existing => existing.publicLobby()),
      host: this.hostId,
    }, player.id);
    this.broadcast({ t: 'ev', e: 'dev-joined', who: player.id });
  }

  fatal(session, message) {
    this.send(session.socket, { t: 'err', m: message, fatal: true });
    setTimeout(() => this.closeSession(session, 1008, 'room rejected'), 0);
  }

  send(socket, message) {
    if (socket.readyState !== 1) return;
    try {
      socket.send(typeof message === 'string' ? message : JSON.stringify(message));
    } catch {
      const session = [...this.sessions].find(candidate => candidate.socket === socket);
      if (session) this.closeSession(session);
    }
  }

  broadcast(message, exceptId) {
    const encoded = JSON.stringify(message);
    for (const player of this.players.values()) {
      if (player.id !== exceptId) this.send(player.socket, encoded);
    }
  }

  addPlayer(player) {
    const used = new Set([...this.players.values()].map(existing => existing.colorIdx));
    let colorIdx = 0;
    while (used.has(colorIdx) && colorIdx < PLAYER_COLORS.length - 1) colorIdx++;
    player.colorIdx = colorIdx;
    this.players.set(player.id, player);
    if (this.hostId === null) this.hostId = player.id;
    this.touched = Date.now();
  }

  leaveSession(session) {
    const player = session.player;
    session.player = null;
    if (player) this.removePlayer(player.id);
  }

  closeSession(session, code, reason) {
    if (session.closed) return;
    session.closed = true;
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
    this.leaveSession(session);
    this.sessions.delete(session);
    if (code && session.socket.readyState < 2) {
      try {
        session.socket.close(code, reason);
      } catch {
        // The peer may already have closed between the event and cleanup.
      }
    }
    if (this.sessions.size === 0 && this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    for (const other of this.players.values()) {
      if (other.vote === id) other.vote = null;
    }
    if (this.hostId === id) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }

    if (this.phase === 'play') {
      if (player.role === 'tung' && !this.tungs().length) {
        this.finish('abandoned', 'the tung left the street');
      } else {
        if (player.carrying >= 0) this.dropItem(player);
        if (!this.survivors().length) {
          this.finish('abandoned', 'the survivors left the street');
        } else {
          this.checkEnd();
        }
      }
    }

    if (this.players.size === 0) {
      this.resetRoom(true);
    } else if (this.phase === 'lobby') {
      this.sendLobby();
      this.syncRegistry();
    } else {
      this.broadcast({
        t: 'roster',
        players: [...this.players.values()].map(player => player.publicLobby()),
        host: this.hostId,
      });
      this.syncRegistry();
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
      players: [...this.players.values()].map(player => player.publicLobby()),
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
      phase: this.phase,
      settings: { ...this.settings },
    };
  }

  queueRegistryRequest(method, body) {
    const encoded = JSON.stringify(body);
    const operation = this.registryQueue.then(async () => {
      const registry = this.env.REGISTRY.getByName('global');
      const response = await registry.fetch(new Request('https://registry.internal/lobby', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: encoded,
      }));
      if (!response.ok) {
        throw new Error(`registry update failed (${response.status}): ${await response.text()}`);
      }
    });
    this.registryQueue = operation.catch(error => console.error(error));
    this.state.waitUntil(this.registryQueue);
    return operation;
  }

  syncRegistry(confirm = false) {
    if (!this.code) return Promise.resolve();
    const active = this.created && this.players.size > 0;
    if (!active) return this.removeFromRegistry(this.code);
    return this.queueRegistryRequest('POST', { summary: this.lobbySummary(), confirm });
  }

  removeFromRegistry(code = this.code, release = false) {
    if (!code) return Promise.resolve();
    return this.queueRegistryRequest('DELETE', { code, release });
  }

  pickTung() {
    const ids = [...this.players.keys()];
    const counts = new Map();
    let randomVotes = 0;
    for (const player of this.players.values()) {
      if (player.vote === 'random') {
        randomVotes++;
      } else if (player.vote !== null && this.players.has(player.vote)) {
        counts.set(player.vote, (counts.get(player.vote) || 0) + 1);
      }
    }

    let best = 0;
    let winners = [];
    for (const [id, count] of counts) {
      if (count > best) {
        best = count;
        winners = [id];
      } else if (count === best) {
        winners.push(id);
      }
    }
    if (best === 0 || randomVotes >= best || winners.length !== 1) {
      return { id: ids[randomInt(ids.length)], how: 'random' };
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
      tungIds.push(candidates.splice(randomInt(candidates.length), 1)[0]);
    }
    this.seed = randomInt(0x7fffffff);
    this.phase = 'play';
    this.syncRegistry();
    this.manifest = null;
    this.items = [];
    this.timeLeft = this.settings.night;
    this.tick = 0;
    this.result = null;
    this.manifestWaitSince = Date.now();
    this.manifestRequestedAt = 0;

    const order = [...this.players.values()];
    order.forEach((player, index) => {
      player.role = tungIds.includes(player.id) ? 'tung' : 'survivor';
      player.alive = true;
      player.hidden = false;
      player.carrying = -1;
      player.delivered = 0;
      player.caught = 0;
      player.caughtAt = null;
      player.flags = 0;
      player.spawnIdx = index;
      player.lastInput = 0;
      player.lastMoveAt = 0;
      player.moveTokens = MOVE_BURST;
      player.motionSpeed = 0;
      player.swapCooldownUntil = 0;
    });

    this.broadcast({
      t: 'begin',
      seed: this.seed,
      settings: this.settings,
      tung: firstTungId,
      tungs: tungIds,
      how,
      players: order.map(player => ({
        id: player.id,
        name: player.name,
        sigil: player.sigil,
        look: player.look,
        role: player.role,
        color: PLAYER_COLORS[player.colorIdx],
        spawnIdx: player.spawnIdx,
      })),
    });

    this.lastTickAt = Date.now();
    this.startTick();
  }

  setManifest(manifest) {
    if (this.manifest) return;
    const reject = () => {
      this.toHost({ t: 'err', m: 'level manifest rejected; retrying' });
      return false;
    };
    const point = value => Array.isArray(value) && value.length >= 2 &&
      Number.isFinite(value[0]) && Number.isFinite(value[1]);

    if (!manifest || !Array.isArray(manifest.items) || !Array.isArray(manifest.hides) ||
        !point(manifest.surau)) return reject();
    if (!manifest.items.every(point) || !manifest.hides.every(point)) return reject();
    if (manifest.items.length !== this.settings.lanterns || manifest.items.length > 12) return reject();
    if (manifest.hides.length < 2 || manifest.hides.length > 24 || manifest.hides.length % 2) {
      return reject();
    }

    const pairs = Array.isArray(manifest.pairs) ? manifest.pairs : [];
    const cleanPairs = pairs.filter(pair => Array.isArray(pair) && pair.length === 2 &&
      Number.isInteger(pair[0]) && Number.isInteger(pair[1]) && pair[0] !== pair[1] &&
      pair[0] >= 0 && pair[1] >= 0 && pair[0] < manifest.hides.length &&
      pair[1] < manifest.hides.length);
    const paired = new Set(cleanPairs.flat());
    if (cleanPairs.length * 2 !== manifest.hides.length || paired.size !== manifest.hides.length) {
      return reject();
    }

    const spawns = Array.isArray(manifest.spawns) ? manifest.spawns : [];
    const spawnById = new Map(spawns.filter(spawn => spawn && Number.isInteger(spawn.id))
      .map(spawn => [spawn.id, spawn]));
    if ([...this.players.values()].some(player => !player.admin && !spawnById.has(player.id))) return reject();
    for (const spawn of spawns) {
      if (!spawn || !Number.isFinite(spawn.x) || !Number.isFinite(spawn.y) ||
          spawn.x < 0 || spawn.y < 0 || spawn.x >= this.settings.mapN ||
          spawn.y >= this.settings.mapN) return reject();
    }
    for (const player of this.players.values()) {
      if (!player.admin || spawnById.has(player.id)) continue;
      player.x = this.manifest.surau[0];
      player.y = this.manifest.surau[1];
      player.a = 0;
      player.lastMoveAt = Date.now();
      player.moveTokens = MOVE_BURST;
    }

    this.manifest = {
      items: manifest.items.map(point => [point[0], point[1]]),
      hides: manifest.hides.map(point => [point[0], point[1]]),
      pairs: cleanPairs,
      surau: [manifest.surau[0], manifest.surau[1]],
    };
    for (const spawn of spawns) {
      const player = this.players.get(spawn.id);
      if (!player) continue;
      player.x = spawn.x;
      player.y = spawn.y;
      player.a = Number.isFinite(spawn.a) ? spawn.a : 0;
      player.lastMoveAt = Date.now();
      player.moveTokens = MOVE_BURST;
    }
    this.items = this.manifest.items.map(point => ({
      x: point[0],
      y: point[1],
      home: [point[0], point[1]],
      state: 0,
      carrier: -1,
    }));
    this.broadcast({ t: 'manifest', m: this.manifest });
    this.lastTickAt = Date.now();
    return true;
  }

  toHost(message) {
    const host = this.players.get(this.hostId);
    if (host) this.send(host.socket, message);
  }

  startTick() {
    this.stopTick();
    this.tickTimer = setInterval(() => {
      try {
        this.tickOnce();
      } catch (error) {
        console.error('room tick failed', error);
      }
    }, 1000 / TICK_HZ);
  }

  stopTick() {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  ensureMaintenance() {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      if (!this.created || Date.now() - this.touched <= ROOM_IDLE_MS) return;
      for (const session of [...this.sessions]) this.closeSession(session, 1000, 'room idle');
    }, MAINTENANCE_MS);
  }

  tickOnce() {
    const now = Date.now();
    const dt = Math.min(0.5, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;
    if (this.phase !== 'play') return;
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
    return [...this.players.values()].filter(player => player.role === 'survivor');
  }

  tungs() {
    return [...this.players.values()].filter(player => player.role === 'tung');
  }

  resolvePickups() {
    for (const player of this.survivors()) {
      if (!player.alive || player.hidden || player.carrying >= 0) continue;
      for (let index = 0; index < this.items.length; index++) {
        const item = this.items[index];
        if (item.state !== 0) continue;
        if ((player.x - item.x) ** 2 + (player.y - item.y) ** 2 > PICKUP_DIST ** 2) continue;
        item.state = 1;
        item.carrier = player.id;
        player.carrying = index;
        this.broadcast({ t: 'ev', e: 'pickup', by: player.id, i: index });
        break;
      }
    }
  }

  resolveDeliveries() {
    const surau = this.manifest.surau;
    for (const player of this.survivors()) {
      if (!player.alive || player.hidden || player.carrying < 0) continue;
      if ((player.x - surau[0]) ** 2 + (player.y - surau[1]) ** 2 > SURAU_DIST ** 2) continue;
      const item = this.items[player.carrying];
      item.state = 2;
      item.carrier = -1;
      item.x = surau[0];
      item.y = surau[1];
      this.broadcast({ t: 'ev', e: 'deliver', by: player.id, i: player.carrying });
      player.carrying = -1;
      player.delivered++;
    }
  }

  resolveCatches() {
    if (!this.manifest) return;
    for (const tung of this.tungs()) {
      if (!tung.alive) continue;
      for (const player of this.survivors()) {
        if (!player.alive) continue;
        if ((player.x - tung.x) ** 2 + (player.y - tung.y) ** 2 > CATCH_DIST ** 2) continue;
        player.alive = false;
        tung.caught++;
        player.caughtAt = [player.x, player.y];
        if (player.carrying >= 0) this.dropItem(player);
        this.broadcast({ t: 'ev', e: 'caught', who: player.id, by: tung.id, x: player.x, y: player.y });
      }
    }
  }

  dropItem(player) {
    if (player.carrying < 0) return;
    const item = this.items[player.carrying];
    item.state = 0;
    item.carrier = -1;
    item.x = player.x;
    item.y = player.y;
    this.broadcast({ t: 'ev', e: 'drop', i: player.carrying, x: item.x, y: item.y });
    player.carrying = -1;
  }

  snapshot(viewer) {
    const players = [];
    for (const player of this.players.values()) {
      const concealed = player.hidden || !player.alive ||
        (viewer && viewer.role === 'survivor' && !viewer.alive && player.id !== viewer.id);
      const carrying = !viewer || player.id === viewer.id || !player.hidden ? player.carrying : -1;
      const row = [
        player.id,
        player.flags | (player.hidden ? FLAG_HIDDEN : 0),
        player.alive ? 1 : 0,
        carrying,
      ];
      players.push(concealed ? row : row.concat([round2(player.x), round2(player.y), round3(player.a)]));
    }
    return {
      t: 'snap',
      k: this.tick,
      tl: Math.max(0, round2(this.timeLeft)),
      p: players,
      it: this.items.map(item => viewer?.role === 'tung' && !this.settings.tungIntel
        ? [item.state, -1, 0, 0] : [item.state, item.carrier, round2(item.x), round2(item.y)]),
    };
  }

  broadcastSnapshot() {
    for (const player of this.players.values()) this.send(player.socket, this.snapshot(player));
  }

  checkEnd() {
    if (this.phase !== 'play' || !this.manifest) return;
    const alive = this.survivors().filter(player => player.alive);
    if (this.items.length && this.items.every(item => item.state === 2)) {
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
    this.syncRegistry();
    const delivered = this.items.filter(item => item.state === 2).length;
    this.broadcast({
      t: 'over',
      result,
      blurb,
      delivered,
      total: this.items.length,
      timeLeft: Math.max(0, round2(this.timeLeft)),
      scores: [...this.players.values()].map(player => ({
        id: player.id,
        name: player.name,
        sigil: player.sigil,
        look: player.look,
        role: player.role,
        alive: player.alive,
        delivered: player.delivered,
        caught: player.caught,
        color: PLAYER_COLORS[player.colorIdx],
      })),
    });
  }

  backToLobby() {
    this.phase = 'lobby';
    this.stopTick();
    this.manifest = null;
    this.items = [];
    for (const player of this.players.values()) {
      player.role = 'survivor';
      player.alive = true;
      player.hidden = false;
      player.carrying = -1;
      player.vote = null;
    }
    this.sendLobby();
    this.syncRegistry();
  }

  handleInput(player, message) {
    if (this.phase !== 'play' || !player.alive) return;
    const now = Date.now();
    let moved = 0;
    let moveDt = 0;
    let acceptedMove = false;

    if (Number.isFinite(message.x) && Number.isFinite(message.y)) {
      const inBounds = message.x >= 0 && message.y >= 0 &&
        message.x < this.settings.mapN && message.y < this.settings.mapN;
      moveDt = Math.max(0, (now - (player.lastMoveAt || now)) / 1000);
      player.moveTokens = Math.min(
        MOVE_BURST,
        player.moveTokens + MAX_SPEED * Math.min(moveDt, 1.0),
      );
      player.lastMoveAt = now;
      moved = Math.hypot(message.x - player.x, message.y - player.y);
      if (inBounds && moved <= player.moveTokens + 1e-6) {
        player.x = message.x;
        player.y = message.y;
        player.moveTokens = Math.max(0, player.moveTokens - moved);
        acceptedMove = true;
      }
    }

    if (Number.isFinite(message.a)) player.a = message.a;
    const speed = acceptedMove && moveDt > 0 ? moved / moveDt : 0;
    const alpha = 1 - Math.exp(-Math.min(moveDt, 0.5) / 0.20);
    player.motionSpeed += (speed - player.motionSpeed) * alpha;
    const wasSprinting = !!(player.flags & FLAG_SPRINT);
    const sprinting = wasSprinting
      ? player.motionSpeed > WALK_SPEED + 0.25
      : player.motionSpeed > WALK_SPEED + 0.65;
    player.flags = (player.motionSpeed > 0.15 ? FLAG_MOVING : 0) |
      (sprinting ? FLAG_SPRINT : 0) |
      (player.role === 'tung' && (message.f & FLAG_SURGE) ? FLAG_SURGE : 0);

    let hidden = !!(message.f & FLAG_HIDDEN) && player.role === 'survivor';
    if (hidden && this.manifest) {
      hidden = this.manifest.hides.some(hide =>
        (hide[0] - player.x) ** 2 + (hide[1] - player.y) ** 2 < HIDE_DIST ** 2);
    }
    player.hidden = hidden;
    player.lastInput = now;
  }

  handleSwap(player) {
    if (this.phase !== 'play' || !player.alive || !player.hidden || !this.manifest) {
      this.send(player.socket, { t: 'ev', e: 'swap-no', wait: 0.5 });
      return;
    }

    const now = Date.now();
    if (now < player.swapCooldownUntil) {
      this.send(player.socket, {
        t: 'ev',
        e: 'swap-no',
        wait: Math.ceil((player.swapCooldownUntil - now) / 1000),
      });
      return;
    }

    const hides = this.manifest.hides;
    let from = -1;
    let bestDistance = HIDE_DIST ** 2;
    for (let index = 0; index < hides.length; index++) {
      const distance = (hides[index][0] - player.x) ** 2 + (hides[index][1] - player.y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        from = index;
      }
    }
    if (from < 0) {
      this.send(player.socket, { t: 'ev', e: 'swap-no', wait: 0.5 });
      return;
    }

    let to = -1;
    for (const [a, b] of this.manifest.pairs) {
      if (a === from) {
        to = b;
        break;
      }
      if (b === from) {
        to = a;
        break;
      }
    }
    if (to < 0 || !hides[to]) {
      this.send(player.socket, { t: 'ev', e: 'swap-no', wait: 0.5 });
      return;
    }

    player.x = hides[to][0];
    player.y = hides[to][1];
    player.moveTokens = 0;
    player.lastMoveAt = now;
    player.swapCooldownUntil = now + SWAP_COOLDOWN_MS;
    this.send(player.socket, { t: 'ev', e: 'swap', from, to, x: player.x, y: player.y });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/lobbies' || url.pathname === '/admin/lobbies')) {
      const adminRequest = url.pathname === '/admin/lobbies';
      if (adminRequest && !(await isAndreAdmin(request))) {
        return Response.json({ error: 'admin account required' }, { status: 403 });
      }
      const registry = env.REGISTRY.getByName('global');
      let status = 200;
      let lobbies = [];
      try {
        const response = await registry.fetch(new Request('https://registry.internal/lobbies'));
        status = response.status;
        if (response.ok) {
          const body = await response.json();
          lobbies = Array.isArray(body?.lobbies) ? body.lobbies : [];
          lobbies = lobbies.filter(lobby => adminRequest
            ? lobby.phase !== 'over'
            : lobby.phase === 'lobby' && lobby.players < MAX_PLAYERS);
        }
      } catch (error) {
        console.error('lobby registry read failed', error);
        status = 503;
      }
      const headers = new Headers({
        'Cache-Control': 'no-store',
        Vary: 'Origin',
      });
      const origin = request.headers.get('Origin');
      if (originAllowed(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Credentials', 'true');
      }
      return Response.json({ lobbies }, { status, headers });
    }
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'tung-relay' }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('tung relay. connect over websocket.\n', {
        status: 426,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Upgrade: 'websocket',
        },
      });
    }
    if (!originAllowed(request.headers.get('Origin'))) {
      return new Response('origin not allowed', { status: 403 });
    }

    const creating = url.searchParams.get('create') === '1';
    const suppliedCode = normalizeCode(url.searchParams.get('code'));
    if (creating === !!suppliedCode) {
      return new Response('use exactly one of ?create=1 or ?code=ABCDE', { status: 400 });
    }

    const action = creating ? 'create' : 'join';
    const admin = await isAndreAdmin(request);
    let code = suppliedCode;
    if (creating) {
      try {
        const registry = env.REGISTRY.getByName('global');
        const response = await registry.fetch(new Request('https://registry.internal/allocate', {
          method: 'POST',
        }));
        if (!response.ok) return new Response('could not allocate a lobby code', { status: 503 });
        code = normalizeCode((await response.json()).code);
      } catch (error) {
        console.error('lobby code allocation failed', error);
        return new Response('could not allocate a lobby code', { status: 503 });
      }
    }
    if (code.length !== 5) {
      return new Response('room codes must be five characters', { status: 400 });
    }

    const headers = new Headers(request.headers);
    headers.set('X-Tung-Room-Action', action);
    headers.set('X-Tung-Room-Code', code);
    headers.set('X-Tung-Admin', admin ? '1' : '0');
    const roomRequest = new Request(request, { headers });
    return env.ROOMS.getByName(code).fetch(roomRequest);
  },
};
