// Dev join against wrangler dev (worker/relay.js), with a throwaway key.
//
// A dev pass (netdev.js) signed here, with DEV_TEST_PUBLIC_KEY telling the
// relay to trust this test's key, lets a dev into a locked lobby, a full
// lobby and a running night (as a survivor, the roster growing for everyone),
// and every client gets {t:'dev-joined', name}. Forged, expired and
// other-host passes, a bare dev:true and the old X-Tung-Admin header are
// normal players and get the old refusals. Nobody votes a dev out or kicks
// them; a dev keeps the admin panel's powers. /admin/lobbies answers only
// through games-guard (proxy secret plus a dev name). Also checks that the
// relay's and the page's copies of netdev.js are the shared one, unchanged.
//
// Starts its own relay on 8814 (inspector 9314) with a private registry:
//   node tests/dev/dev-join.test.mjs
// WRANGLER picks the wrangler binary (default: node_modules/.bin/wrangler, then npx).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { signDevPass } from '../../worker/netdev.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELAY_PORT = 8814;
const HTTP = `http://127.0.0.1:${RELAY_PORT}`;
const WS = `ws://127.0.0.1:${RELAY_PORT}/ws`;
const SECRET = 'dev-join-test-secret';
const HOST = 'tung.andrenijman.com';
const CANONICAL = '/var/tmp/games-guard-deploy/shared/net/netdev.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let pass = 0, fail = 0;
function ok(condition, message) {
  if (condition) pass++;
  else { fail++; console.log('FAIL:', message); }
}

// ---------------------------------------------------------------------------
// netdev.js copies

function testCopies() {
  const relayCopy = readFileSync(path.join(ROOT, 'worker/netdev.js'), 'utf8');
  if (existsSync(CANONICAL)) ok(readFileSync(CANONICAL, 'utf8') === relayCopy, 'worker/netdev.js is byte-identical to games-site shared/net/netdev.js');
  // index.html inlines it like netprobe.js: only `export ` dropped, inside a function.
  const page = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const open = 'const { devPass, joinCode, clearJoinCode, setPlayer, showDevJoined } = (() => {\n';
  const close = '\nreturn { devPass, joinCode, clearJoinCode, setPlayer, showDevJoined };\n})();';
  const start = page.indexOf(open), end = page.indexOf(close);
  const inlined = start >= 0 && end > start ? page.slice(start + open.length, end) : '';
  ok(inlined === relayCopy.replace(/^export /gm, ''), 'index.html inlines netdev.js unchanged (only `export ` dropped)');
}

// ---------------------------------------------------------------------------
// keys and passes

const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const b64 = async (format, key) => Buffer.from(await crypto.subtle.exportKey(format, key)).toString('base64url');
const PUBLIC_KEY = await b64('raw', pair.publicKey);
const PRIVATE_KEY = await b64('pkcs8', pair.privateKey);
const OTHER_PRIVATE_KEY = await b64('pkcs8', other.privateKey);

const devPass = async (name = 'Andre') => (await signDevPass(PRIVATE_KEY, { name, host: HOST })).pass;
const BAD_PASSES = {
  forged: async () => (await signDevPass(OTHER_PRIVATE_KEY, { name: 'Andre', host: HOST })).pass,
  expired: async () => (await signDevPass(PRIVATE_KEY, { name: 'Andre', host: HOST, now: Date.now() - 20 * 60_000 })).pass,
  'other host': async () => (await signDevPass(PRIVATE_KEY, { name: 'Andre', host: 'fart.andrenijman.com' })).pass,
  'bare dev:true': async () => true,
};

// ---------------------------------------------------------------------------
// server

let server = null, registry = '';
async function up(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}
function wranglerBin() {
  if (process.env.WRANGLER) return [process.env.WRANGLER];
  const local = path.join(ROOT, 'node_modules/.bin/wrangler');
  return existsSync(local) ? [local] : ['npx', 'wrangler'];
}
async function startServer() {
  const [bin, ...pre] = wranglerBin();
  registry = mkdtempSync(path.join(tmpdir(), 'tung-dev-registry-'));
  server = spawn(bin, [...pre, 'dev', '--port', String(RELAY_PORT), '--inspector-port', '9314', '--ip', '127.0.0.1',
    '--var', `DEV_TEST_PUBLIC_KEY:${PUBLIC_KEY}`, '--var', `TUNG_PROXY_SECRET:${SECRET}`, '--var', 'DEV_COLO:FRA'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], detached: true,
    env: { ...process.env, WRANGLER_REGISTRY_PATH: registry, WRANGLER_SEND_METRICS: 'false' },
  });
  if (!(await up(`${HTTP}/health`))) throw new Error('wrangler dev did not come up');
}
function stopServer() {
  if (server) try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
  if (registry) try { rmSync(registry, { recursive: true, force: true }); } catch { /* still in use */ }
}

// ---------------------------------------------------------------------------
// clients

