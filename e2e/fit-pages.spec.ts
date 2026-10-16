import { expect, test, type Page } from "@playwright/test";

async function newBlankDocument(page: Page) {
  await page.goto("/");
  await page.locator(".template-card").first().click();
  await page.waitForURL(/\/d\//);
  await expect(page.locator(".doc-content")).toBeVisible();
}

/** Natural bottom of the laid-out text, with page-gap spacers removed, over one page's content box. */
async function pageFill(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".page-stack");
    const content = document.querySelector<HTMLElement>(".page-content");
    const sheet = document.querySelector<HTMLElement>(".sheet");
    const footer = document.querySelector<HTMLElement>(".sheet-footer");
    if (!root || !content || !sheet || !footer) return null;
    const rootRect = root.getBoundingClientRect();
    const scale = rootRect.width / (root.offsetWidth || 1) || 1;
    const toLocal = (y: number) => (y - rootRect.top) / scale;
    const gaps = Array.from(root.querySelectorAll<HTMLElement>(".page-gap"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: toLocal(rect.top), height: Number(element.getAttribute("data-height")) || rect.height / scale };
      })
      .sort((a, b) => a.top - b.top);
    const natural = (y: number) => {
      let shift = 0;
      for (const gap of gaps) {
        if (gap.top < y - 0.5) shift += gap.height;
        else break;
      }
      return y - shift;
    };
    const contentHeight = sheet.offsetHeight - content.offsetTop - footer.offsetHeight;
    let bottom = 0;
    for (const block of Array.from(document.querySelectorAll<HTMLElement>(".doc-content > *"))) {
      const rect = block.getBoundingClientRect();
      if (!rect.height) continue;
      bottom = Math.max(bottom, natural(toLocal(rect.bottom)));
    }
    return {
      contentHeight,
      bottom,
      ratio: contentHeight > 0 ? bottom / contentHeight : 0,
      sheets: document.querySelectorAll(".sheet").length,
    };
  });
}

/** Bottom of the blocks the fit wrote a font size onto, in the same natural coordinates. */
async function fittedBottom(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".page-stack");
    const content = document.querySelector<HTMLElement>(".page-content");
    const sheet = document.querySelector<HTMLElement>(".sheet");
    const footer = document.querySelector<HTMLElement>(".sheet-footer");
    if (!root || !content || !sheet || !footer) return null;
    const rootRect = root.getBoundingClientRect();
    const scale = rootRect.width / (root.offsetWidth || 1) || 1;
    const toLocal = (y: number) => (y - rootRect.top) / scale;
    const gaps = Array.from(root.querySelectorAll<HTMLElement>(".page-gap"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: toLocal(rect.top), height: Number(element.getAttribute("data-height")) || rect.height / scale };
      })
      .sort((a, b) => a.top - b.top);
    const natural = (y: number) => {
      let shift = 0;
      for (const gap of gaps) {
        if (gap.top < y - 0.5) shift += gap.height;
        else break;
      }
      return y - shift;
    };
    const contentHeight = sheet.offsetHeight - content.offsetTop - footer.offsetHeight;
    let bottom = 0;
    let count = 0;
    for (const block of Array.from(document.querySelectorAll<HTMLElement>(".doc-content > *"))) {
      if (!/font-size/.test(block.getAttribute("style") || "")) continue;
      if (block.textContent?.includes("BOUNDARY KEEP") || block.textContent?.includes("Kept heading")) continue;
      const rect = block.getBoundingClientRect();
      if (!rect.height) continue;
      bottom = Math.max(bottom, natural(toLocal(rect.bottom)));
      count += 1;
    }
    return { contentHeight, bottom, count, sheets: document.querySelectorAll(".sheet").length };
  });
}

