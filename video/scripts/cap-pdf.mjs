// Import a PDF from Home and let the AI rebuild it as editable text.
import path from 'node:path';
import { launch, go, shot, ids, sleep, chrome, ROOT } from './app.mjs';
import { record } from './recorder.mjs';
const { app, page } = await launch();
const d = ids();

// Use Sonnet for the conversion to go easy on plan usage.
await go(page, `/d/${d['Reading list 2026']}`, 3000);
if (!(await page.locator('.composer-input').isVisible())) { await page.keyboard.press('Meta+j'); await sleep(900); }
await page.click('button[aria-label="Model"]'); await sleep(700);
await page.locator('.menu-item', { hasText: 'Claude · Sonnet 5.5' }).first().click(); await sleep(700);

await go(page, '/', 3000);
const r = await record(page, 'pdf-import');
await sleep(1000);
const chooser = page.waitForEvent('filechooser');
r.mark('import');
await page.getByText('Import files', { exact: true }).click();
await (await chooser).setFiles(path.join(ROOT, 'seed', 'EOS 310 Lecture 7.pdf'));
await page.waitForURL(/\/d\//, { timeout: 60000 }).catch(() => {});
r.mark('opened');
await sleep(2000);
await chrome(page);
await shot(page, 'pdf-0');
const t0 = Date.now();
let n = 1;
while (Date.now() - t0 < 12 * 60 * 1000) {
  await sleep(20000);
  await chrome(page);
  await shot(page, `pdf-${n++}`);
  const running = await page.locator('button[aria-label="Stop"]').isVisible().catch(() => false);
  if (!running && Date.now() - t0 > 40000) break;
}
r.mark('done');
await sleep(2000);
await r.stop();
await shot(page, 'pdf-done');
console.log(page.url());
await app.close();
