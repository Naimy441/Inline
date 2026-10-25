// Launches the installed Inline desktop app on the demo profile and drives it with Playwright.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '../../node_modules/playwright/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const USER_DATA = path.join(ROOT, 'capture-data', 'desktop-user');
export const DATA = path.join(USER_DATA, 'data');
export const SHOTS = path.join(ROOT, 'public', 'shots');
export const PORT = 4391;
export const BASE = `http://localhost:${PORT}`;
export const W = 1440;
export const H = 900;

fs.mkdirSync(SHOTS, { recursive: true });

export const ids = () => JSON.parse(fs.readFileSync(path.join(DATA, 'demo-ids.json'), 'utf8'));

const HIDE = `nextjs-portal, [data-nextjs-toast], .panel-warning { display: none !important; }
::-webkit-scrollbar { display: none !important; }`;

export async function launch({ theme = 'light' } = {}) {
  // The desktop app from source (current main), on a server started separately:
  // INLINE_DATA_DIR=capture-data/desktop-user/data INLINE_DESKTOP=1 next start -p 4391
  const app = await _electron.launch({
    executablePath: path.join(ROOT, '..', 'desktop', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    args: [path.join(ROOT, '..', 'desktop')],
    env: { ...process.env, INLINE_DESKTOP_USER_DATA: USER_DATA, INLINE_DEV_URL: BASE, INLINE_NO_UPDATES: '1' },
    colorScheme: theme,
    timeout: 90000,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, nativeTheme }, [w, h, theme]) => {
    nativeTheme.themeSource = theme;
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(w, h);
    win.center();
  }, [W, H, theme]);
  await page.waitForURL(/localhost/, { timeout: 90000 });
  await page.waitForLoadState('load');
  await page.addStyleTag({ content: HIDE }).catch(() => {});
  return { app, page };
}

/** The window that is currently showing Inline (the last one opened). */
export function current(app) {
  return app.windows().at(-1);
}

/** Document pages on main drop html[data-desktop]; put it back so the title bar clears the traffic lights. */
export async function chrome(page) {
  await page.addStyleTag({ content: HIDE }).catch(() => {});
  await page.evaluate(() => { if (window.inlineDesktop) document.documentElement.dataset.desktop = window.inlineDesktop.platform; }).catch(() => {});
}

export async function shot(page, name, opts = {}) {
  await chrome(page);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...opts });
  console.log('shot', name);
}

export async function go(page, url, wait = 2500) {
  await page.goto(BASE + url, { waitUntil: 'load' });
  await chrome(page);
  await page.waitForTimeout(wait);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
