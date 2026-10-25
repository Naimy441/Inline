// Home: library tour, folder, search; canvas scroll and a hand edit.
import { launch, go, shot, ids, sleep, chrome } from './app.mjs';
import { record } from './recorder.mjs';
const { app, page } = await launch();
const d = ids();
const glide = async (x, y, ms = 700) => { await page.mouse.move(x, y, { steps: Math.round(ms / 16) }); };

await go(page, '/', 4000);
await shot(page, 'home-banner');
await page.locator('button[aria-label="Dismiss"], .home-banner button[aria-label]').last().click().catch(() => {});
await sleep(1000);
await chrome(page);
await shot(page, 'home');
await page.mouse.wheel(0, 400); await sleep(800);
await shot(page, 'home-scrolled');
await page.mouse.wheel(0, -1000); await sleep(800);

let r = await record(page, 'home-tour');
await sleep(1000);
await glide(400, 300); await sleep(500);
await glide(1100, 300, 1400); await sleep(400);
await page.mouse.wheel(0, 300); await sleep(900);
await glide(320, 650, 900); await sleep(600);
r.mark('open-folder');
await page.getByText('Thesis', { exact: true }).first().click();
await sleep(2200);
await chrome(page);
await glide(600, 600, 900); await sleep(1500);
r.mark('back');
await page.getByText('All documents', { exact: true }).first().click().catch(() => page.goBack());
await sleep(1800);
await page.mouse.wheel(0, -600); await sleep(600);
r.mark('search');
await page.click('input[placeholder="Search documents and folders"]');
await page.keyboard.type('launch', { delay: 110 });
await sleep(2500);
await r.stop();
await shot(page, 'home-search');
await page.keyboard.press('Escape');
await page.fill('input[placeholder="Search documents and folders"]', '');
await sleep(800);
// List view.
await page.click('button[aria-label="List view"]').catch(() => {});
await sleep(1200);
await shot(page, 'home-list');
await page.click('button[aria-label="Grid view"]').catch(() => {});
await sleep(800);

// Canvas: scroll, then edit a heading by hand.
await go(page, `/d/${d.canvas}`, 4000);
if (await page.locator('.composer-input').isVisible()) { await page.keyboard.press('Meta+j'); await sleep(900); }
for (const label of ['Tabs & outline', 'Version history', 'Comments']) {
  const pressed = await page.getAttribute(`button[aria-label="${label}"]`, 'aria-pressed').catch(() => null);
  if (pressed === 'true') { await page.click(`button[aria-label="${label}"]`); await sleep(600); }
}
await chrome(page);
await shot(page, 'canvas-top');
r = await record(page, 'canvas-tour');
await sleep(1000);
for (let i = 0; i < 90; i++) { await page.mouse.wheel(0, 14); await sleep(16); }
await sleep(1200);
for (let i = 0; i < 90; i++) { await page.mouse.wheel(0, -14); await sleep(16); }
await sleep(800);
const h1 = page.locator('.ProseMirror h1').first();
const box = await h1.boundingBox();
await glide(box.x + box.width - 4, box.y + box.height / 2, 900);
await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
r.mark('typing');
await page.keyboard.press('End');
await page.keyboard.type(', season two', { delay: 80 });
await sleep(1800);
await r.stop();
await shot(page, 'canvas-edited');
await page.keyboard.press('Meta+z'); await sleep(400);
await app.close();
