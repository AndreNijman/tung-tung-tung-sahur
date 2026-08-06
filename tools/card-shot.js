#!/usr/bin/env node
//
// Grabs the 1000x525 card image used by games.andrenijman.com. Poses the
// creature a few cells ahead and lit, because a screenshot of an unlit corridor
// says nothing about what the game is.
//
// Usage: node tools/card-shot.js [outfile]

'use strict';

const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'shots', 'card.png');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 525 } });
  await page.addStyleTag({ content: '#wrap{transform:translateY(-8px)}' }).catch(() => {});
  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForTimeout(400);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    // stand in a corridor, creature ahead and facing us, mid-hunt
    game.px = 1.5; game.py = 1.5; game.angle = 0;
    game.cx = 3.9; game.cy = 1.5;
    game.cangle = Math.PI;
    game.cstate = 'hunt'; game.alert = 1; game.prevCstate = 'hunt';
    game.collected = 2;
    game.composure = 0.62;
    game.timeLeft = 168;
  });
  await page.waitForTimeout(250);
  await page.locator('#main').screenshot({ path: OUT });
  console.log('wrote', OUT);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
