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
  if ((await page.locator('#scr-main > .menu-stack > button').count()) !== 3) {
    problems.push('main menu did not contain exactly three primary buttons');
  }
  await page.click('#b-howto');
  await page.click('[data-how="how-keys"]');
  const controls = await page.locator('#how-keys').textContent();
  for (const binding of ['W A S D', 'G', 'V', 'B', 'ESC']) {
    if (!controls.includes(binding)) problems.push(`How to Play omitted ${binding}`);
  }
  await page.keyboard.press('ArrowRight');
  if ((await page.locator('[data-how="how-social"][aria-selected="true"]').count()) !== 1) problems.push('How to Play tabs did not support arrow-key navigation');
  await page.click('#scr-howto .menu-back');
  await page.click('#b-cosmetics-menu');
  await page.click('[data-profile-screen="scr-pass"]');
  if ((await page.locator('#pass-catalog .pass-node').count()) !== 100) problems.push('Sahur Pass did not render 100 levels');
  await page.click('#scr-pass .profile-back');

  await page.click('[data-profile-screen="scr-shop"]');
  if ((await page.locator('#shop-tabs button').count()) !== 7) problems.push('item shop sections did not render');
  const itemPreview = await page.locator('#shop-preview').evaluate(canvas => canvas.toDataURL());
  await page.click('#b-shop-wearer');
  const wearerPreview = await page.locator('#shop-preview').evaluate(canvas => canvas.toDataURL());
  if (itemPreview === wearerPreview) problems.push('item/on-player shop preview modes were identical');
  const catalogIntegrity = await page.evaluate(() => ({
    rarities: allCosmetics().every(item => item.rarity && RARITY_META[item.rarity]),
    streetCount: STREET_THEMES.length,
    uniqueStreets: new Set(STREET_THEMES.map(street => `${street.name}|${street.a}|${street.b}|${street.pattern}`)).size,
    mythicShowpieces: SHOP_ITEMS.filter(item => item.rarity === 'mythic' && item.price >= 10000).length,
    xp: [xpForLevel(2), xpForLevel(3), xpForLevel(4)],
  }));
  if (!catalogIntegrity.rarities || catalogIntegrity.streetCount !== catalogIntegrity.uniqueStreets ||
      catalogIntegrity.mythicShowpieces < 3 || !(catalogIntegrity.xp[1] - catalogIntegrity.xp[0] < catalogIntegrity.xp[2] - catalogIntegrity.xp[1])) {
    problems.push(`catalog/progression integrity failed: ${JSON.stringify(catalogIntegrity)}`);
  }
  await page.getByRole('tab', { name: 'SAHUR PASS' }).click();
  const passShopText = await page.locator('#shop-catalog').textContent();
  if (passShopText.includes('Sahur Sovereign') || !passShopText.includes('???')) {
    problems.push('locked level-100 Sahur reward was revealed in the item shop');
  }
  if (await page.locator('#shop-catalog button').filter({ hasText: /^BUY$/ }).count()) {
    problems.push('Sahur Pass reward exposed a direct BUY action in the item shop');
  }
  const passEconomy = await page.evaluate(() => {
    const sovereign = PASS_REWARDS.find(reward => reward.level === 100);
    const beforeCoins = profile.coins;
    const beforeOwned = profile.owned.includes(sovereign.id);
    const directBuy = buyItem(sovereign);
    const blocked = !directBuy && profile.coins === beforeCoins && profile.owned.includes(sovereign.id) === beforeOwned;
    const strippedBeforeLevel100 = !normalizeProfile({...profile,pass:true,xp:xpForLevel(100)-1,owned:[...profile.owned,sovereign.id]}).owned.includes(sovereign.id);
    const strippedWithoutPass = !normalizeProfile({...profile,pass:false,xp:xpForLevel(100),owned:[...profile.owned,sovereign.id]}).owned.includes(sovereign.id);
    const snapshot = { pass:profile.pass, xp:profile.xp, passClaimed:profile.passClaimed, owned:[...profile.owned] };
    profile.pass=true;profile.xp=xpForLevel(100);profile.passClaimed=99;grantPassRewards();
    const progressionGrant=profile.owned.includes(sovereign.id);
    profile.pass=snapshot.pass;profile.xp=snapshot.xp;profile.passClaimed=snapshot.passClaimed;profile.owned=snapshot.owned;
    return { marked:sovereign.pass===true, blocked, strippedBeforeLevel100, strippedWithoutPass, progressionGrant };
  });
  if (!passEconomy.marked || !passEconomy.blocked || !passEconomy.strippedBeforeLevel100 ||
      !passEconomy.strippedWithoutPass || !passEconomy.progressionGrant) {
    problems.push(`Sahur Pass economy guard failed: ${JSON.stringify(passEconomy)}`);
  }
  await page.click('#scr-shop .profile-back');

  await page.evaluate(() => {
    profile.owned.push('shirt-eclipse', 'pattern-batik', 'pants-ember', 'hat-crown', 'back-drum', 'aura-dawn', 'tung-tralalero', 'spray-eye', 'emote-moonwalk');
    profile.owned = [...new Set(profile.owned)];
    profile.equipped.spray = 'spray-eye';
    profile.equipped.emote = 'emote-moonwalk';
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
  await page.click('[data-wardrobe-mode="tung"]');
  if (!(await page.locator('#wardrobe-catalog .catalog-item').filter({ hasText: 'Tralalero Tung' }).count())) problems.push('Tung wardrobe mode did not show owned Tung characters');
  await page.click('[data-wardrobe-mode="player"]');
  if (await page.locator('#wardrobe-catalog .catalog-item').filter({ hasText: 'Tralalero Tung' }).count()) problems.push('player wardrobe mode leaked Tung characters');
  await page.click('#scr-wardrobe .profile-back');

  await page.click('[data-profile-screen="scr-lootboxes"]');
  if ((await page.locator('#lootbox-catalog .lootbox').count()) !== 4) problems.push('lootbox screen did not render four tiers');
  await page.click('#scr-lootboxes .profile-back');
  await page.click('#scr-cosmetics .menu-back');

  // Start through the real menu. This also covers audio/pointer-lock setup.
  await page.click('#b-play-menu');
  await page.click('#b-solo');
  await page.waitForSelector('#scr-solo.on');
  await page.locator('#solo-settings select').nth(9).selectOption('true');
  await page.click('#b-solo-start');
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
  const emoteStart = await page.evaluate(() => [game.px, game.py]);
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(240);
  const emoteEnd = await page.evaluate(() => [game.px, game.py]);
  if (Math.hypot(emoteEnd[0] - emoteStart[0], emoteEnd[1] - emoteStart[1]) < 0.04) problems.push('moving emote did not move the player');
  await page.evaluate(() => { game.emoteTime = 0; game.performanceKind = ''; });
  await page.keyboard.press('KeyB');
  const foundSprayWall = await page.evaluate(() => {
    for (let i = 0; i < 64; i++) {
      game.angle = i * Math.PI * 2 / 64;
      if (game.wallAhead()) return true;
    }
    return false;
  });
  if (foundSprayWall) await page.keyboard.press('KeyG');
  await page.waitForTimeout(200);
  await page.keyboard.press('KeyF');
  const performanceStats = await page.evaluate(() => ({ emotes: profile.stats.emotes, taunts: profile.stats.taunts, sprays: profile.stats.sprays, marks: game.sprays.length, speedrun: game.speedrun }));
  if (!performanceStats.speedrun || performanceStats.emotes < 1 || performanceStats.taunts < 1 || performanceStats.sprays < 1 || performanceStats.marks < 1) {
    problems.push(`speedrun/emote/taunt input failed: ${JSON.stringify(performanceStats)}`);
  }

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
  await page.evaluate(() => {
    game.cx = game.mapN - 1.5; game.cy = game.mapN - 1.5;
    game.px = game.surau[0]; game.py = game.surau[1];
  });
  await page.waitForTimeout(400);
  let state = await page.evaluate(() => game.state);
  if (state !== 'win') problems.push(`reaching the surau with 6/6 did not win (state=${state})`);
  if (!(await page.locator('#scr-solo-over.on').count())) problems.push('solo win did not expose direct action buttons');
  await shot(page, '5-win');

  // dawn: restart, run the clock out
  await page.click('#b-solo-again');
  await page.waitForTimeout(300);
  await page.evaluate(() => { game.timeLeft = 0.4; });
  await page.waitForTimeout(600);
  state = await page.evaluate(() => game.state);
  if (state !== 'dawn') problems.push(`clock expiry did not end the night (state=${state})`);
  await shot(page, '6-dawn');

  // End-screen navigation returns to a clean settings screen, then starts fresh.
  await page.click('#b-solo-lobby');
  if (!(await page.locator('#scr-solo.on').count())) problems.push('solo end did not return to night settings');
  await page.click('#b-solo-start');
  await page.waitForTimeout(300);
  await page.evaluate(() => { game.cx = game.px; game.cy = game.py; game.hidden = false; });
  await page.waitForTimeout(400);
  state = await page.evaluate(() => game.state);
  if (state !== 'caught') problems.push(`contact did not catch the player (state=${state})`);
  await shot(page, '7-caught');

  // restart from an end screen must produce a fresh, playable night
  await page.click('#b-solo-again');
  await page.waitForTimeout(500);
  const fresh = await page.evaluate(() => ({
    state: game.state, items: game.items.length, t: game.timeLeft, nerve: game.composure,
  }));
  if (fresh.state !== 'play' || fresh.items !== N_ITEMS_EXPECTED || fresh.t < 200) {
    problems.push(`restart did not reset cleanly: ${JSON.stringify(fresh)}`);
  }
  console.log(`  restart: ${JSON.stringify(fresh)}`);

  await page.keyboard.press('Escape');
  await page.click('#b-quit');
  const menuReturn = await page.evaluate(() => ({
    screen: document.querySelector('.scr.on')?.id,
    pixel: [...ctx.getImageData(Math.floor(WIN_W / 2), Math.floor(WIN_H / 2), 1, 1).data],
  }));
  if (menuReturn.screen !== 'scr-main' || menuReturn.pixel.slice(0, 3).some(value => value !== 0)) {
    problems.push(`leaving a solo night did not return to a plain black menu: ${JSON.stringify(menuReturn)}`);
  }

  await browser.close();

  if (problems.length) {
    console.error('\nFAIL');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('\nPASS — no console/page errors, all four end states reachable');
})().catch(e => { console.error(e); process.exit(1); });
