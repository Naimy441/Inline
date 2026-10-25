// Home: Organize with AI sorts loose documents into folders.
import { launch, go, shot, sleep, chrome } from './app.mjs';
import { record } from './recorder.mjs';
const { app, page } = await launch();
await go(page, '/', 4000);
await page.mouse.wheel(0, 520); await sleep(1200);
await chrome(page);
await shot(page, 'organize-before');
const r = await record(page, 'organize');
await sleep(1200);
r.mark('click');
await page.getByRole('button', { name: /Organize with/ }).click();
await sleep(2500);
await chrome(page);
await shot(page, 'organize-open');
const was = await page.locator('.composer-input').isVisible();
if (!was) { await page.getByRole('button', { name: /Organize with/ }).click(); await sleep(2000); }
await page.getByText('Sort everything into folders', { exact: true }).click();
await sleep(800);
if (!(await page.locator('button[aria-label="Stop"]').isVisible())) { await page.click('.composer-input'); await page.keyboard.press('Enter'); }
r.mark('sent');
await page.waitForSelector('button[aria-label="Stop"]', { timeout: 30000 });
await page.waitForSelector('button[aria-label="Stop"]', { state: 'detached', timeout: 300000 });
r.mark('done');
await sleep(3000);
await r.stop();
await chrome(page);
await shot(page, 'organize-done');
await app.close();
