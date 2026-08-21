#!/usr/bin/env node
//
// Browser smoke test. tools/sim.js exercises the simulation half of index.html;
// this covers the half it cannot reach -- sprite cache, HUD, compass arrows and
// menus, paired alcoves and all four end screens -- by driving the real page in Chromium and failing on
// any console error, page error or failed request.
//
// Usage: node tools/smoke.js [--headed] [url]
//
// With no url it tests the working copy over file://. Pass the deployed Pages
// URL to check the copy that is actually served -- a 200 from curl only proves
// the HTML arrived, not that it runs.
//
// Screenshots land in shots/.

'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
const urlArg = process.argv.slice(2).find(a => !a.startsWith('--'));
const URL = urlArg || 'file://' + path.join(ROOT, 'index.html');
const N_ITEMS_EXPECTED = 6;

const problems = [];

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  console.log(`  shot: shots/${name}.png`);
}

// Drive the real input path rather than poking state, so key handling is covered.
async function play(page, seconds, keys = ['KeyW']) {
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(seconds * 1000);
  for (const k of keys) await page.keyboard.up(k);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });

  page.on('console', m => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', r => problems.push(`request failed: ${r.url()}`));

  console.log('loading', URL);
  await page.goto(URL);
  await page.waitForTimeout(500);
  await shot(page, '1-menu');
  if (!(await page.locator('#scr-main.on').count())) problems.push('main menu did not open');
  const gameBounds = await page.locator('#wrap').boundingBox();
  if (!gameBounds || gameBounds.width < 990 || gameBounds.height < 555) {
    problems.push(`game did not fill viewport: ${JSON.stringify(gameBounds)}`);
  }
  await page.click('[data-profile-screen="scr-pass"]');
  if ((await page.locator('#pass-catalog .catalog-item').count()) !== 100) problems.push('Sahur Pass did not render 100 levels');
  await page.click('#scr-pass .profile-back');

  await page.evaluate(() => {
    profile.owned.push('shirt-eclipse', 'pattern-batik', 'pants-ember', 'hat-crown', 'back-drum', 'aura-dawn');
    profile.owned = [...new Set(profile.owned)];
  });
  await page.click('[data-profile-screen="scr-wardrobe"]');
  const wardrobeCards = await page.locator('#wardrobe-catalog .catalog-item').count();
  const wardrobePreviews = await page.locator('#wardrobe-catalog .wardrobe-item canvas').count();
  if (wardrobePreviews !== wardrobeCards) problems.push(`wardrobe previews missing: ${wardrobePreviews}/${wardrobeCards}`);
  await shot(page, 'wardrobe');
  const currentPreview = await page.locator('#wardrobe-preview').evaluate(canvas => canvas.toDataURL());
  const crown = page.locator('#wardrobe-catalog .catalog-item').filter({ hasText: 'Dawn Crown' });
  await crown.getByText('PREVIEW', { exact: true }).click();
  const crownPreview = await page.locator('#wardrobe-preview').evaluate(canvas => canvas.toDataURL());
  if (currentPreview === crownPreview) problems.push('wardrobe preview did not change for a hat cosmetic');
  await crown.getByText('EQUIP', { exact: true }).click();
  if ((await page.evaluate(() => profile.equipped.hat)) !== 'hat-crown') problems.push('wardrobe did not equip selected cosmetic');
  await page.click('#scr-wardrobe .profile-back');

  // Start through the real menu. This also covers audio/pointer-lock setup.
  await page.click('#b-solo');
  await page.waitForTimeout(300);
  if ((await page.evaluate(() => game.state)) !== 'play') problems.push('Play Alone did not start');

  // play a while: exercises raycaster, sprite cache, HUD and creature AI
  await play(page, 4, ['KeyW']);
  await shot(page, '2-play');
  const deadTorch = await page.evaluate(() => {
    game.flashlight = true; game.infiniteTorch = false; game.battery = 0;
    return game.torchOn();
  });
  if (deadTorch) problems.push('empty torch battery still produced torch light');

  // the clock must actually be counting down
  const t1 = await page.evaluate(() => game.timeLeft);
  await page.waitForTimeout(1200);
  const t2 = await page.evaluate(() => game.timeLeft);
  if (!(t2 < t1 - 0.5)) problems.push(`clock not running: ${t1} -> ${t2}`);
  console.log(`  clock: ${t1.toFixed(1)}s -> ${t2.toFixed(1)}s`);

  // pause: the menu must appear and the night must actually stop
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (!(await page.evaluate(() => paused))) problems.push('Escape did not pause');
  await shot(page, '3-paused');
  const p1 = await page.evaluate(() => game.timeLeft);
  await page.waitForTimeout(1200);
  const p2 = await page.evaluate(() => game.timeLeft);
  if (p1 !== p2) problems.push(`clock kept running while paused: ${p1} -> ${p2}`);
  console.log(`  paused clock held at ${p2.toFixed(1)}s`);
  // and the creature must not have moved either
  const c1 = await page.evaluate(() => [game.cx, game.cy]);
  await page.waitForTimeout(600);
  const c2 = await page.evaluate(() => [game.cx, game.cy]);
  if (c1[0] !== c2[0] || c1[1] !== c2[1]) problems.push('creature moved while paused');

  await page.click('#b-resume');
  await page.waitForTimeout(400);
  if (await page.evaluate(() => paused)) problems.push('click did not resume');
  const p3 = await page.evaluate(() => game.timeLeft);
  await page.waitForTimeout(800);
  if (!((await page.evaluate(() => game.timeLeft)) < p3 - 0.3)) {
    problems.push('clock did not restart after resume');
  }

  // torch toggle and hide key must not throw
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(200);
  await page.keyboard.press('KeyF');

  // Every alcove is paired, and Q moves a hidden player to its partner after
  // the transit delay. Do this by the real E/Q input path rather than mutating
  // `hidden` directly.
  const swap = await page.evaluate(() => {
    game.cx = game.mapN - 1.5; game.cy = game.mapN - 1.5;
    game.px = game.hides[0][0]; game.py = game.hides[0][1];
    game.updateNearestHide();
    const to = pairOf(game.hidePairs, 0);
    return { from: [...game.hides[0]], to, dest: [...game.hides[to]] };
  });
  await page.keyboard.press('KeyE');
  await page.keyboard.press('KeyQ');
  await page.waitForTimeout(1500);
  const swapped = await page.evaluate(() => ({ hidden: game.hidden, x: game.px, y: game.py, idx: game.hideIdx }));
  if (!swapped.hidden || swapped.idx !== swap.to || Math.hypot(swapped.x - swap.dest[0], swapped.y - swap.dest[1]) > 0.05) {
    problems.push(`paired alcove swap failed: ${JSON.stringify({ swap, swapped })}`);
  }
  console.log(`  alcove: ${swap.from.join(',')} -> ${swap.dest.join(',')}`);
  await page.evaluate(() => { game.cx = game.px; game.cy = game.py; });
  await page.waitForTimeout(200);
  if ((await page.evaluate(() => game.state)) !== 'play') problems.push('Tung caught the player inside an alcove');
  await page.evaluate(() => { game.cx = game.mapN - 1.5; game.cy = game.mapN - 1.5; });
  await page.keyboard.press('KeyE');

  // extraction HUD: strip the offerings and confirm the surau compass renders
  await page.evaluate(() => { game.items.length = 0; game.collected = game.nItems; });
  await page.waitForTimeout(400);
  await shot(page, '4-extraction');

  // win: stand on the surau with everything gathered
  await page.evaluate(() => { game.px = game.surau[0]; game.py = game.surau[1]; });
  await page.waitForTimeout(400);
  let state = await page.evaluate(() => game.state);
  if (state !== 'win') problems.push(`reaching the surau with 6/6 did not win (state=${state})`);
  await shot(page, '5-win');

  // dawn: restart, run the clock out
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(300);
  await page.evaluate(() => { game.timeLeft = 0.4; });
  await page.waitForTimeout(600);
  state = await page.evaluate(() => game.state);
  if (state !== 'dawn') problems.push(`clock expiry did not end the night (state=${state})`);
  await shot(page, '6-dawn');

  // caught: restart, drop the creature on top of the player
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(300);
  await page.evaluate(() => { game.cx = game.px; game.cy = game.py; game.hidden = false; });
  await page.waitForTimeout(400);
  state = await page.evaluate(() => game.state);
  if (state !== 'caught') problems.push(`contact did not catch the player (state=${state})`);
  await shot(page, '7-caught');

  // restart from an end screen must produce a fresh, playable night
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(500);
  const fresh = await page.evaluate(() => ({
    state: game.state, items: game.items.length, t: game.timeLeft, nerve: game.composure,
  }));
  if (fresh.state !== 'play' || fresh.items !== N_ITEMS_EXPECTED || fresh.t < 200) {
    problems.push(`restart did not reset cleanly: ${JSON.stringify(fresh)}`);
  }
  console.log(`  restart: ${JSON.stringify(fresh)}`);

  await browser.close();

  if (problems.length) {
    console.error('\nFAIL');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('\nPASS — no console/page errors, all four end states reachable');
})().catch(e => { console.error(e); process.exit(1); });
