// Integration test for room placement against wrangler dev (worker/relay.js).
//
// Three players, one far away by their fake probe results, join, start and
// are moved; they reconnect with their tickets, the night begins on the shard,
// and a later joiner to the old code is sent on to it. When the shard empties
// the old code is free again. A same-region pair is not moved. Also GET /ping
// (region, CORS), the internal routes staying internal, and the lag records
// (country, region, moved) as received by a stub NetLog.
//
// It starts both servers itself: the relay on 8810 (inspector 9310) and the
// NetLog stub on 8812 (inspector 9312), sharing a private dev registry so the
// relay's NETLOG binding reaches the stub and nothing else:
//   node tests/latency/rooms.test.mjs
// WRANGLER picks the wrangler binary (default: node_modules/.bin/wrangler,
// then river-flume's, then npx). Takes about 30 s.
//
// The players come in "through games-guard": the test sends the proxy secret
// (--var TUNG_PROXY_SECRET) with X-Games-Country/X-Games-Edge, which is how
// the relay learns a proxied player's country. DEV_COLO pins the room's colo.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELAY_PORT = 8810, NETLOG_PORT = 8812;
const HTTP = `http://127.0.0.1:${RELAY_PORT}`;
const WS = `ws://127.0.0.1:${RELAY_PORT}/ws`;
const NETLOG = `http://127.0.0.1:${NETLOG_PORT}`;
const SECRET = 'latency-test-secret';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let pass = 0, fail = 0;
function ok(condition, message) {
  if (condition) pass++;
  else { fail++; console.log('FAIL:', message); }
}

// ---------------------------------------------------------------------------
// servers

const servers = [];
let registry = '';
async function up(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}
function wranglerBin() {
  if (process.env.WRANGLER) return [process.env.WRANGLER];
  for (const candidate of [
    path.join(ROOT, 'node_modules/.bin/wrangler'),
    '/var/home/andre/Projects/site/games.andrenijman.com/river-flume/node_modules/.bin/wrangler',
  ]) if (existsSync(candidate)) return [candidate];
  return ['npx', 'wrangler'];
}
async function startServers() {
  const [bin, ...pre] = wranglerBin();
  registry = mkdtempSync(path.join(tmpdir(), 'tung-registry-'));
  const run = args => {
    const child = spawn(bin, [...pre, ...args], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], detached: true,
      env: { ...process.env, WRANGLER_REGISTRY_PATH: registry, WRANGLER_SEND_METRICS: 'false' },
    });
    servers.push(child);
  };
  run(['dev', '-c', 'tests/latency/netlog-stub.jsonc', '--port', String(NETLOG_PORT), '--inspector-port', '9312', '--ip', '127.0.0.1']);
  run(['dev', '--port', String(RELAY_PORT), '--inspector-port', '9310', '--ip', '127.0.0.1',
    '--var', `TUNG_PROXY_SECRET:${SECRET}`, '--var', 'DEV_COLO:FRA']);
  if (!(await up(`${NETLOG}/`)) || !(await up(`${HTTP}/health`))) throw new Error('wrangler dev did not come up');
  await sleep(1500); // let the dev registry connect the NETLOG binding
}
function stopServers() {
  for (const child of servers) try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
  if (registry) try { rmSync(registry, { recursive: true, force: true }); } catch { /* still in use */ }
}

// ---------------------------------------------------------------------------
// clients

