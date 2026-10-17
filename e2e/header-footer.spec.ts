import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** Where a header or footer line's words sit in the text column (inside the page margins). */
async function placement(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const sheet = el.closest(".sheet");
    const zone = el.closest(".sheet-header, .sheet-footer");
    if (!(sheet instanceof HTMLElement) || !(zone instanceof HTMLElement)) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const box = range.getBoundingClientRect();
    const zoneStyle = getComputedStyle(zone);
    const sheetStyle = getComputedStyle(sheet);
    const sheetBox = sheet.getBoundingClientRect();
    // Fit scales the page, so padding and the edge border are CSS pixels until multiplied by that scale.
    const scale = sheet.offsetWidth > 0 ? sheetBox.width / sheet.offsetWidth : 1;
    const left = sheetBox.left + (parseFloat(sheetStyle.borderLeftWidth) + parseFloat(zoneStyle.paddingLeft)) * scale;
    const right = sheetBox.right - (parseFloat(sheetStyle.borderRightWidth) + parseFloat(zoneStyle.paddingRight)) * scale;
    return { textLeft: box.left - left, textRight: right - box.right, textMid: (box.left + box.right) / 2, mid: (left + right) / 2 };
  });
}

function isAligned(place: { textLeft: number; textRight: number; textMid: number; mid: number } | null, align: "left" | "center" | "right") {
  if (!place) return false;
  if (align === "center") return Math.abs(place.textMid - place.mid) < 8;
  if (align === "left") return Math.abs(place.textLeft) < 8;
  return Math.abs(place.textRight) < 8;
}

async function expectAligned(page: Page, selector: string, align: "left" | "center" | "right") {
  await expect.poll(async () => isAligned(await placement(page, selector), align), { message: `${selector} should sit ${align}` }).toBe(true);
}

async function bodyCaret(page: Page) {
  return page.evaluate(() => {
    const editor = document.querySelector(".doc-content");
    const selection = window.getSelection();
    if (!editor || !selection?.anchorNode || !editor.contains(selection.anchorNode) || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const before = range.cloneRange();
    before.selectNodeContents(editor);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().length;
  });
}

async function createDocument(request: APIRequestContext, title: string, markdown: string, settings: unknown) {
  const response = await request.post("/api/documents", { data: { title, markdown, settings } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { document: { meta: { id: string } } }).document.meta.id;
}

test("double-clicking a margin edits that header or footer, and alignment and page numbers follow the settings", async ({ page, request }) => {
  const id = await createDocument(request, "Margin notes", "Start here.\n\n\\pagebreak\n\nSecond page.", {
    headerFooter: { header: "{title}", headerAlign: "center", footer: "Stay", footerAlign: "left", headerRule: true },
    pageNumbers: { enabled: true, position: "header", align: "right" },
  });
  await page.goto(`/d/${id}`);
  const doc = page.locator(".doc-content");
  await expect(doc).toBeVisible();
  const sheets = page.locator(".sheet");
  await expect(sheets).toHaveCount(2);

  for (const index of [0, 1]) {
    const sheet = sheets.nth(index);
    await expect(sheet.locator(".sheet-header .sheet-line")).toHaveText("Margin notes");
    await expect(sheet.locator(".sheet-header .sheet-number")).toHaveText(String(index + 1));
    await expect(sheet.locator(".sheet-footer .sheet-number")).toHaveCount(0);
    await expect(sheet.locator(".sheet-footer .sheet-line")).toHaveText("Stay");
    const rule = await sheet.locator(".sheet-header .sheet-ruled").evaluate((el) => parseFloat(getComputedStyle(el).borderBottomWidth));
    expect(rule).toBeGreaterThan(0);
  }
  await expectAligned(page, ".sheet-header .sheet-line", "center");
  await expectAligned(page, ".sheet-header .sheet-number", "right");
  await expectAligned(page, ".sheet-footer .sheet-line", "left");

  await doc.click();
  await page.keyboard.type("Hello");
  await page.keyboard.press("Home");
  const caret = await bodyCaret(page);
  expect(caret).not.toBeNull();
  await sheets.first().locator(".sheet-header").click();
  await sheets.first().locator(".sheet-footer").click();
  expect(await bodyCaret(page)).toBe(caret);
  await expect(doc).toBeFocused();

  const header = page.getByRole("textbox", { name: "Header" });
  await sheets.first().locator(".sheet-header").dblclick();
  await expect(header).toBeFocused();
  await expect(header).toHaveValue("{title}");
  await page.keyboard.type(" · draft");
  await doc.click();
  await expect(header).toHaveCount(0);
  await expect(doc).toBeFocused();
  await expect(sheets.first().locator(".sheet-header .sheet-line")).toHaveText("Margin notes · draft");
  await expect(sheets.nth(1).locator(".sheet-header .sheet-line")).toHaveText("Margin notes · draft");
  expect(await bodyCaret(page)).not.toBeNull();

  const footer = page.getByRole("textbox", { name: "Footer" });
  await sheets.first().locator(".sheet-footer").dblclick();
  await expect(footer).toBeFocused();
  await expect(footer).toHaveValue("Stay");
  await page.keyboard.type(" put");
  await doc.click();
  await expect(footer).toHaveCount(0);
  await expect(doc).toBeFocused();
  await expect(sheets.first().locator(".sheet-footer .sheet-line")).toHaveText("Stay put");

  await expect.poll(async () => {
    const body = (await (await request.get(`/api/documents/${id}`)).json()) as { document: { meta: { settings: { headerFooter: { header: string; footer: string } } } } };
    return [body.document.meta.settings.headerFooter.header, body.document.meta.settings.headerFooter.footer];
  }).toEqual(["{title} · draft", "Stay put"]);

  for (const align of ["left", "right", "center"] as const) {
    await request.patch(`/api/documents/${id}`, { data: { settings: { headerFooter: { headerAlign: align, footerAlign: align } } } });
    await expectAligned(page, ".sheet-header .sheet-line", align);
    await expectAligned(page, ".sheet-footer .sheet-line", align);
  }
  await expect(sheets.first().locator(".sheet-header .sheet-line")).toHaveText("Margin notes · draft");
  await expect(sheets.first().locator(".sheet-footer .sheet-line")).toHaveText("Stay put");
  await expect(sheets.first().locator(".sheet-header .sheet-ruled")).toHaveCount(1);

  await request.patch(`/api/documents/${id}`, { data: { settings: { pageNumbers: { position: "footer", align: "center" } } } });
  for (const index of [0, 1]) {
    const sheet = sheets.nth(index);
    await expect(sheet.locator(".sheet-footer .sheet-number")).toHaveText(String(index + 1));
    await expect(sheet.locator(".sheet-header .sheet-number")).toHaveCount(0);
    await expect(sheet.locator(".sheet-header .sheet-line")).toHaveText("Margin notes · draft");
  }
  await expectAligned(page, ".sheet-footer .sheet-number", "center");
});
