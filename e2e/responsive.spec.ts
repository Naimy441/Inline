import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Layouts by screen size. Phones reflow the text to the screen, put the
 * formatting toolbar at the bottom and open menus, panels and dialogs as
 * sheets; tablets keep pages but fold the menu bar into a "More" menu; narrow
 * desktop windows shrink pages to fit instead of scrolling sideways.
 */

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const TABLET = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };

const MEMO = "# Quarterly memo\n\nThe meeting is on Tuesday. This memo summarizes what we shipped and what slipped.\n\n- First point\n- Second point";

async function createDocument(request: APIRequestContext, title: string, markdown: string) {
  const response = await request.post("/api/documents", { data: { title, markdown } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { document: { meta: { id: string } } }).document.meta.id;
}

async function openDocument(page: Page, id: string) {
  await page.goto(`/d/${id}`);
  await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
}

/** Nothing on the page is wider than the screen. */
async function expectNoSidewaysScroll(page: Page) {
  // Web fonts change widths; measure with the real ones (ready can resolve before they're requested).
  await page.evaluate(() => Promise.all(["400 14px Inter", "600 14px Inter"].map((font) => document.fonts.load(font).catch(() => [])))); // offline: system fonts
  await page.evaluate(() => new Promise(requestAnimationFrame));
  // Mobile emulation widens the layout viewport to fit overflowing content, so compare with the screen.
  expect(await page.evaluate(() => window.innerWidth)).toBe(page.viewportSize()!.width);
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    canvas: (() => {
      const canvas = document.querySelector<HTMLElement>(".canvas");
      return canvas ? canvas.scrollWidth - canvas.clientWidth : 0;
    })(),
  }));
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.canvas).toBeLessThanOrEqual(0);
}

/** Sheets slide up; measure them once they've settled. */
async function settled(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
}

async function more(page: Page, ...path: string[]) {
  await page.getByLabel("More options").click();
  const sheet = page.locator(".menu-sheet");
  for (const label of path) await sheet.locator(".menu-item", { hasText: label }).first().click();
}