// A player as games-guard forwards them: proxy secret plus where they are.
// `proxied: false` connects directly, so the relay must ignore the headers.
function client(query, { country = '', proxied = true } = {}) {
  const headers = { Origin: 'http://localhost' };
  if (proxied) headers['X-Tung-Proxy-Authorization'] = `Bearer ${SECRET}`;
  if (country) Object.assign(headers, { 'X-Games-Country': country, 'X-Games-Edge': 'TST' });
  const ws = new WebSocket(`${WS}?${query}`, { headers });
  const c = { ws, msgs: [], waiters: [], closed: null };
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.t === 'pong') return;
    const waiter = c.waiters.find(w => w.type === msg.t);
    if (waiter) { c.waiters = c.waiters.filter(w => w !== waiter); waiter.resolve(msg); } else c.msgs.push(msg);
  });
  ws.addEventListener('close', event => {
    c.closed = { code: event.code, reason: event.reason };
    for (const waiter of c.waiters) waiter.closed?.();
  });
  c.opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`could not connect ${query}`)), { once: true });
  });
  c.send = obj => ws.send(JSON.stringify(obj));
  c.wait = (type, timeout = 8000) => new Promise((resolve, reject) => {
    const hit = c.msgs.find(m => m.t === type);
    if (hit) { c.msgs = c.msgs.filter(m => m !== hit); resolve(hit); return; }
    const waiter = { type, resolve };
    c.waiters.push(waiter);
    setTimeout(() => {
      c.waiters = c.waiters.filter(w => w !== waiter);
      reject(new Error(`timeout waiting for ${type}; got ${c.msgs.map(m => m.t).join(',')}`));
    }, timeout);
  });
  c.waitClosed = async (timeout = 4000) => {
    for (let t = 0; t < timeout && !c.closed; t += 50) await sleep(50);
    return c.closed;
  };
  c.close = () => { try { ws.close(); } catch { /* closed */ } };
  return c;
}

async function create(name, opts) {
  const c = client('create=1', opts);
  await c.opened;
  c.send({ t: 'create', name, settings: { tungs: 1 } });
  const welcome = await c.wait('welcome');
  c.you = welcome.you; c.code = welcome.code;
  await c.wait('lobby');
  return c;
}
async function join(code, name, opts, extra = '') {
  const c = client(`code=${code}${extra}`, opts);
  await c.opened;
  c.send({ t: 'join', code, name });
  return c;
}
async function joined(c) {
  const welcome = await c.wait('welcome');
  c.you = welcome.you;
  return c;
}
// What the client does: report its pings (NetPing rtt) and region probes.
function report(c, rtt, probes) {
  for (let i = 0; i < 3; i++) c.send({ t: 'ping', c: i, rtt });
  c.send({ t: 'regions', ms: probes });
}

// Probe results, ms. The room runs in FRA (weur); Ana and Budi are in Asia,
// Carl in Europe. Here the worst ping is 300 (two laggy); Asia's worst is 200.
const FAR = {
  ana: { rtt: 300, probes: { weur: 300, apac: 60, oc: 20, me: 250 } },
  budi: { rtt: 280, probes: { weur: 280, apac: 30, oc: 90, me: 240 } },
  carl: { rtt: 20, probes: { weur: 20, apac: 200, oc: 290, me: 90 } },
};
const NEAR = { weur: 20, eeur: 45, apac: 300, oc: 320 };

async function records() {
  return (await (await fetch(`${NETLOG}/records`)).json()).filter(entry => entry.game === 'tung').map(entry => entry.record);
}

// ---------------------------------------------------------------------------
// tests

async function testPing(code) {
  const response = await fetch(`${HTTP}/ping?room=${code}`);
  ok(response.status === 200, `/ping answers 200 (${response.status})`);
  ok(response.headers.get('access-control-allow-origin') === '*', '/ping allows any origin');
  ok(response.headers.get('cache-control') === 'no-store', '/ping is not cached');
  const body = await response.json();
  ok(body.colo === 'FRA' && body.region === 'weur', `/ping names the room's colo and region (${JSON.stringify(body)})`);
  ok((await fetch(`${HTTP}/ping?room=ab`)).status === 400, '/ping refuses a malformed room code');
  ok((await fetch(`${HTTP}/ping?room=${code}&shard=nowhere`)).status === 400, '/ping refuses a malformed shard');
  // Internal routes are never forwarded from outside.
  const adopt = await fetch(`${HTTP}/_adopt`, { method: 'POST', body: '{}' });
  ok(adopt.status === 426, `POST /_adopt from outside does not reach a room (${adopt.status})`);
  const released = await fetch(`${HTTP}/_released?code=${code}`, { method: 'POST', body: '{}' });
  ok(released.status === 426, `POST /_released from outside does not reach a room (${released.status})`);
}

