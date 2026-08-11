const CATCH_DIST = 0.52;
const PICKUP_DIST = 0.62;
const SURAU_DIST = 0.9;
const HIDE_DIST = 0.85;
const MAX_SPEED = 3.85;
const WALK_SPEED = 2.2;
const MOVE_BURST = 1.0;
const SWAP_COOLDOWN_MS = 12000;

const TICK_HZ = 20;
const MAX_PLAYERS = 5;
const MIN_PLAYERS = 2;
const ROOM_IDLE_MS = 45 * 60 * 1000;
const MAINTENANCE_MS = 25000;
const HANDSHAKE_MS = 15000;
const MAX_MESSAGE_BYTES = 1024 * 1024;

const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
const PLAYER_COLORS = ['#e0a040', '#68c0d8', '#8ad06a', '#d878b8', '#c8c0a8'];
const PRODUCTION_ORIGIN = 'https://tung.andrenijman.com';

const DEFAULT_SETTINGS = {
  mapN: 21,
  lanterns: 6,
  night: 300,
  torch: 125,
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
    settings.torch = Math.max(20, Math.min(900, Math.round(raw.torch)));
  }
  if (['off', 'faint', 'normal', 'strong'].includes(raw.tracks)) {
    settings.tracks = raw.tracks;
  }
  return settings;
}

function sanitizeName(name) {
  const clean = String(name || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 14);
  return clean || 'guest';
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

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

class Player {
  constructor(id, socket, name) {
    this.id = id;
    this.socket = socket;
    this.name = sanitizeName(name);
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
    this.caughtAt = null;
    this.lastInput = 0;
    this.lastMoveAt = 0;
    this.moveTokens = MOVE_BURST;
    this.motionSpeed = 0;
    this.swapCooldownUntil = 0;
    this.colorIdx = 0;
    this.spawnIdx = 0;
  }

  publicLobby() {
    return {
      id: this.id,
      name: this.name,
      vote: this.vote,
      color: PLAYER_COLORS[this.colorIdx],
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
    this.resetRoom();
  }

  resetRoom() {
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
    };

    server.accept();
    this.sessions.add(session);
    this.ensureMaintenance();
    session.handshakeTimer = setTimeout(() => {
      if (!session.initialized) this.closeSession(session, 1008, 'create or join required');
    }, HANDSHAKE_MS);

    server.addEventListener('message', (event) => {
      try {
        this.onSocketMessage(session, event.data);
      } catch (error) {
        console.error('room message handler failed', error);
        this.closeSession(session, 1011, 'relay error');
      }
    });
    server.addEventListener('close', () => this.closeSession(session));
    server.addEventListener('error', () => this.closeSession(session));

    return new Response(null, { status: 101, webSocket: client });
  }

  onSocketMessage(session, data) {
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
      this.initializeSession(session, message);
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

  initializeSession(session, message) {
    clearTimeout(session.handshakeTimer);
    session.handshakeTimer = null;
    session.initialized = true;

    if (message.t !== session.action) {
      this.fatal(session, `expected ${session.action} as the first message`);
      return;
    }

    if (session.action === 'create') {
      if (this.created && this.players.size > 0) {
        this.fatal(session, 'lobby code collision; create another lobby');
        return;
      }
      if (this.created) this.resetRoom();
      this.created = true;
      this.code = session.code;
      this.settings = clampSettings(message.settings);
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
      if (this.phase !== 'lobby') {
        this.fatal(session, 'that night has already started');
        return;
      }
      if (this.players.size >= MAX_PLAYERS) {
        this.fatal(session, 'lobby is full (5)');
        return;
      }
    }

    const player = new Player(this.nextPlayerId++, session.socket, message.name);
    this.addPlayer(player);
    session.player = player;
    this.send(session.socket, {
      t: 'welcome',
      you: player.id,
      code: this.code,
      color: PLAYER_COLORS[player.colorIdx],
    });
    this.sendLobby();
  }

  handleMessage(session, message) {
    const me = session.player;
    switch (message.t) {
      case 'name':
        if (this.phase !== 'lobby') break;
        me.name = sanitizeName(message.name);
        this.sendLobby();
        break;

      case 'settings':
        if (me.id !== this.hostId || this.phase !== 'lobby') break;
        this.settings = clampSettings(message.settings);
        this.sendLobby();
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

      case 'again':
        if (me.id === this.hostId && this.phase === 'over') this.backToLobby();
        break;

      case 'leave':
        this.leaveSession(session);
        break;
    }
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
      if (player.role === 'tung') {
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
      this.resetRoom();
    } else if (this.phase === 'lobby') {
      this.sendLobby();
    } else {
      this.broadcast({
        t: 'roster',
        players: [...this.players.values()].map(player => player.publicLobby()),
        host: this.hostId,
      });
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

    const { id: tungId, how } = this.pickTung();
    this.seed = randomInt(0x7fffffff);
    this.phase = 'play';
    this.manifest = null;
    this.items = [];
    this.timeLeft = this.settings.night;
    this.tick = 0;
    this.result = null;
    this.manifestWaitSince = Date.now();
    this.manifestRequestedAt = 0;

    const order = [...this.players.values()];
    order.forEach((player, index) => {
      player.role = player.id === tungId ? 'tung' : 'survivor';
      player.alive = true;
      player.hidden = false;
      player.carrying = -1;
      player.delivered = 0;
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
      tung: tungId,
      how,
      players: order.map(player => ({
        id: player.id,
        name: player.name,
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
    if ([...this.players.keys()].some(id => !spawnById.has(id))) return reject();
    for (const spawn of spawns) {
      if (!spawn || !Number.isFinite(spawn.x) || !Number.isFinite(spawn.y) ||
          spawn.x < 0 || spawn.y < 0 || spawn.x >= this.settings.mapN ||
          spawn.y >= this.settings.mapN) return reject();
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

  tung() {
    return [...this.players.values()].find(player => player.role === 'tung') || null;
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
    const tung = this.tung();
    if (!tung || !tung.alive || !this.manifest) return;
    for (const player of this.survivors()) {
      if (!player.alive || player.hidden) continue;
      if ((player.x - tung.x) ** 2 + (player.y - tung.y) ** 2 > CATCH_DIST ** 2) continue;
      player.alive = false;
      player.caughtAt = [player.x, player.y];
      if (player.carrying >= 0) this.dropItem(player);
      this.broadcast({ t: 'ev', e: 'caught', who: player.id, x: player.x, y: player.y });
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
      it: this.items.map(item => [item.state, item.carrier, round2(item.x), round2(item.y)]),
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
        role: player.role,
        alive: player.alive,
        delivered: player.delivered,
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
    const code = creating ? makeCode() : suppliedCode;
    if (code.length !== 5) {
      return new Response('room codes must be five characters', { status: 400 });
    }

    const headers = new Headers(request.headers);
    headers.set('X-Tung-Room-Action', action);
    headers.set('X-Tung-Room-Code', code);
    const roomRequest = new Request(request, { headers });
    return env.ROOMS.getByName(code).fetch(roomRequest);
  },
};
