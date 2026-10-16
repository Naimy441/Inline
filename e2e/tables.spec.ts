import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** Word-like table commands: merge, split, borders, a header that repeats, a column width, and a SUM. */

async function createDocument(request: APIRequestContext, title: string, markdown: string) {
  const response = await request.post("/api/documents", { data: { title, markdown } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { document: { meta: { id: string } } }).document.meta.id;
}

async function openDocument(page: Page, id: string) {
  await page.goto(`/d/${id}`);
  await expect(page.locator(".doc-content")).toBeVisible();
  await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
}

async function menu(page: Page, ...path: string[]) {
  await page.locator(".menubar-item", { hasText: path[0] }).click();
  for (const label of path.slice(1)) await page.locator(".menu-item", { hasText: label }).first().click();
}

test("a table can be merged, split, bordered, sized, summed, and repeat its header across a page", async ({ page, request }) => {
  const lines = ["| Item | Amount |", "| --- | --- |", "| Left | Right |", "| Alpha | 2 |", "| Beta | 3 |", "| Sum |  |"];
  for (let i = 1; i <= 48; i += 1) lines.push(`| Pad ${i} | 0 |`);
  await openDocument(page, await createDocument(request, "Table tools", lines.join("\n")));

  const table = page.locator(".doc-content .tableWrapper > table");
  await expect(table).toBeVisible();
  await expect(table.locator("th").first()).toHaveText("Item");

  const left = table.getByRole("cell", { name: "Left", exact: true });
  await left.click();
  await table.getByRole("cell", { name: "Right", exact: true }).click({ modifiers: ["Shift"] });
  await menu(page, "Format", "Table", "Merge cells");
  const mergedRow = table.locator("tr").nth(1);
  await expect(mergedRow.locator("td")).toHaveCount(1);
  await expect(mergedRow).toContainText("Left");
  await expect(mergedRow).toContainText("Right");

  await menu(page, "Format", "Table", "Split cell");
  await expect(mergedRow.locator("td")).toHaveCount(2);

  await table.getByRole("cell", { name: "Alpha", exact: true }).click();
  await menu(page, "Format", "Table", "Borders", "All borders");
  await expect(table).toHaveAttribute("data-borders", /"style":"solid"/);
  await expect(table.locator("td").first()).toHaveCSS("border-top-color", "rgb(0, 0, 0)");

  await menu(page, "Format", "Table", "Column width", "2 inches");
  await expect(table.locator("col").first()).toHaveCSS("width", "192px");

  const sumRow = table.locator("tr", { hasText: /^Sum/ });
  await sumRow.locator("td").nth(1).click();
  await menu(page, "Format", "Table", "Formula", "Sum above");
  const sumCell = sumRow.locator("td").nth(1);
  await expect(sumCell).toHaveText("5");
  await expect(sumCell).toHaveAttribute("data-formula", "SUM(ABOVE)");

  await expect.poll(() => page.locator(".sheet").count()).toBeGreaterThan(1);
  const repeated = page.locator("tr.page-gap .repeated-header");
  await expect(repeated).toBeVisible();
  await expect(repeated).toContainText("Item");
  await expect(repeated).toContainText("Amount");

  await expect(page.locator(".sync-status")).toHaveText(/Saved/);
  await page.reload();
  await expect(table).toHaveAttribute("data-borders", /"style":"solid"/);
  await expect(table.locator("col").first()).toHaveCSS("width", "192px");
  await expect(page.locator('.doc-content td[data-formula="SUM(ABOVE)"]')).toHaveText("5");
  await expect(page.locator("tr.page-gap .repeated-header")).toContainText("Item");
});

test("a table can be a size that is not one of the presets", async ({ page, request }) => {
  await openDocument(page, await createDocument(request, "Custom table", "Notes"));
  const doc = page.locator(".doc-content");
  await doc.click();
  await page.keyboard.press("Control+End");

  await page.locator(".menubar-item", { hasText: "Insert" }).click();
  await page.getByRole("menuitem", { name: "Table", exact: true }).click();
  await page.getByRole("gridcell", { name: "2 × 6" }).click();
  const dragged = page.locator(".doc-content .tableWrapper > table").first();
  await expect(dragged.locator("tr")).toHaveCount(2);
  await expect(dragged.locator("tr").first().locator("th")).toHaveCount(6);

  await page.keyboard.press("Control+End");
  await menu(page, "Insert", "Table", "Custom size…");
  const dialog = page.getByRole("dialog", { name: "Insert table" });
  await dialog.getByLabel("Rows").fill("2");
  await dialog.getByLabel("Columns").fill("11");
  await dialog.getByRole("button", { name: "Insert" }).click();
  const typed = page.locator(".doc-content .tableWrapper > table").nth(1);
  await expect(typed.locator("tr")).toHaveCount(2);
  await expect(typed.locator("tr").first().locator("th")).toHaveCount(11);
});