async function testMove() {
  const carl = await create('Carl', { country: 'DE' });
  const code = carl.code;
  await testPing(code);
  const ana = await joined(await join(code, 'Ana', { country: 'ID' }));
  const budi = await joined(await join(code, 'Budi', { country: 'SG' }));
  const players = { ana, budi, carl };
  for (const [name, c] of Object.entries(players)) report(c, FAR[name].rtt, FAR[name].probes);
  await sleep(300);
  carl.send({ t: 'start' });

  const moves = {};
  for (const [name, c] of Object.entries(players)) moves[name] = await c.wait('move');
  const shard = moves.carl.shard;
  ok(/^apac-[a-z0-9]{6}$/.test(shard), `the room moves to Asia (${shard})`);
  ok(Object.values(moves).every(m => m.shard === shard && m.region === 'apac'), 'everyone is sent to the same shard');
  ok(Object.values(moves).every(m => /^[a-z0-9]{16}$/.test(m.ticket)), 'each player gets a ticket');
  ok(new Set(Object.values(moves).map(m => m.ticket)).size === 3, 'tickets are distinct');
  ok(!Object.values(players).some(c => c.msgs.some(m => m.t === 'begin')), 'the night does not begin in the old room');
  const closed = await carl.waitClosed();
  ok(closed?.code === 4000 && closed.reason === 'moved', `old sockets close with 4000 "moved" (${JSON.stringify(closed)})`);

  // Back in their seats on the shard.
  const again = {};
  for (const [name, c] of Object.entries(players)) {
    again[name] = await join(code, name, { country: c === carl ? 'DE' : c === ana ? 'ID' : 'SG' },
      `&shard=${shard}&ticket=${moves[name].ticket}`);
  }
  for (const [name, c] of Object.entries(again)) {
    const welcome = await c.wait('welcome');
    ok(welcome.you === players[name].you && welcome.code === code, `${name} keeps seat ${players[name].you} (${welcome.you})`);
  }
  const begins = {};
  for (const [name, c] of Object.entries(again)) begins[name] = await c.wait('begin', 4000);
  ok(Object.values(begins).every(b => b.seed === begins.carl.seed), 'the night begins on the shard for everyone');
  ok(begins.carl.players.filter(p => !p.bot).map(p => p.id).sort().join() === Object.values(players).map(c => c.you).sort().join(),
    'the shard starts with the same players');

  const shardPing = await (await fetch(`${HTTP}/ping?room=${code}&shard=${shard}`)).json();
  ok(shardPing.colo === 'FRA', `/ping reaches the shard (${JSON.stringify(shardPing)})`);

  // A late joiner to the old code is sent on, without a ticket.
  const dina = await join(code, 'Dina', { country: 'AU' });
  const redirect = await dina.wait('move');
  ok(redirect.shard === shard && redirect.region === 'apac' && !redirect.ticket, 'a late joiner to the old code is sent to the shard');
  dina.close();
  const dina2 = await join(code, 'Dina', { country: 'AU' }, `&shard=${shard}`);
  const refused = await dina2.wait('err');
  ok(/already started/.test(refused.m), `on the shard the late joiner sees the running night (${refused.m})`);

  // Let the night run long enough to be logged, then the Tung walks out.
  await sleep(10500);
  const tungName = Object.keys(again).find(name => players[name].you === begins.carl.tung);
  again[tungName].send({ t: 'leave' });
  again[tungName].close();
  const rest = Object.entries(again).filter(([name]) => name !== tungName).map(([, c]) => c);
  await rest[0].wait('over');

  // Back in the shard's lobby a late joiner (sent on from the old code) gets in.
  const host = rest.find(c => c.you === Math.min(...rest.map(r => r.you))) || rest[0];
  for (const c of rest) c.send({ t: 'again' });
  await host.wait('lobby');
  const erin = await join(code, 'Erin', { country: 'NZ' });
  const erinMove = await erin.wait('move');
  erin.close();
  const erin2 = await joined(await join(code, 'Erin', { country: 'NZ' }, `&shard=${erinMove.shard}`));
  const lobby = await erin2.wait('lobby');
  ok(lobby.code === code && lobby.players.length === 3, `a late joiner lands in the shard's lobby (${lobby.players.length} players)`);

  // When the shard empties, the old code is released and works normally.
  for (const c of [...rest, erin2]) { c.send({ t: 'leave' }); c.close(); }
  await sleep(1500);
  const after = await join(code, 'Fay', { country: 'AU' });
  const answer = await Promise.race([after.wait('move').then(() => 'move'), after.wait('err').then(m => m.m)]);
  ok(answer === 'no lobby with that code', `after the shard empties the old code is free (${answer})`);
  after.close();
  return { code, shard };
}

