import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * A canvas is an Inline document made of HTML: Claude edits a section, the
 * user edits the text, a notebook cell runs, and the canvas exports to PDF.
 */

async function createCanvas(request: APIRequestContext) {
  const response = await request.post("/api/documents", { data: { title: "Canvas test", kind: "canvas" } });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { document: { meta: { id: string } } }).document.meta.id;
}

async function showClaude(page: Page) {
  await expect(page.locator(".canvas-doc")).toContainText("Start writing here. This text stays editable.");
  const toggle = page.locator(".claude-toggle");
  if (!((await toggle.getAttribute("class")) ?? "").includes("is-active")) await toggle.click();
  await expect(page.getByLabel("Message Claude")).toBeEnabled();
}

test("create a canvas, edit it with Claude and by hand, run a cell, and export a PDF", async ({ page, request }) => {
  const id = await createCanvas(request);
  await page.goto(`/d/${id}`);
  await showClaude(page);
  await expect(page.locator(".status-corner")).toContainText("Canvas");
  await expect(page.locator(".doc-content")).toBeHidden();

  const composer = page.getByLabel("Message Claude");
  await composer.fill('replace "Start writing here. This text stays editable." with "The quarter closed ahead of plan."');
  await composer.press("Enter");
  await expect(page.locator(".msg-assistant").last()).toContainText("Replaced");
  await expect(page.locator(".canvas-doc")).toContainText("The quarter closed ahead of plan.");
  await expect(page.locator(".review-bar")).toHaveCount(0);

  const field = page.locator('[data-canvas-field="intro-text"]');
  const saved = page.waitForResponse((response) => response.url().includes("/canvas") && response.request().method() === "PATCH" && response.ok());
  await field.click();
  await field.fill("The quarter closed ahead of plan. Reviewed by hand.");
  await saved;
  await expect(page.locator(".sync-status")).toContainText("Saved");
  await expect(field).toContainText("Reviewed by hand.");

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.locator(".canvas-output")).toContainText("hello from the canvas");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  await page.getByRole("menuitem", { name: "PDF (.pdf)" }).click();
  const download = await downloadPromise;
  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytes.toString("latin1")).toContain("Reviewed by hand.");
});
