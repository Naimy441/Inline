import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * A table of contents is a field: headings, dotted leaders, page numbers, and
 * links. The downloaded PDF keeps that page and a bookmark for each heading.
 */

async function newBlankDocument(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Blank document" }).click();
  await page.waitForURL(/\/d\//);
  await expect(page.locator(".doc-content")).toBeVisible();
}

async function destinationPage(pdf: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || explicit[0] == null) return null;
  return (await pdf.getPageIndex(explicit[0])) + 1;
}

test("a table of contents lists headings with leaders and page numbers, and the PDF keeps them", async ({ page }) => {
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  await page.keyboard.type("# Introduction\nA short opening.\n");
  await page.keyboard.press("Control+Enter");
  await page.keyboard.type("# Methods\nThe second page.\n");
  // Page count sits in the corner only while chat is closed; the sheets are the pages themselves.
  await expect(page.locator(".sheet")).toHaveCount(2);

  await page.keyboard.press("Control+Home");
  await page.locator(".menubar-item", { hasText: "Insert" }).click();
  await page.getByRole("menuitem", { name: /^Table of contents/ }).click();

  const toc = doc.locator("nav.doc-toc");
  await expect(toc.locator(".doc-toc-title")).toHaveText("Contents");
  await expect(toc.locator("a.doc-toc-entry", { hasText: "Introduction" })).toBeVisible();
  await expect(toc.locator("a.doc-toc-entry", { hasText: "Methods" })).toBeVisible();

  const placed = () =>
    page.evaluate(() => {
      const sheets = [...document.querySelectorAll<HTMLElement>(".sheet")].map((el) => el.getBoundingClientRect());
      const entry = (title: string) => {
        const link = [...document.querySelectorAll<HTMLAnchorElement>("a.doc-toc-entry")].find((el) => el.querySelector(".doc-toc-label")?.textContent === title);
        const heading = [...document.querySelectorAll<HTMLElement>(".doc-content h1, .doc-content h2, .doc-content h3")].find((el) => el.textContent === title);
        const rect = heading?.getBoundingClientRect();
        const pageIndex = rect ? sheets.findIndex((sheet) => rect.top >= sheet.top - 2 && rect.top < sheet.bottom - 2) : -1;
        const leader = link?.querySelector<HTMLElement>(".doc-toc-leader");
        const before = leader ? getComputedStyle(leader, "::before").content : "";
        return {
          shown: link?.querySelector(".doc-toc-page")?.textContent ?? "",
          leader: `${leader?.textContent ?? ""}${before === "none" ? "" : before}`,
          page: pageIndex + 1,
        };
      };
      return { introduction: entry("Introduction"), methods: entry("Methods") };
    });

  const leaderDots = (value: string) => (value.match(/\./g) ?? []).length >= 3;
  await expect.poll(async () => {
    const lines = await placed();
    return {
      introduction: lines.introduction.shown === "1" && lines.introduction.page === 1 && leaderDots(lines.introduction.leader),
      methods: lines.methods.shown === "2" && lines.methods.page === 2 && leaderDots(lines.methods.leader),
    };
  }).toEqual({ introduction: true, methods: true });

  await toc.locator("a.doc-toc-entry", { hasText: "Methods" }).click();
  await expect.poll(() =>
    page.evaluate(() => {
      const node = getSelection()?.anchorNode;
      const el = node instanceof Element ? node : node?.parentElement;
      return el?.closest("h1, h2, h3")?.textContent ?? "";
    }),
  ).toBe("Methods");
  await expect(page).not.toHaveURL(/#/);

  const title = toc.locator(".doc-toc-title");
  await title.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.type("Index");
  await expect(title).toHaveText("Index");

  const caret = () =>
    page.evaluate(() => {
      const nav = document.querySelector("nav.doc-toc");
      const sel = getSelection();
      const node = sel?.anchorNode;
      const el = node instanceof Element ? node : node?.parentElement;
      const where = el?.closest(".doc-toc-title") ? "title" : el?.closest("p, h1, h2, h3") ? "text" : "other";
      return {
        gap: Boolean(document.querySelector(".ProseMirror-gapcursor")),
        outline: nav ? getComputedStyle(nav).outlineStyle : "",
        selected: nav?.classList.contains("ProseMirror-selectednode") ?? false,
        where,
      };
    });

  await title.click();
  await expect.poll(caret).toMatchObject({ gap: false, outline: "none", selected: false, where: "title" });
  // Selecting the field, which Backspace does before it deletes it, stays unoutlined.
  await expect.poll(async () => {
    await page.evaluate(() => document.querySelector("nav.doc-toc")?.classList.add("ProseMirror-selectednode"));
    return caret();
  }).toMatchObject({ outline: "none" });
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "ArrowUp", "ArrowLeft"]) {
    await page.keyboard.press(key);
    const state = await caret();
    expect(state.gap, key).toBe(false);
    expect(state.outline, key).toBe("none");
    expect(["title", "text"], key).toContain(state.where);
  }
  const box = await toc.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x + 16, box!.y + 4);
  await expect.poll(caret).toMatchObject({ gap: false, outline: "none" });
  await page.mouse.click(box!.x + 24, Math.max(8, box!.y - 6));
  await expect.poll(caret).toMatchObject({ gap: false, outline: "none" });
  expect((await caret()).where).not.toBe("other");

  await page.locator(".menubar-item", { hasText: "Insert" }).click();
  const insertItem = page.getByRole("menuitem", { name: "Table of contents", exact: true });
  await expect(insertItem).toBeVisible();
  await expect(insertItem).not.toContainText("Headings, leaders and page numbers");
  await expect(page.getByRole("menuitem", { name: "Remove table of contents" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await expect(page.locator(".sync-status")).toContainText("Saved");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  await page.getByRole("menuitem", { name: "PDF (.pdf)" }).click();
  const download = await downloadPromise;
  const file = await download.path();
  const bytes = readFileSync(file!);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const raw = bytes.toString("latin1");
  expect(raw).toContain("/Type /Outlines");
  expect(raw).toContain("/Dest [");

  const pdf = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const text: string[] = [];
  const linkPages: number[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const pdfPage = await pdf.getPage(number);
    const content = await pdfPage.getTextContent();
    text.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    for (const annot of await pdfPage.getAnnotations()) {
      if (annot.subtype !== "Link" || annot.dest == null) continue;
      const dest = await destinationPage(pdf, annot.dest);
      if (dest != null) linkPages.push(dest);
    }
  }
  expect(text[0]).toContain("Index");
  expect(text[0]).toContain("Introduction");
  expect(text.join("\n")).toContain("Methods");
  expect(linkPages).toContain(2);

  const outline = (await pdf.getOutline()) ?? [];
  const titles: Array<{ title: string; page: number | null }> = [];
  const walk = async (items: typeof outline) => {
    for (const item of items) {
      titles.push({ title: item.title, page: await destinationPage(pdf, item.dest) });
      if (item.items?.length) await walk(item.items);
    }
  };
  await walk(outline);
  expect(titles).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: "Introduction", page: 1 }),
    expect.objectContaining({ title: "Methods", page: 2 }),
  ]));
  await title.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(doc.locator("nav.doc-toc")).toHaveCount(0);
  await expect(doc.locator("h1", { hasText: "Introduction" })).toHaveCount(1);
  await expect(doc.locator("h1", { hasText: "Methods" })).toHaveCount(1);
});
