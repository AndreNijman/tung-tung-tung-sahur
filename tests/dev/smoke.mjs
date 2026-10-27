// Dev join in real browsers (headless Chromium), against wrangler dev.
//
// A host and a guest start a night in a password-locked lobby from the public
// UI. A third page then opens the admin page's link,
// https://tung.andrenijman.com/?join=CODE, mid-night: Playwright serves that
// origin from this checkout and answers games-guard's /_guard/dev with a pass
// signed by a key made here (the host and guest get {dev:false}); the relay
// (wrangler dev on 8816, inspector 9316) trusts that key through
// DEV_TEST_PUBLIC_KEY, and the pages reach it through window.TUNG_RELAY_URL.
// Every page shows "DEV TESTER HAS JOINED", the dev is in the night as a
// survivor and the others' rosters grow to three. The same link without a
// pass is an ordinary join and is refused. Screenshots go to shots/dev-*.png.
//
//   node tests/dev/smoke.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { signDevPass } from '../../worker/netdev.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELAY_PORT = 8816;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const HOST = 'tung.andrenijman.com';
const SHOTS = path.join(ROOT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64url');

const registry = mkdtempSync(path.join(tmpdir(), 'tung-dev-smoke-'));
const wrangler = existsSync(path.join(ROOT, 'node_modules/.bin/wrangler')) ? [path.join(ROOT, 'node_modules/.bin/wrangler')] : ['npx', 'wrangler'];
const relay = spawn(wrangler[0], [...wrangler.slice(1), 'dev', '--ip', '127.0.0.1', '--port', String(RELAY_PORT), '--inspector-port', '9316',
  '--var', `DEV_TEST_PUBLIC_KEY:${publicKey}`, '--var', 'DEV_COLO:FRA'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], detached: true,
  env: { ...process.env, WRANGLER_REGISTRY_PATH: registry, WRANGLER_SEND_METRICS: 'false' },
});
const stop = () => {
  try { process.kill(-relay.pid, 'SIGTERM'); } catch { /* gone */ }
  try { rmSync(registry, { recursive: true, force: true }); } catch { /* in use */ }
};
process.on('exit', stop);

async function ready(url) {
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`${url} never became ready`);
}

const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };
const page = readFileSync(path.join(ROOT, 'index.html'));
let browser;

