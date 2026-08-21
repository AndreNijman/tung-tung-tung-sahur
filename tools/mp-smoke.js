#!/usr/bin/env node
//
// End-to-end multiplayer smoke test. It starts the real zero-dependency relay,
// opens five independent browser pages, and drives the public UI/protocol from
// lobby creation through an authoritative catch. No relay internals are
// imported or patched, so this catches protocol drift between index.html and
// server/relay.js.
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const urlArg = process.argv.slice(2).find(arg => /^https?:\/\//.test(arg));
const relayArgIndex = process.argv.indexOf('--relay');
const relayOverride = relayArgIndex >= 0 ? process.argv[relayArgIndex + 1] : null;
const LIVE = !!urlArg;
const URL = urlArg || `http://127.0.0.1:${PORT}/`;

async function waitForRelay() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${URL}health`);
      if (r.ok) return;
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('relay did not start');
}

// Move at a server-legal pace and send the same packets the frame loop sends.
// This intentionally does not call relay internals; it only avoids spending a
// smoke test teaching a bot to turn each maze corner.
async function moveTo(page, x, y, movingFlags = 1) {
  await page.evaluate(async ({ x, y, movingFlags }) => {
    const sx = game.px, sy = game.py;
    const dist = Math.hypot(x - sx, y - sy);
    const steps = Math.max(1, Math.ceil(dist / 0.105));
    net.sendT = 999;
    for (let i = 1; i <= steps; i++) {
      game.px = sx + (x - sx) * i / steps;
      game.py = sy + (y - sy) * i / steps;
      game.isMoving = !!(movingFlags & 1);
      game.isSprinting = !!(movingFlags & 2);
      net.send({ t: 'in', x: game.px, y: game.py, a: game.angle, f: movingFlags });
      await new Promise(resolve => setTimeout(resolve, 45));
    }
    game.isMoving = false; game.isSprinting = false;
    net.send({ t: 'in', x: game.px, y: game.py, a: game.angle, f: game.hidden ? 4 : 0 });
    net.sendT = 0;
  }, { x, y, movingFlags });
}

(async () => {
  const relay = LIVE ? null : spawn(process.execPath, ['server/relay.js', '--serve', '.', '--port', String(PORT)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let relayErr = '';
  if (relay) relay.stderr.on('data', d => { relayErr += d.toString(); });

  let browser;
  const problems = [];
  try {
    if (LIVE) {
      const response = await fetch(URL);
      if (!response.ok) throw new Error(`live page returned ${response.status}`);
    } else await waitForRelay();
    browser = await chromium.launch({ headless: !process.argv.includes('--headed') });

    async function openPlayer(name) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
      page.on('pageerror', e => problems.push(`${name} page error: ${e.message}`));
      page.on('console', m => { if (m.type() === 'error') problems.push(`${name} console: ${m.text()}`); });
      page.on('requestfailed', r => problems.push(`${name} request failed: ${r.url()}`));
      await page.goto(URL);
      await page.click('#b-mp');
      await page.fill('#i-name', name);
      if (relayOverride) {
        await page.locator('#i-relay').evaluate(input => { input.closest('details').open = true; });
        await page.fill('#i-relay', relayOverride);
      }
      return page;
    }

    async function listedLobby(page, code) {
      await page.click('#b-refresh-lobbies');
      await page.waitForFunction((wanted) =>
        [...document.querySelectorAll('.lobby-code')].some(el => el.textContent === wanted), code);
      return page.locator('.lobby-row').filter({ hasText: code });
    }
    async function fillPassword(page, value) {
      await page.fill('#i-password', value);
      if (await page.inputValue('#i-password') !== value) await page.fill('#i-password', value);
    }

    const password = 'nightfall';
    const host = await openPlayer('Host');
    await host.evaluate(() => {
      profile.equipped = { hat: 'hat-crown', shirtPattern: 'pattern-batik', tung: 'tung-bombardiro' };
    });
    await fillPassword(host, password);
    await host.click('#b-create');
    await host.waitForSelector('#scr-lobby.on');
    const code = (await host.textContent('#lobby-code')).trim();
    console.log(`  lobby: ${code}`);

    // Public listing exposes the room and lock state, but a bad password is
    // rejected before the player consumes a slot.
    const wrong = await openPlayer('WrongPassword');
    const wrongRow = await listedLobby(wrong, code);
    if (!(await wrongRow.textContent()).includes('LOCKED')) problems.push('protected lobby was not marked LOCKED');
    await fillPassword(wrong, 'not-it');
    await wrongRow.locator('button').click();
    await wrong.waitForFunction(() => document.getElementById('mp-err').textContent.includes('wrong lobby password'));
    await wrong.close();

    const guests = [];
    const first = await openPlayer('Guest1');
    const firstRow = await listedLobby(first, code);
    await fillPassword(first, password);
    await firstRow.locator('button').click();
    await first.waitForSelector('#scr-lobby.on');
    guests.push(first);

    for (let i = 2; i <= 9; i++) {
      const page = await openPlayer(`Guest${i}`);
      await page.fill('#i-code', code);
      await fillPassword(page, password);
      if ((await page.inputValue('#i-code')).trim() !== code) await page.fill('#i-code', code);
      await page.click('#b-join');
      try {
        await page.waitForSelector('#scr-lobby.on');
      } catch (e) {
        const state = await page.evaluate(() => ({
          error: document.getElementById('mp-err').textContent,
          screen: document.querySelector('.scr.on')?.id,
          ready: net?.ws?.readyState, phase: net?.phase,
        }));
        throw new Error(`Guest${i} failed to join: ${JSON.stringify(state)}; relay=${relayErr.trim() || 'no stderr'}; ${e.message}`);
      }
      guests.push(page);
    }
    await host.waitForFunction(() => net && net.players.size === 10);

    // A half-closed tab used to ghost in a lobby until two ping cycles elapsed,
    // holding both its slot and (if host) the start button. Refill the tenth
    // slot immediately to pin socket `end` handling.
    await guests.pop().close();
    await host.waitForFunction(() => net.players.size === 9);
    const replacement = await openPlayer('Guest9');
    await replacement.fill('#i-code', code);
    await fillPassword(replacement, password);
    if ((await replacement.inputValue('#i-code')).trim() !== code) await replacement.fill('#i-code', code);
    await replacement.click('#b-join');
    await replacement.waitForSelector('#scr-lobby.on');
    guests.push(replacement);
    await host.waitForFunction(() => net.players.size === 10);
    const pages = [host, ...guests];
    if ((await host.locator('#lobby-players li').count()) !== 10) problems.push('lobby did not reach 10/10');

    // Host-controlled settings, including the three requested lobby dials.
    for (const [index, value, key] of [
      [0, '15', 'mapN'], [1, '2', 'lanterns'], [2, '120', 'night'],
      [3, '0', 'torch'], [4, 'high', 'stamina'], [5, 'false', 'tungIntel'], [6, '1', 'tungs'], [7, 'normal', 'tracks'],
    ]) {
      await host.locator('#lobby-settings select').nth(index).selectOption(value);
      await host.waitForFunction(([key, value]) => String(net.settings[key]) === value, [key, value]);
    }
    await guests[0].waitForFunction(() => net.settings.mapN === 15 && net.settings.lanterns === 2 &&
      net.settings.night === 120 && net.settings.torch === 0 && net.settings.stamina === 'high' && !net.settings.tungIntel);
    await host.locator('#lobby-settings select').nth(6).selectOption('3');
    await guests[0].waitForFunction(() => net.settings.tungs === 3);
    await host.locator('#lobby-settings select').nth(6).selectOption('1');
    await guests[0].waitForFunction(() => net.settings.tungs === 1);
    console.log('  settings: 15x15, 2 lanterns, 2:00, infinite torch, high stamina, hidden objectives');

    // Everyone votes for the host, making role selection deterministic while
    // exercising the normal vote buttons in all five pages.
    for (const page of pages) {
      await page.locator('#lobby-players li').first().locator('button').click();
    }
    await host.waitForFunction(() => [...net.players.values()].every(p => p.vote === net.you));
    await host.click('#b-start');
    await Promise.all(pages.map(p => p.waitForFunction(() => game.state === 'play' && net.phase === 'play')));
    await host.waitForTimeout(500);
    const stillListed = await host.evaluate(async (wanted) => {
      const response = await fetch(lobbyListUrl(net.url), { cache: 'no-store' });
      const data = await response.json();
      return data.lobbies.some(lobby => lobby.code === wanted);
    }, code);
    if (stillListed) problems.push('started lobby remained in the public listing');

    const roles = await Promise.all(pages.map(p => p.evaluate(() => game.role)));
    if (roles.filter(r => r === 'tung').length !== 1 || roles[0] !== 'tung') {
      problems.push(`vote did not select exactly the host as Tung: ${JSON.stringify(roles)}`);
    }
    const maps = await Promise.all(pages.map(p => p.evaluate(() => JSON.stringify({ grid: game.grid, items: game.items, hides: game.hides, pairs: game.hidePairs }))));
    if (!maps.every(m => m === maps[0])) problems.push('seeded maps differ between clients');
    const hostCosmetics = await guests[0].evaluate(() => {
      const hostPlayer = [...net.players.values()].find(player => player.role === 'tung');
      return {
        look: hostPlayer?.look,
        customSprite: getTungSprite(hostPlayer, true, false) !== SPR.creatureHunt,
      };
    });
    if (hostCosmetics.look?.hat !== 'hat-crown' || hostCosmetics.look?.shirtPattern !== 'pattern-batik' ||
        hostCosmetics.look?.tung !== 'tung-bombardiro' || !hostCosmetics.customSprite) {
      problems.push(`equipped cosmetics did not synchronize/render: ${JSON.stringify(hostCosmetics)}`);
    }
    const initial = await host.evaluate(() => ({ alive: game.alive, count: game.itemState.length, time: game.timeLeft }));
    if (!initial.alive || initial.count !== 2 || initial.time > 120 || initial.time < 115) {
      problems.push(`match did not start cleanly: ${JSON.stringify(initial)}`);
    }
    console.log(`  roles: ${roles.join(', ')}`);

    const survivor = guests[0];
    const survivorId = await survivor.evaluate(() => net.you);

    // Authoritative pickup and delivery. Mark the run as a sprint so the Tung
    // receives a proper bright footprint trail while the survivor crosses.
    const item = await survivor.evaluate(() => {
      const t = net.tungRemote().pos;
      let best = 0, bd = -1;
      for (let i = 0; i < game.itemState.length; i++) {
        const s = game.itemState[i], d = (s[2] - t[0]) ** 2 + (s[3] - t[1]) ** 2;
        if (d > bd) { bd = d; best = i; }
      }
      const s = game.itemState[best]; return { i: best, x: s[2], y: s[3] };
    });
    await moveTo(survivor, item.x, item.y, 3);
    await survivor.waitForFunction((i) => game.carrying === i, item.i);
    const surau = await survivor.evaluate(() => [...game.surau]);
    await moveTo(survivor, surau[0], surau[1], 3);
    await survivor.waitForFunction((i) => game.carrying === -1 && game.itemState[i][0] === 2, item.i);
    await host.waitForFunction((id) => {
      const tr = game.trails.get(id); return tr && tr.prints.length > 0;
    }, survivorId);
    const prints = await host.evaluate((id) => game.trails.get(id).prints.length, survivorId);
    console.log(`  relay: pickup + delivery; Tung received ${prints} delayed prints`);

    await survivor.evaluate(() => net.send({ t: 'chat', m: 'runner-only check' }));
    await guests[1].waitForFunction(() => document.getElementById('chat-log').textContent.includes('runner-only check'));
    await host.waitForFunction(() => document.getElementById('chat-log').textContent.includes('runner-only check'));
    await host.evaluate(() => { openChat(); document.getElementById('chat-input').value = 'tung-global check'; closeChat(true); });
    await guests[1].waitForFunction(() => document.getElementById('chat-log').textContent.includes('tung-global check'));

    // Paired alcove: enter one, ask the relay to swap, and verify the mover is
    // the only client that learns the destination.
    const hide = await survivor.evaluate(() => ({ p: [...game.hides[0]], to: pairOf(game.hidePairs, 0) }));
    await moveTo(survivor, hide.p[0], hide.p[1], 1);
    // Press the panic sequence back-to-back. The client must send FLAG_HIDDEN
    // before the swap request rather than relying on the next 20 Hz input tick.
    await survivor.keyboard.press('KeyE');
    await survivor.keyboard.press('KeyQ');
    await host.waitForFunction((id) => net.get(id).hidden, survivorId);
    await survivor.waitForFunction((to) => game.hidden && game.hideIdx === to && game.swapTransit === 0 && !game.swapPending, hide.to);
    const landed = await survivor.evaluate(() => ({ idx: game.hideIdx, x: game.px, y: game.py, cd: game.swapCooldown, pending: game.swapPending }));
    if (landed.idx !== hide.to || landed.cd <= 0 || landed.pending) problems.push(`paired alcove did not land/cool down: ${JSON.stringify(landed)}`);
    console.log(`  alcove: 0 -> ${hide.to}, server cooldown active`);

    // Move the real Tung onto the occupied alcove. Contact must not catch the
    // hidden survivor, but should catch immediately after they step outside.
    const target = await survivor.evaluate(() => [game.px, game.py]);
    await moveTo(host, target[0], target[1], 1);
    await survivor.waitForTimeout(250);
    if (!(await survivor.evaluate(() => game.alive))) problems.push('Tung caught a survivor inside an alcove');
    await survivor.keyboard.press('KeyE');
    await survivor.waitForFunction(() => !game.hidden);
    await survivor.waitForFunction(() => game.alive === false);
    await host.waitForFunction(() => document.getElementById('event-banner').textContent.includes('Guest1 was caught'));
    await guests[1].waitForFunction(() => document.getElementById('event-banner').textContent.includes('Guest1 was caught'));
    console.log('  catch: authoritative');

    // The Tung is the host in this round. Its disconnect must end the match and
    // expose the rematch button to the reassigned host on the result screen.
    await host.close();
    await survivor.waitForSelector('#scr-over.on');
    await survivor.waitForFunction(() => getComputedStyle(document.getElementById('b-again')).display !== 'none');
    await survivor.click('#b-again');
    await Promise.all(guests.map(p => p.waitForSelector('#scr-lobby.on')));

    // Manifest failover: suppress the new host's one-shot upload, vote the
    // second player in as Tung, start, then close the survivor host. The new
    // host must upload from its own seeded map and unfreeze the clock.
    for (const page of guests) {
      await page.locator('#lobby-players li').nth(1).locator('button').click();
    }
    await survivor.evaluate(() => { net.sendManifest = () => {}; });
    await survivor.click('#b-start');
    await Promise.all(guests.map(p => p.waitForFunction(() => game.state === 'play')));
    await survivor.close();
    const newHost = guests[1];
    await newHost.waitForFunction(() => net.host === net.you && game.timeLeft < 119);

    // Closing every remaining survivor used to strand the Tung in a live room.
    for (const page of guests.slice(2)) await page.close();
    await newHost.waitForSelector('#scr-over.on');
    const over = (await newHost.textContent('#over-title')).trim();
    if (over !== 'NIGHT ABANDONED') problems.push(`last-survivor disconnect did not end match: ${over}`);

    // Blank really is optional: an unprotected room must list as OPEN and join
    // without a password. This catches either relay accidentally hashing ''.
    const openHost = await openPlayer('OpenHost');
    await openHost.click('#b-create');
    await openHost.waitForSelector('#scr-lobby.on');
    const openCode = (await openHost.textContent('#lobby-code')).trim();
    await openHost.waitForFunction(async (wanted) => {
      const response = await fetch(lobbyListUrl(net.url), { cache: 'no-store' });
      const data = await response.json();
      const lobby = data.lobbies.find(entry => entry.code === wanted);
      return !!lobby && lobby.locked === false;
    }, openCode);
    await openHost.close();

    // Static serving must not expose the repository internals.
    const dotGit = await fetch(`${URL}.git/config`);
    if (dotGit.status !== 404) problems.push(`relay exposed .git/config (${dotGit.status})`);

    if (problems.length) {
      console.error('\nFAIL');
      for (const p of problems) console.error('  - ' + p);
      process.exitCode = 1;
    } else {
      console.log('\nPASS - listing/password, ten clients, settings/vote, trail, alcove, catch and failover');
    }
  } finally {
    if (browser) await browser.close();
    if (relay) relay.kill('SIGTERM');
    if (relayErr) console.error(relayErr.trim());
  }
})().catch(e => { console.error(e); process.exit(1); });
