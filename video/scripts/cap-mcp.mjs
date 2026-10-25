// Claude Code in a terminal edits a document over MCP while the app shows it live.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, go, shot, ids, sleep, chrome, DATA, BASE, ROOT } from './app.mjs';
import { record } from './recorder.mjs';
const { app, page } = await launch();
const d = ids();

// The Connect Claude Code dialog, from the Help menu.
await go(page, `/d/${d['Weekly sync: October 21']}`, 3500);
if (await page.locator('.composer-input').isVisible()) { await page.keyboard.press('Meta+j'); await sleep(900); }
await page.getByRole('menuitem', { name: 'Help' }).or(page.getByText('Help', { exact: true })).first().click();
await sleep(700);
await shot(page, 'help-menu');
await page.getByText(/Connect Claude Code/).first().click();
await sleep(1200);
await shot(page, 'mcp-dialog');
await page.keyboard.press('Escape');
await sleep(600);
await page.getByRole('button', { name: 'Undo all' }).first().click().catch(() => {});
await sleep(800);
await page.click('button[aria-label="Zoom"]'); await sleep(300); await page.getByText('75%', { exact: true }).click(); await sleep(1000);
await page.mouse.move(700, 500);
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 300); await sleep(50); }
await sleep(1000);
await chrome(page);
await shot(page, 'mcp-before');

const token = fs.readFileSync(path.join(DATA, 'mcp-token'), 'utf8').trim();
const cfg = path.join(ROOT, 'capture-data', 'mcp.json');
fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { inline: { type: 'http', url: `${BASE}/api/mcp`, headers: { Authorization: `Bearer ${token}` } } } }));
const prompt = 'In my Inline document "Weekly sync: October 21", add a short "Next sync" section at the end with the date October 28 and two agenda items drawn from the open action items.';
fs.writeFileSync(path.join(ROOT, 'capture-data', 'mcp-prompt.txt'), prompt);

const r = await record(page, 'mcp-live');
await sleep(1500);
r.mark('start');
const out = fs.createWriteStream(path.join(ROOT, 'capture-data', 'mcp-stream.jsonl'));
const child = spawn('claude', ['-p', prompt, '--model', 'haiku', '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', 'mcp__inline', '--output-format', 'stream-json', '--verbose'], { cwd: path.join(ROOT, 'capture-data'), stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.on('data', (b) => { out.write(b); r.mark('event'); });
await new Promise((res) => child.on('close', res));
r.mark('done');
await sleep(2500);
await r.stop();
await shot(page, 'mcp-done');
await app.close();
