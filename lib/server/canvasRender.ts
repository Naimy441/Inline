import { createHash } from "node:crypto";
import { layoutBrowser } from "./headlessPage";
import { serverOrigin } from "./origin";
import type { LiveDocument } from "./hub";
import { EditError } from "@/lib/doc/editing";

export async function renderCanvas(doc: LiveDocument, options: { page?: number; pdf?: boolean } = {}) {
  if (!doc.doc.attrs.canvas) throw new EditError("This is not a Canvas.");
  const origin = serverOrigin();
  if (!origin) throw new EditError("Open Inline in a browser before inspecting or exporting a Canvas.");
  const expected = { epoch: doc.epoch, version: doc.version };
  const fingerprint = createHash("sha256").update(JSON.stringify({ doc: doc.doc.toJSON(), settings: doc.meta.settings })).digest("hex").slice(0, 20);
  const browser = await layoutBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1.5, colorScheme: "light" });
  try {
    if (process.env.INLINE_ACCESS_TOKEN) await context.addCookies([{ name: "inline_token", value: process.env.INLINE_ACCESS_TOKEN, url: origin }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/render/${encodeURIComponent(doc.id)}?theme=light`, { waitUntil: "domcontentloaded", timeout: 40_000 });
    await page.waitForFunction(() => document.documentElement.dataset.renderStatus === "ready" || document.documentElement.dataset.renderStatus === "error", { timeout: 40_000 });
    const report = await page.evaluate(async () => {
      if (document.documentElement.dataset.renderStatus === "error") throw new Error(document.documentElement.dataset.renderError);
      const inspect = (window as unknown as { __inlineCanvasInspect?: () => Promise<{ epoch: string; version: number; pages: number; issues: unknown[]; blocks: unknown[]; pageSetup: unknown }> }).__inlineCanvasInspect;
      if (!inspect) throw new Error("Canvas inspector is unavailable.");
      return inspect();
    });
    if (report.epoch !== expected.epoch || report.version !== expected.version) throw new EditError("Canvas changed while preparing its pages. Inspect/export again to use the latest revision.");
    if (errors.length) throw new EditError(`Canvas render failed: ${errors[0]}`);
    await page.locator(".page-stack").evaluate((root) => root.classList.add("is-clean"));
    const metadata = { ...report, layoutFingerprint: fingerprint, profile: `Chromium ${browser.version()} / 96 CSS px per inch / managed fonts / light paper`, ...(options.page ? { page: options.page } : {}) };
    if (options.pdf) {
      if (report.issues.length) throw new EditError(`Resolve Canvas layout issues before export: ${JSON.stringify(report.issues)}`);
      await page.evaluate(async () => { await (window as unknown as { __inlineCanvasPrint: () => Promise<unknown> }).__inlineCanvasPrint(); });
      await page.emulateMedia({ media: "print" });
      return { report: metadata, pdf: await page.pdf({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false }), png: undefined };
    }
    if (options.page) {
      if (options.page < 1 || options.page > report.pages) throw new EditError(`Canvas has ${report.pages} pages. Choose a page from 1 to ${report.pages}.`);
      // Capture the sheet's rectangle including the editable DOM painted over it.
      const clip = await page.locator(".sheet").nth(options.page - 1).boundingBox();
      if (!clip) throw new EditError("Canvas page is unavailable.");
      return { report: metadata, png: await page.screenshot({ type: "png", clip, animations: "disabled" }), pdf: undefined };
    }
    return { report: metadata, png: undefined, pdf: undefined };
  } catch (error) { throw new EditError(error instanceof Error ? error.message : "Canvas rendering failed."); }
  finally { await context.close(); }
}
