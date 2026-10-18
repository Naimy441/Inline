import { createHash } from "node:crypto";
import { layoutBrowser } from "./headlessPage";
import { serverOrigin } from "./origin";
import type { LiveDocument } from "./hub";
import { EditError } from "@/lib/doc/editing";

export async function renderCanvas(doc: LiveDocument, options: { page?: number; pdf?: boolean; preview?: string } = {}) {
  if (!doc.doc.attrs.canvas) throw new EditError("This is not a Canvas.");
  const origin = serverOrigin();
  if (!origin) throw new EditError("Open Inline in a browser before inspecting or exporting a Canvas.");
  const expected = { epoch: doc.epoch, version: doc.version };
  const fingerprint = createHash("sha256").update(JSON.stringify({ doc: doc.doc.toJSON(), settings: doc.meta.settings })).digest("hex").slice(0, 20);
  let browser;
  try {
    browser = await layoutBrowser();
  } catch (error) {
    throw new EditError(error instanceof Error ? error.message : "Canvas rendering failed.");
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1.5, colorScheme: "light" });
  try {
    if (process.env.INLINE_ACCESS_TOKEN) await context.addCookies([{ name: "inline_token", value: process.env.INLINE_ACCESS_TOKEN, url: origin }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const preview = options.preview ? `&preview=${encodeURIComponent(options.preview)}` : "";
    await page.goto(`${origin}/render/${encodeURIComponent(doc.id)}?theme=light${preview}`, { waitUntil: "domcontentloaded", timeout: 40_000 });
    await page.waitForFunction(() => document.documentElement.dataset.renderStatus === "ready" || document.documentElement.dataset.renderStatus === "error", { timeout: 40_000 });
    const report = await page.evaluate(async () => {
      if (document.documentElement.dataset.renderStatus === "error") throw new Error(document.documentElement.dataset.renderError);
      const inspect = (window as unknown as { __inlineCanvasInspect?: () => Promise<{ epoch: string; version: number; pages: number; issues: Array<{ id: string; message: string; severity?: string }>; blocks: Array<{ id: string; page: number; toPage: number }>; pageSetup: unknown }> }).__inlineCanvasInspect;
      if (!inspect) throw new Error("Canvas inspector is unavailable.");
      return inspect();
    });
    if (report.epoch !== expected.epoch || report.version !== expected.version) throw new EditError("Canvas changed while preparing its pages. Inspect/export again to use the latest revision.");
    if (errors.length) throw new EditError(`Canvas render failed: ${errors[0]}`);
    await page.locator(".page-stack").evaluate((root) => root.classList.add("is-clean"));
    const blocks = options.page ? report.blocks.filter((block) => block.page === options.page || block.toPage === options.page) : report.blocks;
    const metadata = { ...report, blocks, layoutFingerprint: fingerprint, profile: `Chromium ${browser.version()} / 96 CSS px per inch / managed fonts / light paper`, ...(options.page ? { page: options.page } : {}) };
    if (options.pdf) {
      const blocking = report.issues.filter((issue) => issue.severity !== "warning");
      if (blocking.length) throw new EditError(`Resolve Canvas layout issues before export: ${JSON.stringify(blocking)}`);
      await page.evaluate(async () => { await (window as unknown as { __inlineCanvasPrint: () => Promise<unknown> }).__inlineCanvasPrint(); });
      await page.emulateMedia({ media: "print" });
      return { report: metadata, pdf: await page.pdf({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false }), png: undefined };
    }
    if (options.page) {
      if (options.page < 1 || options.page > report.pages) throw new EditError(`Canvas has ${report.pages} pages. Choose a page from 1 to ${report.pages}.`);
      // Capture the sheet's rectangle, including the editable DOM painted over it.
      // A later page starts below a short viewport, so grow the viewport until the sheet fits.
      const sheet = page.locator(".sheet").nth(options.page - 1);
      await sheet.evaluate((element) => element.scrollIntoView({ block: "start", inline: "start" }));
      let clip = await sheet.boundingBox();
      if (!clip) throw new EditError("Canvas page is unavailable.");
      const viewport = page.viewportSize() ?? { width: 1280, height: 1000 };
      if (clip.x < 0 || clip.y < 0 || clip.x + clip.width > viewport.width - 1 || clip.y + clip.height > viewport.height - 1) {
        await page.setViewportSize({
          width: Math.max(viewport.width, Math.ceil(clip.x + clip.width + 4)),
          height: Math.max(viewport.height, Math.ceil(Math.max(0, clip.y) + clip.height + 4)),
        });
        await sheet.evaluate((element) => element.scrollIntoView({ block: "start", inline: "start" }));
        clip = await sheet.boundingBox();
      }
      if (!clip || clip.width < 2 || clip.height < 2 || clip.x < 0 || clip.y < 0) throw new EditError("Canvas page is outside the capture area.");
      return { report: metadata, png: await page.screenshot({ type: "png", clip, animations: "disabled" }), pdf: undefined };
    }
    return { report: metadata, png: undefined, pdf: undefined };
  } catch (error) { throw new EditError(error instanceof Error ? error.message : "Canvas rendering failed."); }
  finally { await context.close(); }
}
