// Unit tests for the latency work, in plain Node:
//   - SnapBuffer (index.html), the remote-body buffer, lifted out of the page;
//   - the relay's room move (worker/relay.js Room), driven through its own
//     message handler with fake sockets and a fake ROOMS namespace.
//
//   node --test tests/latency/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapBuffer } from './load-snapbuffer.mjs';
import { Room } from '../../worker/relay.js';

const SnapBuffer = loadSnapBuffer();
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// SnapBuffer

// Samples every 50 ms on the sender's clock, arriving `late` ms (plus jitter)
// later, in order: a late packet holds up the ones behind it.
function feed(buffer, samples, { late = 100, jitter = () => 0 } = {}) {
  let arrival = 0;
  for (const [i, [x, y]] of samples.entries()) {
    const sent = 1000 + i * 50;
    arrival = Math.max(arrival, sent + late + jitter(i));
    buffer.snap(i + 1, arrival);
    buffer.add(7, x, y, 0, sent);
  }
  return arrival;
}

test('a body is interpolated between samples, a delay behind', () => {
  const buffer = new SnapBuffer();
  const line = Array.from({ length: 20 }, (_, i) => [i * 0.1, 0]);
  const last = feed(buffer, line);
  buffer.frame(last);
  const pose = buffer.pose(7);
  // Steady arrivals: drawn one gap (50 ms, one sample) behind the newest.
  assert.ok(Math.abs(pose.x - 1.8) < 1e-9, `x ${pose.x}`);
  buffer.frame(last + 25);
  assert.ok(Math.abs(buffer.pose(7).x - 1.85) < 1e-9, 'halfway between two samples');
});

test('past the newest sample a body coasts for at most 100 ms', () => {
  const buffer = new SnapBuffer();
  const last = feed(buffer, Array.from({ length: 20 }, (_, i) => [i * 0.1, 0]));
  buffer.frame(last);
  buffer.frame(last + 400);                 // no packets for 400 ms
  const pose = buffer.pose(7);
  assert.ok(Math.abs(pose.x - (1.9 + 0.2)) < 1e-6, `coasts 100 ms at 2 tiles/s, then holds (x ${pose.x})`);
});

test('a teleport snaps instead of sliding', () => {
  const buffer = new SnapBuffer();
  const samples = Array.from({ length: 10 }, (_, i) => [i * 0.1, 0]).concat(Array.from({ length: 3 }, () => [9, 9]));
  const last = feed(buffer, samples);
  buffer.frame(last);
  const pose = buffer.pose(7);
  assert.deepEqual([pose.x, pose.y], [9, 9]);
});

test('a send clock that restarts resets the track instead of freezing it', () => {
  const buffer = new SnapBuffer();
  let now = 5000;
  for (let i = 0; i < 10; i++) { buffer.snap(i + 1, now += 50); buffer.add(7, i * 0.1, 0, 0, 900000 + i * 50); }
  // Their performance.now() starts over (a reload keeping the seat): far behind.
  for (let i = 0; i < 10; i++) { buffer.snap(i + 11, now += 50); buffer.add(7, 1 + i * 0.1, 0, 0, 20 + i * 50); }
  buffer.frame(now);
  const pose = buffer.pose(7);
  assert.ok(pose.x > 1.5, `follows the new clock (x ${pose.x})`);
});

test('the delay grows with jitter and stays clamped', () => {
  const steady = new SnapBuffer(), jittery = new SnapBuffer(), awful = new SnapBuffer();
  const line = Array.from({ length: 60 }, (_, i) => [i * 0.1, 0]);
  feed(steady, line);
  feed(jittery, line, { jitter: i => (i % 4 === 0 ? 60 : 0) });
  feed(awful, line, { jitter: i => (i % 10 === 0 ? 400 : 0) });
  const delay = b => b.tracks.get(7).delay;
  assert.equal(delay(steady), 50);
  assert.ok(delay(jittery) > 50, `jittery delay ${delay(jittery)}`);
  assert.equal(delay(awful), 250);
});

