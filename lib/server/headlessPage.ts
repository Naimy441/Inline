import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Browser } from "playwright";
import type { PageAppearance } from "@/lib/pdf/screenAppearance";
import { serverOrigin } from "@/lib/server/origin";

/**
 * A PNG of one page when no editor has the document open.
 *
 * Page breaks come from the editor's pagination, which measures real line
 * boxes, so this opens the same editor in a headless browser and draws the
 * page with the same raster the open editor uses (DocumentSession.picturePage).
 * It is not a thumbnail and not a guess from the word count.
 */

export class PageOutOfRangeError extends Error {
  constructor(title: string, pages: number, page: number) {
    const plural = pages === 1 ? "" : "s";
    super(`"${title}" is ${pages} page${plural}. Pass a page from 1 to ${pages}.`);
    this.name = "PageOutOfRangeError";
  }
}

type ClosedRender = (doc: { id: string; title: string }, page: number, appearance: PageAppearance) => Promise<{ png: Uint8Array; pages: number }>;

/** Unit tests stand in for the layout browser, per document. Pass null to use the real one. */
const overrides = new Map<string, ClosedRender>();

export function setClosedDocumentRenderer(documentId: string, next: ClosedRender | null) {
  if (next) overrides.set(documentId, next);
  else overrides.delete(documentId);
}

let browserPromise: Promise<Browser> | null = null;

type LayoutLaunch = { headless?: boolean; executablePath?: string; args?: string[] };

type LayoutChromium = {
  launch: (options: LayoutLaunch) => Promise<Browser>;
  /** The Chromium binary this Playwright package installed, not a system Chrome. */
  executablePath: () => string;
};

function executableMissing(error: unknown) {
  return error instanceof Error && /Executable doesn't exist/i.test(error.message);
}

async function launchPair(launch: LayoutChromium["launch"], options: LayoutLaunch) {
  try {
    return await launch({ ...options, headless: true });
  } catch (error) {
    // Some containers refuse the sandbox. One retry, then keep the original reason.
    try {
      return await launch({ ...options, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    } catch {
      throw error;
    }
  }
}

/**
 * The Playwright CLI in this install. `playwright/package.json` is exported;
 * `playwright/cli.js` is not, so resolving that subpath throws.
 */
export function playwrightCliPath() {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  return path.join(path.dirname(req.resolve("playwright/package.json")), "cli.js");
}

/** Install the Chromium (and its headless shell) that this project's Playwright depends on. */
export function installPlaywrightBrowser() {
  const cli = playwrightCliPath();
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Couldn't install the layout browser (playwright install chromium exited ${code ?? "signal"}).`));
    });
  });
}

/**
 * Launch Playwright's layout browser. Headless mode uses its chromium shell.
 * If that shell was never downloaded, launch the Chromium this package already
 * installed, or install that browser and try again.
 */
export async function launchPlaywrightChromium(chromium: LayoutChromium, install: () => Promise<void> = installPlaywrightBrowser) {
  // Call launch on the browser type. A bare method loses Playwright's internal state.
  const launch = (options: LayoutLaunch) => chromium.launch(options);
  const configured = process.env.CHROMIUM_PATH || undefined;
  try {
    return await launchPair(launch, configured ? { executablePath: configured } : {});
  } catch (error) {
    if (configured || !executableMissing(error)) {
      const message = error instanceof Error ? error.message : "the layout browser didn't start";
      throw new Error(`Couldn't picture the page because the layout browser didn't start. ${message}`);
    }
    const installed = chromium.executablePath();
    if (installed && existsSync(installed)) {
      try {
        return await launchPair(launch, { executablePath: installed });
      } catch {
        // The recorded binary did not start. Install the browser this package depends on.
      }
    }
    await install();
    try {
      return await launchPair(launch, {});
    } catch (after) {
      const message = after instanceof Error ? after.message : "the layout browser didn't start";
      throw new Error(`Couldn't picture the page because the layout browser didn't start. ${message}`);
    }
  }
}

export async function layoutBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      let chromium: typeof import("playwright").chromium;
      try {
        chromium = (await import("playwright")).chromium;
      } catch {
        throw new Error("Couldn't picture the page because the layout browser isn't installed.");
      }
      return launchPlaywrightChromium(chromium);
    })().catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = null;
    return layoutBrowser();
  }
  return browser;
}

type PictureResult = { pages: number; png: string | null; error?: string };

/** Page `page` (1-based) of a document no editor has open, as a PNG of the laid-out page in the app's light or dark appearance. */
export async function renderClosedDocumentPage(doc: { id: string; meta: { title: string } }, page: number, appearance: PageAppearance = "light"): Promise<{ png: Uint8Array; pages: number }> {
  const hooked = overrides.get(doc.id);
  if (hooked) return hooked({ id: doc.id, title: doc.meta.title }, page, appearance);
  const origin = serverOrigin();
  if (!origin) throw new Error("Couldn't picture the page because this server has no address a browser can open.");

  const browser = await layoutBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: appearance, deviceScaleFactor: 1 });
  const token = process.env.INLINE_ACCESS_TOKEN;
  if (token) await context.addCookies([{ name: "inline_token", value: token, url: origin }]);
  const tab = await context.newPage();
  const pageErrors: string[] = [];
  tab.on("pageerror", (error) => pageErrors.push(error.message));
  tab.setDefaultTimeout(40_000);
  try {
    await tab.goto(`${origin}/render/${encodeURIComponent(doc.id)}?theme=${appearance}`, { waitUntil: "domcontentloaded", timeout: 40_000 });
    await tab.waitForFunction(
      () => {
        const root = document.documentElement;
        const status = root.dataset.renderStatus;
        const picture = (window as unknown as { __inlinePagePicture?: unknown }).__inlinePagePicture;
        return status === "error" || (status === "ready" && typeof picture === "function");
      },
      { timeout: 40_000 },
    );
    const shot = await tab.evaluate(async (pageNumber: number): Promise<PictureResult> => {
      const root = document.documentElement;
      if (root.dataset.renderStatus === "error") return { pages: 0, png: null, error: root.dataset.renderError || "Couldn't open the document." };
      const picture = (window as unknown as { __inlinePagePicture?: (page: number, scale: number) => Promise<PictureResult> }).__inlinePagePicture;
      if (!picture) return { pages: 0, png: null, error: "The page picture isn't ready." };
      return picture(pageNumber, 1.5);
    }, page);
    if (shot.error) throw new Error(shot.error);
    if (shot.pages >= 1 && page > shot.pages) throw new PageOutOfRangeError(doc.meta.title, shot.pages, page);
    if (!shot.png) throw new Error("Couldn't picture the page.");
    const png = Buffer.from(shot.png, "base64");
    if (png.byteLength < 8 || png[0] !== 0x89 || png[1] !== 0x50) throw new Error("The laid-out page wasn't a PNG.");
    return { png, pages: shot.pages };
  } catch (error) {
    if (error instanceof PageOutOfRangeError) throw error;
    const detail = pageErrors[0] ? ` ${pageErrors[0]}` : "";
    if (error instanceof Error && /Timeout/i.test(error.message)) throw new Error(`The page didn't finish laying out in time.${detail}`);
    if (error instanceof Error) throw error;
    throw new Error(`Couldn't picture the page.${detail}`);
  } finally {
    await context.close().catch(() => undefined);
  }
}
