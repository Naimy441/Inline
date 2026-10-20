import { expect, test, type Page } from "@playwright/test";
import { buildTestPdf } from "@/lib/pdf/import/testPdf";

/**
 * While a PDF is converting: the progress button stays hidden with the chat
 * open, the status chips stack instead of covering each other, and an agent
 * edit does not pull the page out from under a reader who is already there.
 */

function notesPdf() {
  const page = (heading: string, body: string) =>
    [`BT /F2 16 Tf 72 700 Td (${heading}) Tj ET`, `BT /F1 12 Tf 72 670 Td (${body}) Tj ET`].join("\n");
  return buildTestPdf([
    { content: page("Normal approximation", "Binomial distributions look like bell curves when n is large.") },
    { content: page("Second page", "This page is only here so the canvas can scroll.") },
    { content: page("Third page", "More room below the page Claude is editing.") },
    { content: page("Fourth page", "The bottom of the document, far from the first page.") },
  ]);
}

function overlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width - 1 && a.x + a.width > b.x + 1 && a.y < b.y + b.height - 1 && a.y + a.height > b.y + 1;
}

async function chipBoxes(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return { notice: box(".pdf-notice"), chip: box(".agent-locator"), progress: box(".pdf-notice-action") };
  });
}

function stacked(boxes: { notice: { x: number; y: number; width: number; height: number } | null; chip: { x: number; y: number; width: number; height: number } | null; progress: { x: number; y: number; width: number; height: number } | null }) {
  return Boolean(
    boxes.notice &&
      boxes.chip &&
      !overlap(boxes.notice, boxes.chip) &&
      boxes.chip.y >= boxes.notice.y + boxes.notice.height - 1 &&
      !(boxes.progress && overlap(boxes.progress, boxes.chip)),
  );
}

test("conversion chips stack, and Show progress hides while chat is open", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.locator("input[type=file][accept*='.pdf']").setInputFiles({
    name: "Lecture notes.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(notesPdf()),
  });
  await page.waitForURL(/\/d\//, { timeout: 60_000 });

  const notice = page.locator(".pdf-notice");
  const toggle = page.locator(".claude-toggle");
  const progress = page.getByRole("button", { name: "Show progress" });
  await expect(notice).toContainText("Your assistant is converting this PDF", { timeout: 30_000 });
  await expect(toggle).toHaveClass(/is-active/);
  await expect(progress).toHaveCount(0);

  // The scripted conversion leaves pages unfinished and keeps the turn open, so the
  // caret stays. Wait until its edits have stopped, then leave that page.
  await expect(page.locator(".msg-assistant").last()).toContainText("Lined up page 1", { timeout: 90_000 });
  await expect(page.locator(".doc-content .agent-caret")).toBeAttached();
  await page.waitForTimeout(800);
  const canvas = page.locator(".canvas");
  await canvas.hover();
  for (let step = 0; step < 40; step += 1) {
    const atBottom = await canvas.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 4);
    if (atBottom) break;
    await page.mouse.wheel(0, 900);
  }

  const chip = page.locator(".agent-locator");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/page/i);
  expect(stacked(await chipBoxes(page))).toBe(true);

  await toggle.click();
  await expect(progress).toBeVisible();
  await expect(chip).toBeVisible();
  await expect(notice).toContainText("pages done.");
  expect(stacked(await chipBoxes(page))).toBe(true);

  await toggle.click();
  await expect(toggle).toHaveClass(/is-active/);
  await expect(progress).toHaveCount(0);
  await page.getByRole("button", { name: "Stop" }).click();
});

test("an agent edit keeps the scroll position when that page is already on screen", async ({ page, request }) => {
  const filler = Array.from({ length: 28 }, (_, index) => `Paragraph ${index + 1} of the memo stays where the reader left it.`).join("\n\n");
  const response = await request.post("/api/documents", {
    data: { title: "Scroll hold", markdown: `${filler}\n\nThe deadline is Friday and the team should keep reading this page.` },
  });
  expect(response.status()).toBe(201);
  const id = ((await response.json()) as { document: { meta: { id: string } } }).document.meta.id;
  await page.goto(`/d/${id}`);
  await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
  const toggle = page.locator(".claude-toggle");
  if (!((await toggle.getAttribute("class")) ?? "").includes("is-active")) await toggle.click();
  const composer = page.getByLabel("Message Claude");
  await composer.fill('replace "Friday" with "Monday"');
  await composer.press("Enter");
  await expect(page.locator(".doc-content")).toContainText("Monday", { timeout: 30_000 });
  await expect(page.locator(".msg-assistant").last()).toContainText("Replaced Friday with Monday.");
  // Let the edit's scroll hold expire, then go look at the page it changed.
  await page.waitForTimeout(800);
  await page.locator(".doc-content").getByText("Monday").scrollIntoViewIfNeeded();
  const canvas = page.locator(".canvas");
  const before = await canvas.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(80);

  await composer.fill('replace "Monday" with "Wednesday"');
  await composer.press("Enter");
  await expect(page.locator(".doc-content")).toContainText("Wednesday", { timeout: 30_000 });
  await page.waitForTimeout(700);
  const after = await canvas.evaluate((element) => element.scrollTop);
  expect(Math.abs(after - before)).toBeLessThan(40);
});