function client(query, headers = {}) {
  const ws = new WebSocket(`${WS}?${query}`, { headers: { Origin: 'http://localhost', ...headers } });
  const c = { ws, msgs: [], waiters: [], closed: null };
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.t === 'pong' || msg.t === 'snap') { if (msg.t === 'snap') c.snap = msg; return; }
    const waiter = c.waiters.find(w => w.type === msg.t);
    if (waiter) { c.waiters = c.waiters.filter(w => w !== waiter); waiter.resolve(msg); } else c.msgs.push(msg);
  });
  ws.addEventListener('close', event => { c.closed = { code: event.code, reason: event.reason }; });
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
const clients = [];
async function create(name, extra = {}) {
  const c = client('create=1');
  clients.push(c);
  await c.opened;
  c.send({ t: 'create', name, settings: { tungs: 1 }, ...extra });
  const welcome = await c.wait('welcome');
  c.you = welcome.you; c.code = welcome.code;
  await c.wait('lobby');
  return c;
}
async function join(code, name, extra = {}, headers = {}) {
  const c = client(`code=${code}`, headers);
  clients.push(c);
  await c.opened;
  c.send({ t: 'join', code, name, ...extra });
  return c;
}
async function joined(c) {
  c.you = (await c.wait('welcome')).you;
  return c;
}
// The first answer to a join: 'welcome' or the refusal's text.
async function answer(c) {
  return Promise.race([c.wait('welcome').then(() => 'welcome'), c.wait('err').then(m => m.m)]);
}
const lastOf = (c, type) => c.msgs.filter(m => m.t === type).at(-1);
const devJoinedFor = async (c, name) => {
  try { return (await c.wait('dev-joined', 4000)).name === name; } catch { return false; }
};

// ---------------------------------------------------------------------------
// tests

async function testLocked() {
  const host = await create('Host', { password: 'hunter2' });
  // Every bad pass is a normal player: the wrong-password refusal, as before.
  for (const [label, make] of Object.entries(BAD_PASSES)) {
    const c = await join(host.code, `Bad ${label}`, { dev: await make() });
    const got = await answer(c);
    ok(got === 'wrong lobby password', `a ${label} pass is refused from a locked lobby (${got})`);
    c.close();
  }
  // So is the header the relay used to trust from its own front door.
  const header = await join(host.code, 'Header', {}, { 'X-Tung-Admin': '1', 'X-Tung-Admin-Name': 'andrenijman' });
  ok(await answer(header) === 'wrong lobby password', 'an X-Tung-Admin header does not make an admin');
  header.close();

  const dev = await join(host.code, 'Andre', { dev: await devPass() });
  ok(await answer(dev) === 'welcome', 'a dev joins a locked lobby without the password');
  const lobby = await host.wait('lobby');
  const seat = lobby.players.find(p => p.name === 'Andre');
  ok(seat?.admin === true, 'the dev is marked admin in the lobby');
  ok(await devJoinedFor(host, 'ANDRE'), 'the host gets {t:"dev-joined", name:"ANDRE"}');
  ok(await devJoinedFor(dev, 'ANDRE'), 'the dev gets {t:"dev-joined", name:"ANDRE"} too');
  for (const c of [host, dev]) c.close();
}

async function testFull() {
  const host = await create('Host');
  const guests = [];
  for (let i = 1; i < 10; i++) guests.push(await joined(await join(host.code, `Guest${i}`)));
  const late = await join(host.code, 'Late');
  ok(await answer(late) === 'lobby is full (10)', 'an eleventh player is refused');
  const forged = await join(host.code, 'Forged', { dev: await BAD_PASSES.forged() });
  ok(await answer(forged) === 'lobby is full (10)', 'an eleventh player with a forged pass is refused');
  const dev = await join(host.code, 'Andre', { dev: await devPass() });
  ok(await answer(dev) === 'welcome', 'a dev joins a full lobby');
  const everyone = [host, ...guests, dev];
  const told = await Promise.all(everyone.map(c => devJoinedFor(c, 'ANDRE')));
  ok(told.every(Boolean), `all eleven get dev-joined (${told.filter(Boolean).length}/11)`);
  const lobby = lastOf(host, 'lobby') || await host.wait('lobby');
  ok(lobby.players.length === 11, `the lobby lists eleven players (${lobby.players.length})`);
  for (const c of everyone) c.close();
}

