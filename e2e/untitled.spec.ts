import { expect, test } from "@playwright/test";

test("the Canvas tag explains the default mode on hover", async ({ page, request }) => {
  const id = (await (await request.post("/api/documents", { data: { canvas: "editorial", title: "Tag hover" } })).json()).document.meta.id;
  await page.goto(`/d/${id}`);
  await page.locator(".canvas-kind-badge").hover();
  await expect(page.locator(".tooltip")).toContainText("Default canvas mode");
});

test("empty untitled doc is deleted on leaving, written one stays", async ({ page, request }) => {
  const a = (await (await request.post("/api/documents", { data: { title: "Untitled document" } })).json()).document.meta.id;
  const c = (await (await request.post("/api/documents", { data: { canvas: "blank", title: "Untitled canvas" } })).json()).document.meta.id;
  const w = (await (await request.post("/api/documents", { data: { markdown: "Hello there" } })).json()).document.meta.id;
  for (const id of [a, c, w]) {
    await page.goto(`/d/${id}`);
    await expect(page.locator(".doc-content")).toBeVisible();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "All documents" }).click();
    await expect(page).toHaveURL(/localhost:3199\/$/);
  }
  await expect.poll(async () => (await request.get(`/api/documents/${a}`)).status()).toBe(404);
  await expect.poll(async () => (await request.get(`/api/documents/${c}`)).status()).toBe(404);
  expect((await request.get(`/api/documents/${w}`)).status()).toBe(200);
});
