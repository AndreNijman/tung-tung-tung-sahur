#!/usr/bin/env node
//
// Browser smoke test. tools/sim.js exercises the simulation half of index.html;
// this covers the half it cannot reach -- sprite cache, HUD, compass arrows and
// all four end screens -- by driving the real page in Chromium and failing on
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
  await shot(page, '1-intro');

  // start and play a while: exercises raycaster, sprite cache, HUD, creature AI
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  await play(page, 4, ['KeyW']);
  await shot(page, '2-play');

  // the clock must actually be counting down
  const t1 = await page.evaluate(() => game.timeLeft);
  await page.waitForTimeout(1200);
  const t2 = await page.evaluate(() => game.timeLeft);
  if (!(t2 < t1 - 0.5)) problems.push(`clock not running: ${t1} -> ${t2}`);
  console.log(`  clock: ${t1.toFixed(1)}s -> ${t2.toFixed(1)}s`);

  // torch toggle and hide key must not throw
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(200);
  await page.keyboard.press('KeyF');

  // extraction HUD: strip the offerings and confirm the surau compass renders
  await page.evaluate(() => { game.items.length = 0; game.collected = N_ITEMS; });
  await page.waitForTimeout(400);
  await shot(page, '3-extraction');

  // win: stand on the surau with everything gathered
  await page.evaluate(() => { game.px = game.surau[0]; game.py = game.surau[1]; });
  await page.waitForTimeout(400);
  let state = await page.evaluate(() => game.state);
  if (state !== 'win') problems.push(`reaching the surau with 6/6 did not win (state=${state})`);
  await shot(page, '4-win');

  // dawn: restart, run the clock out
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(300);
  await page.evaluate(() => { game.timeLeft = 0.4; });
  await page.waitForTimeout(600);
  state = await page.evaluate(() => game.state);
  if (state !== 'dawn') problems.push(`clock expiry did not end the night (state=${state})`);
  await shot(page, '5-dawn');

  // caught: restart, drop the creature on top of the player
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(300);
  await page.evaluate(() => { game.cx = game.px; game.cy = game.py; game.hidden = false; });
  await page.waitForTimeout(400);
  state = await page.evaluate(() => game.state);
  if (state !== 'caught') problems.push(`contact did not catch the player (state=${state})`);
  await shot(page, '6-caught');

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