// https://tung.andrenijman.com as games-guard serves it, from this checkout.
async function guardContext(dev, savedName) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
  await context.addInitScript(([relayUrl, name]) => {
    window.TUNG_RELAY_URL = relayUrl;
    if (name) localStorage.setItem('tung-identity', JSON.stringify({ name, relay: relayUrl }));
  }, [`ws://127.0.0.1:${RELAY_PORT}/ws`, savedName || '']);
  await context.route(`https://${HOST}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/_guard/dev') {
      if (!dev) return route.fulfill({ json: { dev: false } });
      const { pass, exp } = await signDevPass(privateKey, { name: dev, host: HOST });
      return route.fulfill({ json: { dev: true, name: dev.toUpperCase(), pass, exp } });
    }
    if (url.pathname === '/_guard/status') return route.fulfill({ json: { signedIn: false } });
    if (url.pathname.startsWith('/_guard/')) return route.fulfill({ status: 503, body: '' });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  return context;
}
async function open(label, context, url) {
  const tab = await context.newPage();
  tab.on('pageerror', e => problems.push(`${label} page error: ${e.message}`));
  tab.on('console', m => {
    // The stubbed-out guard endpoints (probes, lobby list) answer 503 on purpose.
    if (m.type() === 'error' && !String(m.location()?.url || '').includes('/_guard/')) problems.push(`${label} console: ${m.text()}`);
  });
  await tab.goto(url);
  return tab;
}

try {
  await ready(`${RELAY}/health`);
  // The pages are https://tung.andrenijman.com talking to a relay on 127.0.0.1;
  // Chromium's Local Network Access check would block that, production never meets it.
  browser = await chromium.launch({ headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });

  const host = await open('host', await guardContext(null), `https://${HOST}/`);
  const guest = await open('guest', await guardContext(null), `https://${HOST}/`);
  for (const [tab, name] of [[host, 'Host'], [guest, 'Guest']]) {
    await tab.click('#b-play-menu');
    await tab.click('#b-mp');
    await tab.fill('#i-name', name);
    await tab.fill('#i-password', 'hunter2');
  }
  check(!(await host.evaluate(() => devAdmin)), 'a non-dev page thinks it is admin');
  await host.click('#b-create');
  await host.waitForSelector('#scr-lobby.on', { timeout: 15000 });
  const code = (await host.textContent('#lobby-code')).trim();
  await guest.fill('#i-code', code);
  await guest.click('#b-join');
  await guest.waitForSelector('#scr-lobby.on', { timeout: 15000 });
  await host.waitForFunction(() => net?.players.size === 2, null, { timeout: 10000 });
  await host.click('#b-start');
  for (const tab of [host, guest]) await tab.waitForFunction(() => net?.phase === 'play' && game.state === 'play', null, { timeout: 20000 });
  const hostPlayer = await host.evaluate(() => window.__gamesPlayer);
  check(hostPlayer?.name === 'Host' && hostPlayer.room === code, `the host's window.__gamesPlayer is ${JSON.stringify(hostPlayer)}`);
  await sleep(1000);

  // The dev opens the admin page's link: a locked lobby whose night is running.
  const dev = await open('dev', await guardContext('Tester', 'Andre'), `https://${HOST}/?join=${encodeURIComponent(code)}`);
  const pages = { host, guest, dev };
  await Promise.all(Object.entries(pages).map(([label, tab]) => tab.waitForFunction(() => {
    const banner = document.getElementById('dev-joined-banner');
    return banner && banner.textContent === 'DEV TESTER HAS JOINED' && getComputedStyle(banner).opacity === '1';
  }, null, { timeout: 15000 }).catch(() => problems.push(`${label} never showed "DEV TESTER HAS JOINED"`))));
  await Promise.all(Object.entries(pages).map(([label, tab]) => tab.screenshot({ path: path.join(SHOTS, `dev-joined-${label}.png`) })));

  // The night adjusted: the dev is in it as a survivor, and everyone's roster has three.
  await dev.waitForFunction(() => net?.phase === 'play' && game.state === 'play', null, { timeout: 10000 })
    .catch(() => problems.push('the dev is not in the running night'));
  const devState = await dev.evaluate(() => ({
    role: net?.players.get(net.you)?.role, admin: net?.players.get(net.you)?.admin, devAdmin,
    url: location.search, player: window.__gamesPlayer, panel: document.getElementById('pause-admin').classList.contains('on'),
  }));
  check(devState.role === 'survivor' && devState.admin === true, `the dev's seat is ${JSON.stringify(devState)}`);
  check(devState.devAdmin === true, 'the dev page did not take its dev pass as admin');
  check(devState.url === '', `?join= was not cleared (${devState.url})`);
  check(devState.player?.name === 'Andre' && devState.player.room === code, `the dev's window.__gamesPlayer is ${JSON.stringify(devState.player)}`);
  for (const [label, tab] of [['host', host], ['guest', guest]]) {
    await tab.waitForFunction(() => [...net.players.values()].filter(p => !p.bot).length === 3
      && [...net.players.values()].some(p => p.admin && p.role === 'survivor'), null, { timeout: 8000 })
      .catch(() => problems.push(`${label}'s roster does not have the dev as a survivor`));
  }
  // The dev is drawn in the night (the snapshot loop places their body for the others).
  await host.waitForFunction(() => [...net.players.values()].some(p => p.admin && Array.isArray(p.pos)), null, { timeout: 8000 })
    .catch(() => problems.push('the host has no position for the dev'));
  // The dev's admin panel works from the pause menu.
  await dev.evaluate(() => pauseGame());
  await dev.waitForSelector('#pause-admin.on', { timeout: 5000 }).catch(() => problems.push('the dev has no admin panel in the pause menu'));
  check((await guest.evaluate(() => devAdmin)) === false, 'the guest page thinks it is admin');
  // The same link without a dev pass is a normal join: the running night refuses it.
  const stranger = await open('stranger', await guardContext(null, 'Stranger'), `https://${HOST}/?join=${encodeURIComponent(code)}`);
  await stranger.waitForFunction(() => document.getElementById('scr-mp').classList.contains('on')
    && /already started/.test(document.getElementById('mp-err').textContent), null, { timeout: 10000 })
    .catch(async () => problems.push(`a non-dev ?join= was not refused normally (${await stranger.textContent('#mp-err')})`));
  check((await stranger.inputValue('#i-code')) === code, 'a non-dev ?join= did not fill in the code');
  check(!(await stranger.evaluate(() => document.getElementById('dev-joined-banner')?.style.opacity === '1')), 'a refused non-dev saw the dev banner');
  await sleep(4500);
  await Promise.all(Object.entries(pages).map(([label, tab]) => tab.screenshot({ path: path.join(SHOTS, `dev-night-${label}.png`) })));
} catch (error) {
  problems.push(error.stack || error.message);
} finally {
  await browser?.close();
  stop();
}

if (problems.length) {
  console.log('FAIL');
  for (const problem of problems) console.log(`  ${problem}`);
  process.exit(1);
}
console.log('dev join smoke passed (screenshots in shots/dev-*.png)');
process.exit(0);