test.describe("phone", () => {
  test.use(PHONE);

  test("text reflows to the screen with the toolbar at the bottom", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Phone memo", MEMO));

    // No paper sheets: the text runs the width of the screen, less a small gutter.
    await expect(page.locator(".page-stack-wrap")).toHaveClass(/is-flow/);
    await expect(page.locator(".sheet")).toHaveCount(0);
    const text = await page.locator(".doc-content").boundingBox();
    expect(text!.x).toBeGreaterThanOrEqual(12);
    expect(text!.width).toBeGreaterThan(390 - 2 * 28);
    await expectNoSidewaysScroll(page);

    // Toolbar below the document, title bar above it; no status bar or menu bar.
    const toolbar = await page.locator(".toolbar").boundingBox();
    const canvas = await page.locator(".canvas").boundingBox();
    expect(toolbar!.y).toBeGreaterThanOrEqual(canvas!.y + canvas!.height - 1);
    expect(toolbar!.y + toolbar!.height).toBeLessThanOrEqual(844 + 1);
    await expect(page.locator(".statusbar")).toBeHidden();
    await expect(page.locator(".menubar")).toBeHidden();

    // Claude's panel waits to be asked for instead of covering the document.
    await expect(page.locator(".agent-panel")).toHaveCount(0);

    // Touch-sized controls.
    const bold = await page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Bold", exact: true }).boundingBox();
    expect(bold!.height).toBeGreaterThanOrEqual(40);
  });

  test("typing and formatting work in the reflowed layout", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Phone typing", "Hello"));
    await page.locator(".doc-content p").first().click();
    await expect(page.locator(".doc-content")).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.type(" world");
    await expect(page.locator(".doc-content")).toHaveText("Hello world");
    await page.keyboard.press("Shift+Home");
    await page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Bold", exact: true }).click();
    await expect(page.locator(".doc-content strong")).toHaveText("Hello world");
  });

  test("the More menu opens as a sheet and drills into the menus", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Phone menus", MEMO));
    await page.getByLabel("More options").click();
    const sheet = page.locator(".menu-sheet");
    await expect(sheet).toBeVisible();
    await settled(page);
    const box = await sheet.boundingBox();
    expect(box!.width).toBe(390);
    expect(Math.round(box!.y + box!.height)).toBe(844);

    await sheet.locator(".menu-item", { hasText: "Format" }).click();
    await expect(sheet.locator(".menu-sheet-back")).toHaveText("Format");
    await expect(sheet.locator(".menu-item", { hasText: "Paragraph styles" })).toBeVisible();
    await sheet.locator(".menu-sheet-back").click();
    await expect(sheet.locator(".menu-item", { hasText: "File" })).toBeVisible();

    // Tapping outside closes it.
    await page.mouse.click(195, 100);
    await expect(sheet).toHaveCount(0);
  });

  test("switching modes from the More menu", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Phone modes", "Read only please."));
    await more(page, "Mode", "Viewing");
    await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "false");
    await expect(page.locator(".toolbar")).toBeHidden();
    await more(page, "Mode", "Editing");
    await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
    await expect(page.locator(".toolbar")).toBeVisible();
  });

  test("Claude opens as a sheet, edits, and the change is kept from the review bar", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Phone Claude", "The meeting is on Tuesday."));
    await page.getByRole("button", { name: "Claude", exact: true }).click();
    const panel = page.locator(".panel-shell");
    await expect(panel).toBeVisible();
    await settled(page);
    const box = await panel.boundingBox();
    expect(box!.width).toBe(390);

    const composer = page.getByLabel("Message Claude");
    // 16px or more, so iOS doesn't zoom the page when the field is focused.
    expect(await composer.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    await composer.fill('replace "Tuesday" with "Thursday"');
    await composer.press("Enter");
    await expect(page.locator(".msg-assistant").last()).toContainText("Replaced Tuesday with Thursday.");

    // Close the sheet by tapping the dimmed document, then review in place.
    await page.locator(".panel-backdrop").click({ position: { x: 195, y: 10 } });
    await expect(panel).toHaveCount(0);
    const bar = page.locator(".review-bar");
    await expect(bar).toBeVisible();
    const barBox = await bar.boundingBox();
    expect(barBox!.x).toBeGreaterThanOrEqual(0);
    expect(barBox!.x + barBox!.width).toBeLessThanOrEqual(390);
    await bar.getByRole("button", { name: "Keep all" }).click();
    await expect(bar).toHaveCount(0);
    await expect(page.locator(".doc-content")).toHaveText("The meeting is on Thursday.");
  });

  test("dialogs rise from the bottom as sheets", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Phone dialog", MEMO));
    await more(page, "Tools", "Word count");
    const dialog = page.getByRole("dialog", { name: "Word count" });
    await expect(dialog).toBeVisible();
    await settled(page);
    const box = await dialog.boundingBox();
    expect(box!.width).toBe(390);
    expect(Math.round(box!.y + box!.height)).toBe(844);
  });

  test("a PDF is still laid out on pages", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Phone export", MEMO));
    const pending = page.waitForEvent("download");
    await more(page, "Download", "PDF");
    const file = await pending;
    const pdf = (await readFile((await file.path())!)).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf).toContain("/MediaBox [0 0 612 792]");
    // Drawn at the page's one-inch margin (72pt), not at the phone's gutter.
    expect(pdf).toMatch(/1 0 0 1 72 [\d.]+ Tm \(Quarterly\) Tj/);
    // Back to the reflowed layout afterwards.
    await expect(page.locator(".page-stack-wrap")).toHaveClass(/is-flow/);
    await expect(page.locator(".sheet")).toHaveCount(0);
  });

  test("the home page fits the screen and the new button creates a document", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".template-card").first()).toBeVisible();
    await expectNoSidewaysScroll(page);
    // Templates scroll sideways inside their own row.
    const row = page.locator(".template-row");
    expect(await row.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    // Import and Download are icon buttons that keep their names, so the heading stays on one line.
    await expect(page.getByRole("button", { name: "Import file" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download all" })).toBeVisible();
    expect((await page.locator(".home-section-head h2").first().boundingBox())!.height).toBeLessThan(30);
    // The new button floats above the document list.
    const onTop = await page.evaluate(() => {
      const fab = document.querySelector(".home-fab")!;
      const box = fab.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        onTop: Boolean(hit && fab.contains(hit)),
        hit: hit?.outerHTML.slice(0, 80),
        box: [box.x, box.y, box.width, box.height].map(Math.round),
        viewport: [innerWidth, innerHeight, visualViewport?.width, visualViewport?.height, visualViewport?.scale, scrollY],
        page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      };
    });
    expect(onTop.onTop, JSON.stringify(onTop)).toBe(true);
    await page.getByRole("button", { name: "New document" }).click();
    await expect(page).toHaveURL(/\/d\//);
    await expect(page.locator(".doc-content")).toBeVisible();
  });
});

test.describe("tablet", () => {
  test.use(TABLET);

  test("pages shrink to fit and the menus move into More", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Tablet memo", MEMO));
    await expect(page.locator(".sheet").first()).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expect(page.locator(".menubar")).toBeHidden();
    await page.getByLabel("More options").click();
    await page.locator(".menu-item", { hasText: "Insert" }).click();
    await expect(page.locator(".menu-item", { hasText: "Table of contents" })).toBeVisible();
  });
});