async function testStay() {
  const ana = await create('Ana', { country: 'FR' });
  const code = ana.code;
  const budi = await joined(await join(code, 'Budi', { country: 'BE' }));
  // Connecting directly, not through games-guard: the country header is ignored.
  const carl = await joined(await join(code, 'Carl', { country: 'ZZ', proxied: false }));
  report(ana, 20, NEAR);
  report(budi, 25, { ...NEAR, weur: 25 });
  report(carl, 30, { ...NEAR, weur: 30 });
  await sleep(300);
  ana.send({ t: 'start' });
  const begin = await ana.wait('begin');
  ok(!!begin && !ana.msgs.some(m => m.t === 'move') && !budi.msgs.some(m => m.t === 'move'), 'a same-region group starts where it is');
  await budi.wait('begin');
  await sleep(10500);
  const tung = [ana, budi, carl].find(c => c.you === begin.tung);
  tung.send({ t: 'leave' });
  tung.close();
  await [ana, budi, carl].find(c => c !== tung).wait('over');
  for (const c of [ana, budi, carl]) c.close();
  return { code };
}

async function main() {
  await startServers();
  try {
    const [moved, stayed] = await Promise.all([testMove(), testStay()]);
    await sleep(1000);
    const logs = await records();
    const movedRecord = logs.find(r => r.code === moved.code);
    const stayedRecord = logs.find(r => r.code === stayed.code);
    ok(!!movedRecord, 'the moved night is logged');
    ok(!!stayedRecord, 'the unmoved night is logged');
    if (movedRecord) {
      ok(movedRecord.region === 'apac', `moved record region (${movedRecord.region})`);
      ok(movedRecord.moved?.from === 'FRA' && movedRecord.moved?.to === 'apac', `moved record says where from and to (${JSON.stringify(movedRecord.moved)})`);
      const countries = Object.fromEntries(movedRecord.seats.map(s => [s.name, s.country]));
      ok(countries.Ana === 'ID' && countries.Budi === 'SG' && countries.Carl === 'DE', `moved record has each country (${JSON.stringify(countries)})`);
      ok(movedRecord.seats.every(s => s.edge === 'TST'), 'moved record has each edge');
    }
    if (stayedRecord) {
      ok(stayedRecord.region === 'weur', `unmoved record region (${stayedRecord.region})`);
      ok(stayedRecord.moved === null, `unmoved record has moved: null (${JSON.stringify(stayedRecord.moved)})`);
      const countries = Object.fromEntries(stayedRecord.seats.map(s => [s.name, s.country]));
      ok(countries.Ana === 'FR' && countries.Budi === 'BE', `proxied players' countries come from games-guard (${JSON.stringify(countries)})`);
      ok(countries.Carl !== 'ZZ', `a direct player's country header is ignored (${countries.Carl})`);
    }
  } finally {
    stopServers();
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => { console.error(error); stopServers(); process.exit(1); });
