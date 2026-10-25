// Thesis, continued: keep Claude's changes, ask about a selection (Cmd+L), switch to Codex for comments.
import { launch, go, shot, ids, sleep, chrome } from './app.mjs';
import { record } from './recorder.mjs';

const { app, page } = await launch();
const d = ids();
const chatOpen = () => page.locator('.composer-input').isVisible().catch(() => false);
async function setChat(open) { if ((await chatOpen()) !== open) { await page.keyboard.press('Meta+j'); await sleep(900); } }
async function waitReply(r) {
  await page.waitForSelector('button[aria-label="Stop"]', { timeout: 30000 });
  await page.waitForSelector('button[aria-label="Stop"]', { state: 'detached', timeout: 600000 });
  r.mark('done');
}
const step = process.argv[2] ?? 'all';

await go(page, `/d/${d.thesis}`, 3500);
await setChat(true);
await chrome(page);

if (step === 'all' || step === 'keep') {
  const r = await record(page, 'keep-all');
  await sleep(1500);
  r.mark('click');
  await page.getByRole('button', { name: 'Keep all' }).first().click();
  await sleep(2500);
  await r.stop();
}

if (step === 'all' || step === 'select') {
  await page.keyboard.press('Meta+j'); await sleep(300); await page.keyboard.press('Meta+j'); await sleep(600);
  // Start a fresh chat for the selection question.
  await page.getByRole('button', { name: 'New chat' }).click();
  await sleep(800);
  const para = page.locator('.ProseMirror p', { hasText: 'Field studies after Hurricane' }).first();
  await para.scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, -200);
  await sleep(800);
  await chrome(page);
  const r = await record(page, 'select-ask');
  await sleep(1200);
  await para.click({ clickCount: 3 });
  r.mark('selected');
  await sleep(1200);
  await page.keyboard.press('Meta+l');
  r.mark('cmdL');
  await sleep(1200);
  await page.keyboard.type('Does this match the source I cite? Fix it if not.', { delay: 40 });
  await sleep(400);
  r.mark('send');
  await page.keyboard.press('Enter');
  await waitReply(r);
  await sleep(3000);
  await r.stop();
  await shot(page, 'select-done');
}
if (step === 'codex') {
  await page.getByRole('button', { name: 'Keep all' }).first().click().catch(() => {});
  await sleep(1000);
  await page.getByRole('button', { name: 'New chat' }).click();
  await sleep(800);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -500);
  await page.click('button[aria-label="Comments"]');
  await sleep(1500);
  await chrome(page);
  await shot(page, 'comments-panel');
  // The comments panel and chat share the side; reopen the chat to send.
  await setChat(true);
  await sleep(800);
  await chrome(page);
  const r = await record(page, 'codex-switch');
  await sleep(1200);
  await page.click('button[aria-label="Model"]');
  r.mark('menu');
  await sleep(1600);
  await page.locator('.menu-item').filter({ has: page.locator('.menu-text', { hasText: /^Codex$/ }) }).first().click();
  r.mark('codex');
  await sleep(1500);
  await page.click('.composer-input');
  await page.keyboard.type('Address all of the comments, reply to each one, then resolve it.', { delay: 38 });
  await sleep(400);
  r.mark('send');
  await page.keyboard.press('Enter');
  await waitReply(r);
  await sleep(3000);
  await r.stop();
  await shot(page, 'codex-done');
}
if (step === 'comments') {
  await setChat(true);
  await page.click('button[aria-label="Thinking effort"]');
  await sleep(800);
  await page.locator('.menu-item', { hasText: 'Medium' }).first().click();
  await sleep(800);
  await page.getByRole('button', { name: 'New chat' }).click();
  await sleep(800);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -500);
  await sleep(800);
  await chrome(page);
  const r = await record(page, 'comments-claude');
  await sleep(1200);
  await page.click('.composer-input');
  await page.keyboard.type('Address my advisor\'s comments, reply to each one, then resolve it.', { delay: 38 });
  await sleep(400);
  r.mark('send');
  await page.keyboard.press('Enter');
  await waitReply(r);
  await sleep(2500);
  await r.stop();
  await shot(page, 'comments-done');
  await page.click('button[aria-label="Comments"]');
  await sleep(1500);
  await shot(page, 'comments-resolved');
}
await app.close();
