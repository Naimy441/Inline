import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * A table of contents is a field: headings, dotted leaders, page numbers, and
 * links. The downloaded PDF keeps that page and a bookmark for each heading.
 */

async function newBlankDocument(page: Page) {
  await page.goto("/");
  await page.locator(".template-card").first().click();
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
  expect(text[0]).toContain("Contents");
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
  await page.locator(".menubar-item", { hasText: "Insert" }).click();
  await page.getByRole("menuitem", { name: "Remove table of contents" }).click();
  await expect(doc.locator("nav.doc-toc")).toHaveCount(0);
  await expect(doc.locator("h1", { hasText: "Introduction" })).toHaveCount(1);
});
