// Version history: save a named version, then open an older one.
import { launch, go, shot, ids, sleep, chrome } from './app.mjs';
import { record } from './recorder.mjs';
const { app, page } = await launch();
const d = ids();
await go(page, `/d/${d.thesis}`, 3500);
for (const label of ['Tabs & outline', 'Comments']) {
  const pressed = await page.getAttribute(`button[aria-label="${label}"]`, 'aria-pressed').catch(() => null);
  if (pressed === 'true') { await page.click(`button[aria-label="${label}"]`); await sleep(600); }
}
if (!(await page.locator('input[placeholder="Name the current version"]').isVisible())) { await page.click('button[aria-label="Version history"]'); await sleep(1200); }
await page.click('button[aria-label="Zoom"]'); await sleep(300); await page.getByText('Fit', { exact: true }).click(); await sleep(1000);
await chrome(page);
const r = await record(page, 'history');
await sleep(1200);
await page.click('input[placeholder="Name the current version"]');
await page.keyboard.type('Ready for committee', { delay: 55 });
await sleep(400);
r.mark('save');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await sleep(2200);
r.mark('open-old');
await page.getByText('First full draft', { exact: true }).click();
await sleep(1200);
await page.getByRole('button', { name: 'Changes', exact: true }).first().click().catch(() => {});
await sleep(800);
await page.mouse.move(700, 600);
for (let i = 0; i < 50; i++) { await page.mouse.wheel(0, 22); await sleep(16); }
await sleep(3000);
await r.stop();
await shot(page, 'history-old');
const labels = await page.$$eval('button', (b) => b.map((x) => (x.getAttribute('aria-label') || x.textContent).trim()).filter(Boolean));
console.log([...new Set(labels)].filter((x) => /restore|back|version/i.test(x)).join(' | '));
await app.close();
