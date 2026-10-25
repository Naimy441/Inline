import { layoutBrowser } from "./headlessPage";
import { serverOrigin } from "./origin";
import type { LiveDocument } from "./hub";
import { EditError } from "@/lib/doc/editing";
import { unrestrictedHtml } from "@/lib/canvas/unrestricted";
import { writeThumbnail } from "./store";
import { createHash } from "node:crypto";

/** Insert a <base> so relative links such as /api/documents/<id>/files/chart.png resolve against this server. */
function withBase(html: string, origin: string) {
  const base = `<base href="${origin.replace(/"/g, "&quot;")}/">`;
  return /<head[\s>]/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${base}`) : `${base}${html}`;
}

/**
 * Picture an unrestricted Canvas as a full-page PNG, exactly as its HTML
 * lays out in Chromium. Scripts run, as they do in the editor's frame.
 */
export async function renderUnrestrictedCanvas(doc: LiveDocument, options: { width?: number; theme?: "light" | "dark" } = {}) {
  const html = unrestrictedHtml(doc.doc);
  const origin = serverOrigin();
  if (!origin) throw new EditError("Open Inline in a browser before picturing a Canvas.");
  const width = Math.min(Math.max(options.width ?? 1280, 320), 2400);
  let browser;
  try {
    browser = await layoutBrowser();
  } catch (error) {
    throw new EditError(error instanceof Error ? error.message : "Canvas rendering failed.");
  }
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: options.theme ?? "light" });
  try {
    if (process.env.INLINE_ACCESS_TOKEN) await context.addCookies([{ name: "inline_token", value: process.env.INLINE_ACCESS_TOKEN, url: origin }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent(withBase(html, origin), { waitUntil: "load", timeout: 30_000 });
    const png = await page.screenshot({ type: "png", fullPage: true, animations: "disabled" });
    const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    return { png, width: size.width, height: size.height, errors };
  } catch (error) {
    throw new EditError(error instanceof Error ? error.message : "Canvas rendering failed.");
  } finally {
    await context.close();
  }
}

/** The page as a PDF, one sheet per @page, exactly as the browser prints its HTML. */
export async function exportUnrestrictedPdf(doc: LiveDocument) {
  const html = unrestrictedHtml(doc.doc);
  const origin = serverOrigin();
  if (!origin) throw new EditError("Open Inline in a browser before exporting a Canvas.");
  let browser;
  try {
    browser = await layoutBrowser();
  } catch (error) {
    throw new EditError(error instanceof Error ? error.message : "Canvas export failed.");
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  try {
    if (process.env.INLINE_ACCESS_TOKEN) await context.addCookies([{ name: "inline_token", value: process.env.INLINE_ACCESS_TOKEN, url: origin }]);
    const page = await context.newPage();
    await page.setContent(withBase(html, origin), { waitUntil: "load", timeout: 30_000 });
    await page.emulateMedia({ media: "print" });
    return await page.pdf({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  } catch (error) {
    throw new EditError(error instanceof Error ? error.message : "Canvas export failed.");
  } finally {
    await context.close();
  }
}

/**
 * Draw the first page of an unrestricted Canvas as the home page's cover. The
 * editor cannot, because the page lives in a sandboxed frame it cannot read.
 * Returns the key of what the cover shows, or null when it could not be drawn.
 */
export async function refreshUnrestrictedThumbnail(doc: LiveDocument): Promise<string | null> {
  const html = unrestrictedHtml(doc.doc);
  const origin = serverOrigin();
  if (!origin) return null;
  const key = createHash("sha256").update(`thumb2\n${html}`).digest("hex").slice(0, 16);
  if (doc.meta.thumbnailKey === key && doc.meta.thumbnailAt) return key;
  let browser;
  try {
    browser = await layoutBrowser();
  } catch {
    return null;
  }
  // 0.4 × a Letter sheet is the home page's 320 px cover.
  const context = await browser.newContext({ viewport: { width: 880, height: 1100 }, deviceScaleFactor: 0.4, colorScheme: "light" });
  try {
    if (process.env.INLINE_ACCESS_TOKEN) await context.addCookies([{ name: "inline_token", value: process.env.INLINE_ACCESS_TOKEN, url: origin }]);
    const page = await context.newPage();
    await page.setContent(withBase(html, origin), { waitUntil: "load", timeout: 30_000 });
    // The first sheet: an element named page or sheet, else the top of the document at Letter size.
    const rect = await page.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>(".page, .sheet, [data-page], section");
      const box = sheet?.getBoundingClientRect();
      return box && box.width > 200 && box.height > 200 ? { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height } : { x: 0, y: 0, width: 816, height: 1056 };
    });
    await page.setViewportSize({ width: Math.max(880, Math.ceil(rect.x + rect.width)), height: Math.max(1100, Math.ceil(rect.y + rect.height)) });
    const image = await page.screenshot({ type: "jpeg", quality: 82, clip: rect, animations: "disabled", fullPage: true });
    if (image.length > 280 * 1024) return null;
    await writeThumbnail(doc.id, new Uint8Array(image));
    doc.setThumbnail(key);
    return key;
  } catch {
    return null;
  } finally {
    await context.close();
  }
}
