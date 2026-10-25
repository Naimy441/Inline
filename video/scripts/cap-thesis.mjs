// Thesis: editor tour, then a real Claude edit with tracked changes.
import { launch, go, shot, ids, sleep } from './app.mjs';
import { record } from './recorder.mjs';

const { app, page } = await launch();
const d = ids();
const chatOpen = () => page.locator('.composer-input').isVisible().catch(() => false);
async function setChat(open) { if ((await chatOpen()) !== open) { await page.keyboard.press('Meta+j'); await sleep(900); } }
async function zoom(label) { await page.click('button[aria-label="Zoom"]'); await sleep(300); await page.getByText(label, { exact: true }).click(); await sleep(800); }
async function smoothScroll(px, ms) {
  const steps = Math.round(ms / 16);
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, px / steps); await sleep(16); }
}

await go(page, `/d/${d.thesis}`, 4000);
await setChat(false);
await zoom('Fit');
await page.mouse.move(700, 500);
await shot(page, 'thesis-top');

// 1. Editor tour: scroll the whole proposal.
let r = await record(page, 'editor-scroll');
await sleep(1500);
await smoothScroll(5200, 26000);
await sleep(1000);
await r.stop();
for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -400);
await sleep(1200);

// 2. Claude tightens the introduction.
await setChat(true);
await sleep(1000);
await shot(page, 'chat-empty');
r = await record(page, 'chat-tighten');
await sleep(1200);
await page.click('.composer-input');
r.mark('type');
await page.keyboard.type('Tighten the introduction. Keep the meaning and the citations.', { delay: 38 });
await sleep(500);
r.mark('send');
await page.keyboard.press('Enter');
await page.waitForSelector('button[aria-label="Stop"]', { timeout: 20000 });
await page.waitForSelector('button[aria-label="Stop"]', { state: 'detached', timeout: 300000 });
r.mark('done');
await sleep(3000);
await r.stop();
await shot(page, 'chat-tighten-done');
const labels = await page.$$eval('button', (b) => b.map((x) => (x.getAttribute('aria-label') || x.textContent).trim()).filter(Boolean));
console.log([...new Set(labels)].join(' | '));
await app.close();