test('without a send time a body sits on the relay tick clock; a new night starts over', () => {
  const buffer = new SnapBuffer();
  for (let k = 1; k <= 40; k++) { buffer.snap(k, 2000 + k * 50); buffer.add(3, k * 0.1, 0, 0); }
  assert.equal(buffer.tracks.get(3).samples.at(-1).t, 2000);
  buffer.snap(30, 4100);
  assert.equal(buffer.tracks.size, 1, 'a late snapshot is not a new night');
  buffer.snap(1, 4200);
  assert.equal(buffer.tracks.size, 0, 'tick restarted: tracks cleared');
});

test('a body never seen has no pose', () => {
  const buffer = new SnapBuffer();
  buffer.frame(100);
  assert.equal(buffer.pose(1), null);
});

// ---------------------------------------------------------------------------
// Room move

function storage() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.get(key); },
    async put(key, value) { map.set(key, value); },
    async deleteAll() { map.clear(); },
  };
}

// A ROOMS namespace whose objects are Room instances in this process.
function world({ adoptFails = false } = {}) {
  const rooms = new Map();
  const env = {
    DEV_COLO: 'FRA',
    REGISTRY: { getByName: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
  };
  const room = name => {
    if (!rooms.has(name)) rooms.set(name, new Room({ waitUntil() {}, storage: storage() }, env));
    return rooms.get(name);
  };
  env.ROOMS = {
    idFromName: name => name,
    get: id => ({
      fetch: async (url, init) => {
        if (adoptFails && new URL(url).pathname === '/_adopt') throw new Error('unreachable');
        return room(id).fetch(new Request(url, init));
      },
    }),
  };
  return { rooms, room };
}

function socket() {
  const s = { readyState: 1, sent: [], closed: null };
  s.send = text => s.sent.push(JSON.parse(text));
  s.close = (code, reason) => { s.readyState = 3; s.closed = { code, reason }; };
  s.last = type => s.sent.filter(m => m.t === type).at(-1);
  return s;
}

async function connect(room, action, code, name, { ticket = '', country = 'XX' } = {}) {
  const session = {
    socket: socket(), action, code, player: null, initialized: false, closed: false,
    messageQueue: Promise.resolve(), ip: name, admin: false, adminName: '',
    where: { country, edge: 'TST' }, ticket,
  };
  room.sessions.add(session);
  await room.onSocketMessage(session, JSON.stringify(action === 'create' ? { t: 'create', name } : { t: 'join', code, name }));
  return session;
}
const say = (room, session, msg) => room.onSocketMessage(session, JSON.stringify(msg));

async function lobbyOf(w, groups) {
  const root = w.room('BCDFG');
  const sessions = {};
  for (const [i, [name, rtt, probes]] of groups.entries()) {
    sessions[name] = await connect(root, i ? 'join' : 'create', 'BCDFG', name);
    for (let c = 0; c < 3; c++) await say(root, sessions[name], { t: 'ping', c, rtt });
    await say(root, sessions[name], { t: 'regions', ms: probes });
  }
  return { root, sessions };
}

const MIXED = [
  ['Carl', 20, { weur: 20, apac: 200, oc: 290, me: 90 }],
  ['Ana', 300, { weur: 300, apac: 60, oc: 20, me: 250 }],
  ['Budi', 280, { weur: 280, apac: 30, oc: 90, me: 240 }],
];

function cleanup(w) {
  for (const room of w.rooms.values()) { room.stopTick(); clearTimeout(room.adoptTimer); }
}

test('a mixed lobby moves at start; tickets restore the seats and the shard starts', async () => {
  const w = world();
  const { root, sessions } = await lobbyOf(w, MIXED);
  const ids = Object.fromEntries(Object.entries(sessions).map(([name, s]) => [name, s.player.id]));
  await say(root, sessions.Carl, { t: 'start' });
  for (let i = 0; i < 5; i++) await tick();

  const moves = Object.fromEntries(Object.entries(sessions).map(([name, s]) => [name, s.socket.last('move')]));
  assert.ok(Object.values(moves).every(m => m && /^apac-/.test(m.shard) && m.region === 'apac' && m.ticket));
  assert.equal(root.phase, 'lobby', 'the old room never starts');
  assert.ok(!Object.values(sessions).some(s => s.socket.last('begin')));
  assert.deepEqual(root.moved, { shard: moves.Carl.shard, region: 'apac' });
  assert.deepEqual(root.state.storage.map.get('moved'), root.moved, 'the move survives eviction');
  assert.equal(root.players.size, 0);

  const shard = w.rooms.get(`BCDFG~${moves.Carl.shard}`);
  assert.ok(shard.created && shard.tickets.size === 3 && shard.movedFrom === 'FRA');
  const again = {};
  for (const name of ['Ana', 'Budi']) {
    again[name] = await connect(shard, 'join', 'BCDFG', name, { ticket: moves[name].ticket });
    assert.equal(again[name].socket.last('welcome').you, ids[name], `${name} keeps their seat`);
  }
  assert.equal(shard.phase, 'lobby', 'waits for the last ticket');
  again.Carl = await connect(shard, 'join', 'BCDFG', 'Carl', { ticket: moves.Carl.ticket });
  assert.equal(shard.phase, 'play', 'every ticket is back: the night starts');
  assert.equal(shard.hostId, ids.Carl, 'the host is still the host');
  assert.ok(again.Ana.socket.last('begin'));

  // Moved rooms never move again, and the record says where it went.
  shard.net.startedAt -= 20_000;
  const logs = [];
  shard.env.NETLOG = { record: async (game, log) => { logs.push(log); } };
  shard.finish('dawn', 'test');
  await tick();
  assert.equal(logs[0].region, 'apac');
  assert.deepEqual(logs[0].moved, { from: 'FRA', to: 'apac' });

  // When the shard empties, the old code is released.
  for (const s of Object.values(again)) await say(shard, s, { t: 'leave' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(root.moved, null);
  assert.equal(root.state.storage.map.size, 0);
  cleanup(w);
});

test('a shard starts with whoever is back after the wait', async () => {
  const w = world();
  const { root, sessions } = await lobbyOf(w, MIXED);
  await say(root, sessions.Carl, { t: 'start' });
  for (let i = 0; i < 5; i++) await tick();
  const move = sessions.Ana.socket.last('move');
  const shard = w.rooms.get(`BCDFG~${move.shard}`);
  await connect(shard, 'join', 'BCDFG', 'Ana', { ticket: move.ticket });
  await connect(shard, 'join', 'BCDFG', 'Budi', { ticket: sessions.Budi.socket.last('move').ticket });
  shard.startAdopted();                      // the 6 s wait ran out
  assert.equal(shard.phase, 'play');
  assert.equal(shard.players.size, 2);
  cleanup(w);
});

test('a same-region lobby starts where it is', async () => {
  const w = world();
  const near = { weur: 20, eeur: 45, apac: 300 };
  const { root, sessions } = await lobbyOf(w, [['Ana', 20, near], ['Budi', 25, near]]);
  await say(root, sessions.Ana, { t: 'start' });
  assert.equal(root.phase, 'play');
  assert.ok(!sessions.Budi.socket.last('move'));
  cleanup(w);
});

test('without everyone\'s probes the lobby stays', async () => {
  const w = world();
  const { root, sessions } = await lobbyOf(w, MIXED.map(([name, rtt, probes], i) => [name, rtt, i === 1 ? null : probes]));
  await say(root, sessions.Carl, { t: 'start' });
  assert.equal(root.phase, 'play');
  cleanup(w);
});

test('a failed move starts the night here', async () => {
  const w = world({ adoptFails: true });
  const { root, sessions } = await lobbyOf(w, MIXED);
  const errors = console.error;
  console.error = () => {};
  try {
    await say(root, sessions.Carl, { t: 'start' });
    for (let i = 0; i < 5; i++) await tick();
  } finally {
    console.error = errors;
  }
  assert.equal(root.phase, 'play');
  assert.ok(!root.moved);
  assert.ok(sessions.Ana.socket.last('begin') && !sessions.Ana.socket.last('move'));
  cleanup(w);
});
