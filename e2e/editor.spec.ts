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
