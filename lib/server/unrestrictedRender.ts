import { layoutBrowser } from "./headlessPage";
import { serverOrigin } from "./origin";
import type { LiveDocument } from "./hub";
import { EditError } from "@/lib/doc/editing";
import { unrestrictedHtml } from "@/lib/canvas/unrestricted";

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
