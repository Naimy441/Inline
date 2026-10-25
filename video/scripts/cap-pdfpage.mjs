// A clean picture of the rebuilt PDF page, for the side-by-side comparison.
import { launch, go, sleep, chrome, ROOT } from './app.mjs';
import path from 'node:path';
const { app, page } = await launch();
await go(page, '/d/j0a8x3zg3jdp', 3500);
if (await page.locator('.composer-input').isVisible()) { await page.keyboard.press('Meta+j'); await sleep(900); }
await page.click('button[aria-label="Zoom"]'); await sleep(300); await page.locator('.menu-text', { hasText: /^100%$/ }).click(); await sleep(1500);
await chrome(page);
const boxes = await page.$$eval('[class*="sheet"], [class*="page-"]', (els) => els.slice(0, 12).map((e) => [e.className, ...Object.values(e.getBoundingClientRect().toJSON()).map(Math.round)]));

await page.locator('.sheet').first().screenshot({ path: path.join(ROOT, 'public', 'img', 'pdf-rebuilt.png') });
await app.close();