test.describe("narrow desktop window", () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test("Fit zoom shrinks the page beside an open panel, and a fixed zoom keeps its size", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Fit memo", MEMO));
    const toggle = page.locator(".claude-toggle");
    if (!((await toggle.getAttribute("class")) ?? "").includes("is-active")) await toggle.click();
    await expect(page.locator(".agent-panel")).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expect(page.locator(".tb-zoom")).not.toContainText("100%");

    await page.locator(".tb-zoom").click();
    await page.locator(".menu-item", { hasText: "100%" }).click();
    await expect(page.locator(".tb-zoom")).toContainText("100%");
    await page.locator(".tb-zoom").click();
    await page.locator(".menu-item", { hasText: "Fit" }).click();
    await expect(page.locator(".tb-zoom")).not.toContainText("100%");
  });
});

test.describe("connection and Claude's whereabouts", () => {
  test("losing the connection shows an offline notice that clears when it's back", async ({ page, request }) => {
    const id = await createDocument(request, "Offline memo", MEMO);
    // The live update stream can't connect: the page loads, but stays offline.
    await page.route("**/events**", (route) => route.abort());
    await openDocument(page, id);
    await expect(page.locator(".offline-notice")).toContainText("You're offline.", { timeout: 15_000 });
    // Typing still works while offline.
    await page.locator(".doc-content p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Typed offline.");
    await page.unroute("**/events**");
    await expect(page.locator(".offline-notice")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator(".sync-status")).toContainText("Saved", { timeout: 15_000 });
  });

  test("Claude's working range is marked, and a chip points to it when it's off screen", async ({ page, request }) => {
    const filler = Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1} of filler text.`).join("\n\n");
    await openDocument(page, await createDocument(request, "Long memo", `${filler}\n\nThe deadline is Friday.`));
    const toggle = page.locator(".claude-toggle");
    if (!((await toggle.getAttribute("class")) ?? "").includes("is-active")) await toggle.click();
    const composer = page.getByLabel("Message Claude");
    await composer.fill('slowly replace "Friday" with "Monday"');
    await composer.press("Enter");

    await expect(page.locator(".doc-content .agent-range.agent-editing").first()).toBeVisible();
    await page.locator(".canvas").evaluate((element) => element.scrollTo(0, 0));
    const chip = page.locator(".agent-locator");
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.locator(".doc-content .agent-caret")).toBeInViewport();
    await expect(chip).toHaveCount(0);

    await page.getByRole("button", { name: "Stop" }).click();
  });
});

test.describe("chat history", () => {
  async function chat(page: Page, text: string) {
    const toggle = page.locator(".claude-toggle");
    if (!((await toggle.getAttribute("class")) ?? "").includes("is-active")) await toggle.click();
    const composer = page.getByLabel("Message Claude");
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.locator(".msg-assistant").last()).toContainText(`You said: ${text}`);
  }

  test("is searchable and shows which document each chat belongs to", async ({ page, request }) => {
    // "All" lists every document's chats, so tag this run's chats to tell them apart.
    const tag = `t${Date.now().toString(36)}`;
    const first = await createDocument(request, `Budget plan ${tag}`, "Numbers.");
    const second = await createDocument(request, `Trip notes ${tag}`, "Places.");
    await openDocument(page, first);
    await chat(page, `draft a budget summary ${tag}`);
    await openDocument(page, second);
    await chat(page, `list museums to visit ${tag}`);
    await page.getByRole("button", { name: "New chat" }).click();
    await chat(page, `pack a light bag ${tag}`);

    await page.getByLabel("Chat history").click();
    const history = page.locator(".chat-history");
    const search = history.getByLabel("Search chats");
    await expect(history.locator(".chat-row")).toHaveCount(2);
    await search.fill("museum");
    await expect(history.locator(".chat-row")).toHaveCount(1);
    await expect(history.locator(".chat-row")).toContainText("museums");

    await history.getByRole("tab", { name: "All" }).click();
    await search.fill(tag);
    await expect(history.locator(".chat-row")).toHaveCount(3);
    const budget = history.locator(".chat-row", { hasText: "budget" });
    await expect(budget.locator(".chat-row-doc")).toHaveText(`Budget plan ${tag}`);
    await expect(history.locator(".chat-row", { hasText: "museums" }).locator(".chat-row-doc")).toHaveText("This document");
    // Searching also matches the document's title.
    await search.fill(`budget plan ${tag}`);
    await expect(history.locator(".chat-row")).toHaveCount(1);

    // A chat from another document opens that document with the chat showing.
    await budget.locator(".chat-row-main").click();
    await expect(page).toHaveURL(new RegExp(`/d/${first}`));
    await expect(page.locator(".msg-user-text").first()).toHaveText(`draft a budget summary ${tag}`);
  });
});
