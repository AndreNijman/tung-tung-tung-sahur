#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots', 'lootbox');

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });

  const errors = [];
  page.on('console', m => {
    if (m.type() === 'error') {
      console.error('Console error:', m.text());
      errors.push(m.text());
    }
  });
  page.on('pageerror', e => {
    console.error('Page error:', e.message);
    errors.push(e.message);
  });

  const fileUrl = 'file://' + path.join(ROOT, 'index.html');
  console.log('Loading:', fileUrl);
  await page.goto(fileUrl);
  await page.waitForTimeout(500);

  // Give player plenty of coins for testing
  await page.evaluate(() => {
    profile.coins = 500000;
    saveProfile();
  });

  // Navigate to cosmetics -> lootboxes
  await page.click('#b-cosmetics-menu');
  await page.waitForTimeout(200);
  await page.click('[data-profile-screen="scr-lootboxes"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '1-catalog.png') });
  console.log('Saved 1-catalog.png');

  // Find the Legendary or Mythic box and click OPEN
  const boxButtons = page.locator('#lootbox-catalog .lootbox button');
  const count = await boxButtons.count();
  console.log(`Found ${count} lootboxes in catalog`);
  if (count < 4) {
    throw new Error(`Expected 4 lootboxes, found ${count}`);
  }

  // Click OPEN on Legendary Box (index 2)
  console.log('Clicking OPEN on Legendary Box...');
  await boxButtons.nth(2).click();

  // Wait 600ms (crate drop phase)
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, '2-crate-drop.png') });
  console.log('Saved 2-crate-drop.png');

  // Wait another 1500ms (carousel high speed spin)
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, '3-carousel-spin.png') });
  console.log('Saved 3-carousel-spin.png');

  // Wait another 3000ms (carousel slowing down / near miss)
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(SHOTS, '4-near-miss.png') });
  console.log('Saved 4-near-miss.png');

  // Wait for the reveal explosion and trophy card (around 8.5s total)
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(SHOTS, '5-reveal-trophy.png') });
  console.log('Saved 5-reveal-trophy.png');

  // Test Mythic Box unboxing!
  const againBtn = page.locator('#reveal-again-btn');
  const claimBtn = page.locator('#reveal-claim-btn');
  if (await claimBtn.isVisible()) {
    console.log('Clicking Claim & Return...');
    await claimBtn.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, '6-returned-catalog.png') });
    console.log('Saved 6-returned-catalog.png');

    // Now open Mythic box (index 3)
    console.log('Clicking OPEN on Mythic Box...');
    await page.locator('#lootbox-catalog .lootbox button').nth(3).click();
    await page.waitForTimeout(9500);
    await page.screenshot({ path: path.join(SHOTS, '7-mythic-reveal.png') });
    console.log('Saved 7-mythic-reveal.png');
  }

  await browser.close();
  if (errors.length > 0) {
    console.error('Test completed with errors:', errors);
    process.exit(1);
  }
  console.log('All lootbox tests passed successfully!');
})().catch(e => {
  console.error('Fatal error in test:', e);
  process.exit(1);
});
