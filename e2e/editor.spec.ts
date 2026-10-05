import { expect, test, type Page } from "@playwright/test";

async function newBlankDocument(page: Page) {
  await page.goto("/");
  await page.locator(".template-card").first().click();
  await page.waitForURL(/\/d\//);
  await expect(page.locator(".doc-content")).toBeVisible();
}

test("typing is saved and survives a reload", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  await page.keyboard.type("# Field notes\nThe first **bold** line.\n");
  await expect(page.locator(".sync-status")).toHaveText(/Saved/);
  await page.reload();
  await expect(page.locator(".doc-content h1")).toHaveText("Field notes");
  await expect(page.locator(".doc-content strong")).toHaveText("bold");
});

test("long documents flow onto a second page", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.insertText(`Paragraph ${i} with enough words to wrap across a full line of the page body text.`);
    await page.keyboard.press("Enter");
  }
  await expect(page.locator(".sheet")).toHaveCount(2);
  await expect(page.locator(".page-gap")).toHaveCount(1);
  await expect(page.locator(".statusbar")).toContainText("2 pages");
});

test("comments attach to the selected text", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  await page.keyboard.type("Commentable sentence here.");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Control+Alt+m");
  await page.keyboard.type("Needs a source.");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".comment-card .comment-body")).toHaveText("Needs a source.");
  await expect(page.locator(".doc-content .comment-hl")).toHaveCount(1);
});

test("find highlights every match", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  await page.keyboard.type("apple banana apple cherry apple");
  await page.keyboard.press("Control+f");
  await page.keyboard.type("apple");
  await expect(page.locator(".find-count")).toHaveText("1 of 3");
  await expect(page.locator(".doc-content .find-match")).toHaveCount(3);
});

test("an untitled document takes its title from the first line", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  await page.keyboard.type("Quarterly planning notes\nMore text.");
  await expect(page.locator(".title-input")).toHaveValue("Quarterly planning notes", { timeout: 10_000 });
});

test("right-click opens the editor menu", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  await page.keyboard.type("Some words to select");
  await page.locator(".doc-content p").first().click({ button: "right" });
  await expect(page.locator(".menu .menu-item", { hasText: "Paste without formatting" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".menu")).toHaveCount(0);
});

test("capitalization, special characters and table of contents", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  await page.keyboard.type("# first section\nshout this\n");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.locator(".menubar-item", { hasText: "Format" }).click();
  await page.locator(".menu-item", { hasText: /^Text/ }).click();
  await page.locator(".menu-item", { hasText: "Capitalization" }).click();
  await page.locator(".menu-item", { hasText: "UPPERCASE" }).click();
  await expect(page.locator(".doc-content p", { hasText: "SHOUT THIS" })).toHaveCount(1);

  await page.keyboard.press("End");
  await page.locator(".menubar-item", { hasText: "Insert" }).click();
  await page.locator(".menu-item", { hasText: "Special characters" }).click();
  await page.getByLabel("Search characters").fill("euro");
  await page.locator(".charmap-cell").first().click();
  await expect(page.locator(".doc-content p", { hasText: "SHOUT THIS€" })).toHaveCount(1);
  await page.keyboard.press("Escape");

  await page.locator(".menubar-item", { hasText: "Insert" }).click();
  await page.locator(".menu-item", { hasText: "Table of contents" }).click();
  await expect(page.locator('.doc-content a[href^="#"]', { hasText: "first section" })).toHaveCount(1);
});

test("focus mode hides Claude", async ({ page }) => {
  await newBlankDocument(page);
  await expect(page.locator(".claude-toggle")).toBeVisible();
  await page.locator(".menubar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: "Focus mode" }).click();
  await expect(page.locator(".claude-toggle")).toBeHidden();
  await expect(page.locator(".agent-panel")).toHaveCount(0);
});

test("suggesting mode records edits for review and viewing mode is read-only", async ({ page }) => {
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  await page.keyboard.type("Plain words (c) -> here.");
  await expect(doc).toContainText("Plain words © → here.");

  await page.locator(".tb-mode").click();
  await page.locator(".menu-item", { hasText: "Suggesting" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Suggested.");
  await expect(page.locator(".review-bar-count")).toHaveText("1 suggestion");
  await expect(page.locator(".review-insert.is-suggestion")).toContainText("Suggested.");

  await page.keyboard.press("Control+Alt+Shift+c");
  await expect(page.locator(".tb-mode")).toContainText("Viewing");
  await expect(doc).toHaveAttribute("contenteditable", "false");

  await page.keyboard.press("Control+Alt+Shift+z");
  await page.locator(".review-bar .btn-primary").click();
  await expect(page.locator(".review-bar")).toHaveCount(0);
  await expect(doc).toContainText("here. Suggested.");
});

test("non-printing characters can be shown", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  await page.keyboard.type("Two words");
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator(".doc-content .np-para")).toHaveCount(1);
  await expect(page.locator(".doc-content .np-space")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator(".doc-content .np-para")).toHaveCount(0);
});