async function testRunning() {
  const host = await create('Host');
  const guest = await joined(await join(host.code, 'Guest'));
  await sleep(200);
  host.send({ t: 'start' });
  const begin = await host.wait('begin');
  await guest.wait('begin');
  const tungId = begin.tung;

  for (const [label, make] of Object.entries(BAD_PASSES)) {
    const c = await join(host.code, `Bad ${label}`, { dev: await make() });
    const got = await answer(c);
    ok(got === 'that night has already started', `a ${label} pass is refused from a running night (${got})`);
    c.close();
  }

  const dev = await join(host.code, 'Andre', { dev: await devPass() });
  ok(await answer(dev) === 'welcome', 'a dev joins a running night');
  const devBegin = await dev.wait('begin');
  const me = devBegin.players.find(p => p.name === 'Andre');
  ok(devBegin.how === 'admin-join' && devBegin.seed === begin.seed, 'the dev gets the running night (same seed, how admin-join)');
  ok(me?.role === 'survivor' && me.admin === true && me.spawn, `the dev spawns as a survivor (${JSON.stringify(me && { role: me.role, admin: me.admin })})`);
  for (const [label, c] of [['host', host], ['guest', guest]]) {
    const roster = await c.wait('roster');
    const seat = roster.players.find(p => p.id === me?.id);
    ok(roster.players.filter(p => !p.bot).length === 3 && seat?.role === 'survivor', `the ${label}'s roster grows to three with the dev as a survivor`);
  }
  for (const [label, c] of [['host', host], ['guest', guest], ['dev', dev]]) {
    ok(await devJoinedFor(c, 'ANDRE'), `the ${label} gets dev-joined with the dev's name`);
  }
  // (No client sends the map's manifest here, so the night never ticks; the
  // dev's own first snapshot is the one joinRunningGame sends.)
  ok(dev.snap?.p?.some(row => row[0] === me?.id && row[2] === 1) && dev.snap.p.some(row => row[0] === host.you),
    `the dev's snapshot carries the dev, alive, and the others (${JSON.stringify(dev.snap?.p?.map(r => r.slice(0, 3)))})`);

  // Neither the host nor the guest can vote the dev out, or kick them.
  host.send({ t: 'votekick', id: me.id });
  guest.send({ t: 'votekick', id: me.id });
  host.send({ t: 'admin-kick', id: me.id });
  await sleep(600);
  const kickEvents = [...host.msgs, ...guest.msgs].filter(m => m.t === 'ev' && m.e === 'votekick' && m.who === me.id);
  ok(kickEvents.length === 0, `a vote to kick the dev is ignored (${kickEvents.length} events)`);
  ok(!dev.closed && !dev.msgs.some(m => m.t === 'ev' && m.e === 'kicked'), 'the dev is still in the night');

  // The dev keeps the admin panel: removing a survivor.
  const survivor = [host, guest].find(c => c.you !== tungId);
  dev.send({ t: 'admin-kick', id: survivor.you });
  const closed = await survivor.waitClosed();
  ok(closed?.code === 1008 && survivor.msgs.some(m => m.t === 'ev' && m.e === 'kicked'), `the dev can still remove a player (${JSON.stringify(closed)})`);

  // /admin/lobbies, only through games-guard with a dev's name.
  const list = headers => fetch(`${HTTP}/admin/lobbies`, { headers });
  ok((await list({})).status === 403, '/admin/lobbies refuses a direct request');
  ok((await list({ 'X-Tung-Proxy-Admin-Name': 'ANDRE' })).status === 403, '/admin/lobbies refuses a name without the proxy secret');
  ok((await list({ 'X-Tung-Proxy-Authorization': `Bearer ${SECRET}`, 'X-Tung-Proxy-Admin-Name': '' })).status === 403,
    '/admin/lobbies refuses the proxy without a dev name');
  ok((await list({ 'X-Tung-Proxy-Authorization': 'Bearer wrong', 'X-Tung-Proxy-Admin-Name': 'ANDRE' })).status === 403,
    '/admin/lobbies refuses a wrong proxy secret');
  const allowed = await list({ 'X-Tung-Proxy-Authorization': `Bearer ${SECRET}`, 'X-Tung-Proxy-Admin-Name': 'ANDRE' });
  const body = allowed.ok ? await allowed.json() : {};
  ok(allowed.status === 200 && body.lobbies?.some(l => l.code === host.code && l.phase === 'play'),
    `/admin/lobbies lists the running night for a proxied dev (${allowed.status})`);
  const open = await (await fetch(`${HTTP}/lobbies`)).json();
  ok(!open.lobbies.some(l => l.code === host.code), 'the public list still hides the running night');
  for (const c of [host, guest, dev]) c.close();
}

async function testCreate() {
  const dev = await create('Andre', { dev: await devPass('mechtical') });
  ok(await devJoinedFor(dev, 'MECHTICAL'), 'a dev who creates a lobby gets dev-joined');
  const guest = await joined(await join(dev.code, 'Guest'));
  const lobby = await guest.wait('lobby');
  ok(lobby.players.find(p => p.id === dev.you)?.admin === true, 'a dev who created the lobby is admin there');
  ok(!guest.msgs.some(m => m.t === 'dev-joined'), 'a normal player joining causes no dev-joined');
  for (const c of [dev, guest]) c.close();
}

// ---------------------------------------------------------------------------

testCopies();
try {
  await startServer();
  await testLocked();
  await testFull();
  await testRunning();
  await testCreate();
} catch (error) {
  fail++;
  console.log('FAIL:', error.stack || error.message);
} finally {
  for (const c of clients) c.close();
  stopServer();
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