test("a partly full page fits into the top half without assuming a full page", async ({ page }) => {
  test.setTimeout(90_000);
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  let fill = await pageFill(page);
  for (let i = 0; i < 40 && !(fill && fill.sheets === 1 && fill.ratio >= 0.58 && fill.ratio <= 0.85); i += 1) {
    await page.keyboard.insertText(`Paragraph ${i} carries enough words to wrap across a full line of the page.`);
    await page.keyboard.press("Enter");
    fill = await pageFill(page);
    if (fill && fill.sheets > 1) throw new Error(`page 1 overflowed before it was partly full (${fill.ratio})`);
  }
  expect(fill?.sheets).toBe(1);
  expect(fill!.ratio).toBeGreaterThanOrEqual(0.58);
  expect(fill!.ratio).toBeLessThanOrEqual(0.85);

  await page.locator(".menubar-item", { hasText: "Format" }).click();
  await page.locator(".menu-item", { hasText: "Fit page 1 to top half" }).click();
  await expect(page.locator(".toaster")).toContainText(/pt/);
  await expect(page.locator(".toaster")).toContainText(/line spacing/);

  await expect.poll(async () => (await pageFill(page))?.ratio ?? 0, { timeout: 8_000 }).toBeGreaterThan(0.35);
  const fitted = await pageFill(page);
  expect(fitted?.sheets).toBe(1);
  expect(fitted!.ratio).toBeGreaterThan(0.35);
  expect(fitted!.ratio).toBeLessThan(0.53);
  await expect(page.locator(".page-content")).toHaveAttribute("style", /font-size:\s*11pt/);
});

test("the first two pages fit onto one page and leave styles and later text alone", async ({ page }) => {
  test.setTimeout(120_000);
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  await page.keyboard.type("# Opening");
  await page.keyboard.press("Enter");
  let fill = await pageFill(page);
  for (let i = 0; i < 80 && (fill?.sheets ?? 1) < 3; i += 1) {
    await page.keyboard.insertText(`Paragraph ${i} carries enough words to wrap across a full line of the page.`);
    await page.keyboard.press("Enter");
    fill = await pageFill(page);
  }
  expect(fill?.sheets).toBe(3);

  await page.keyboard.insertText("BOUNDARY KEEP");
  await page.keyboard.press("Enter");
  await page.keyboard.type("# Kept heading");
  await page.keyboard.press("Enter");

  const boundary = page.locator(".doc-content p", { hasText: "BOUNDARY KEEP" });
  await boundary.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.getByRole("button", { name: "Increase font size" }).click();
  await page.getByRole("button", { name: "Increase font size" }).click();
  await expect(boundary.locator("span")).toHaveAttribute("style", /font-size:\s*13pt/);

  await page.locator(".menubar-item", { hasText: "Format" }).click();
  await page.locator(".menu-item", { hasText: "Fit pages 1–2 onto one page" }).click();
  await expect(page.locator(".toaster")).toContainText(/pt/);
  await expect(page.locator(".toaster")).toContainText(/line spacing/);

  await expect
    .poll(async () => {
      const measured = await fittedBottom(page);
      if (!measured || measured.count < 2 || measured.contentHeight <= 0) return 0;
      return measured.bottom / measured.contentHeight;
    }, { timeout: 8_000 })
    .toBeGreaterThan(0.8);

  const measured = await fittedBottom(page);
  expect(measured).not.toBeNull();
  expect(measured!.bottom).toBeLessThanOrEqual(measured!.contentHeight + 4);
  expect(measured!.bottom).toBeGreaterThan(measured!.contentHeight * 0.8);
  expect(measured!.sheets).toBeLessThanOrEqual(2);

  await expect(boundary.locator("span")).toHaveAttribute("style", /font-size:\s*13pt/);
  const kept = page.locator(".doc-content h1", { hasText: "Kept heading" });
  await expect(kept).toHaveAttribute("data-style", "Heading1");
  const keptPx = await kept.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(keptPx).toBeGreaterThan(25);
  expect(keptPx).toBeLessThan(28);

  const opening = page.locator(".doc-content h1", { hasText: "Opening" });
  await expect(opening).toHaveAttribute("data-style", "Heading1");
  await expect(opening).toHaveAttribute("style", /font-size/);
  const openingPx = await opening.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(openingPx).toBeLessThan(keptPx - 1);

  const sheetCss = await page.locator(".page-stack style").first().textContent();
  expect(sheetCss).toContain('[data-style="Heading1"]');
  expect(sheetCss).toContain("font-size: 20pt");
  await expect(page.locator(".page-content")).toHaveAttribute("style", /font-size:\s*11pt/);
  await expect(page.locator(".page-content")).toHaveAttribute("style", /Arial/);
});
