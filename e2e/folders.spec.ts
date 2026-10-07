import { expect, test, type APIRequestContext } from "@playwright/test";

/** Folders on the home page: making one, filing documents in it, breadcrumbs and the list layout. */

async function createDocument(request: APIRequestContext, title: string) {
  const response = await request.post("/api/documents", { data: { title, markdown: `# ${title}\n\nSome words.` } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { document: { meta: { id: string } } }).document.meta.id;
}

test("make a folder, drag a document in, add another, and find them by breadcrumb and list view", async ({ page, request }) => {
  const stamp = Date.now();
  const first = `Plan ${stamp}`;
  const second = `Notes ${stamp}`;
  const name = `Projects ${stamp}`;
  await createDocument(request, first);
  await createDocument(request, second);
  await page.goto("/");

  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill(name);
  await page.getByRole("radio", { name: "Teal" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  const card = page.locator(".folder-card", { hasText: name });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Empty");

  // Drag a document onto the folder.
  await page.locator(".doc-card", { hasText: first }).dragTo(card);
  await expect(page.locator(".doc-card", { hasText: first })).toHaveCount(0);
  await expect(card).toContainText("1 document");
  await expect(card.locator(".folder-tile:not(.is-slot)")).toHaveCount(1);

  // Open it: the breadcrumb shows where we are, and "Add documents" files another.
  await card.click();
  await expect(page).toHaveURL(/\?folder=/);
  await expect(page.locator(".crumb.is-current")).toHaveText(name);
  await expect(page.locator(".doc-card", { hasText: first })).toBeVisible();
  await page.locator(".home-location").getByRole("button", { name: "Add documents" }).click();
  await page.getByLabel("Search your documents").fill(second);
  await page.locator(".add-doc", { hasText: second }).click();
  await page.getByRole("button", { name: "Add 1 document" }).click();
  await expect(page.locator(".doc-card", { hasText: second })).toBeVisible();

  // List view lists both, sortable by name.
  await page.getByRole("button", { name: "List view" }).click();
  const rows = page.locator(".doc-row");
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "Sort by name" }).click();
  await expect(rows.first()).toContainText(second);

  // Back to the top through the breadcrumb; the folder holds both.
  await page.locator(".crumbs").getByRole("button", { name: "All documents" }).click();
  await expect(page).not.toHaveURL(/\?folder=/);
  await expect(page.locator(".doc-row.is-folder", { hasText: name })).toContainText("2 documents");
  await page.getByRole("button", { name: "Grid view" }).click();

  // Deleting the folder sends its documents to the trash; Undo brings everything back.
  await page.locator(".folder-card", { hasText: name }).getByLabel("Folder actions").click();
  await page.locator(".menu-item", { hasText: "Delete folder" }).click();
  await expect(page.getByRole("dialog")).toContainText("2 documents inside move to the trash");
  await page.getByRole("button", { name: "Delete folder" }).click();
  await expect(page.locator(".folder-card", { hasText: name })).toHaveCount(0);
  await expect(page.locator(".doc-card", { hasText: first })).toHaveCount(0);
  await page.getByRole("tab", { name: /Trash/ }).click();
  await expect(page.locator(".doc-card", { hasText: first })).toBeVisible();
  await page.getByRole("tab", { name: "Documents" }).click();
  await page.locator(".toast", { hasText: `Deleted the folder "${name}"` }).getByRole("button", { name: "Undo" }).click();
  const restored = page.locator(".folder-card", { hasText: name });
  await expect(restored).toContainText("2 documents");
});

test("shift-click picks several items to drag into a folder or move together", async ({ page, request }) => {
  const stamp = Date.now();
  const titles = [`Alpha ${stamp}`, `Beta ${stamp}`, `Gamma ${stamp}`];
  for (const title of titles) await createDocument(request, title);
  const folderResponse = await request.post("/api/folders", { data: { name: `Bin ${stamp}` } });
  const target = ((await folderResponse.json()) as { folder: { id: string } }).folder;
  await request.post("/api/folders", { data: { name: `Shelf ${stamp}` } });
  await page.goto("/");

  const card = (title: string) => page.locator(".doc-card", { hasText: title });
  await card(titles[0]!).click({ modifiers: ["Shift"] });
  await card(titles[1]!).click({ modifiers: ["Shift"] });
  await expect(page).not.toHaveURL(/\/d\//);
  const bar = page.getByRole("toolbar", { name: "Selected items" });
  await expect(bar).toContainText("2 selected");
  await expect(card(titles[0]!)).toHaveClass(/is-selected/);

  // Once picking, a plain click picks too.
  await card(titles[2]!).click();
  await expect(bar).toContainText("3 selected");
  await card(titles[2]!).click();
  await expect(bar).toContainText("2 selected");

  // Dragging one picked card carries both.
  await card(titles[0]!).dragTo(page.locator(".folder-card", { hasText: `Bin ${stamp}` }));
  await expect(page.locator(".toast", { hasText: `Moved 2 documents to Bin ${stamp}` })).toBeVisible();
  await expect(bar).toHaveCount(0);
  await expect(card(titles[0]!)).toHaveCount(0);
  await expect(card(titles[1]!)).toHaveCount(0);
  await expect(card(titles[2]!)).toBeVisible();

  // A folder and a document picked together move with Move to…; Escape clears a selection.
  await page.locator(".folder-card", { hasText: `Shelf ${stamp}` }).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  await page.locator(".folder-card", { hasText: `Shelf ${stamp}` }).click({ modifiers: ["Shift"] });
  await card(titles[2]!).click({ modifiers: ["Shift"] });
  await bar.getByRole("button", { name: "Move to…" }).click();
  await expect(page.getByRole("dialog", { name: "Move 2 items" })).toBeVisible();
  await page.getByRole("option", { name: `Bin ${stamp}` }).click();
  await page.getByRole("button", { name: `Move to Bin ${stamp}` }).click();
  await expect(page.locator(".toast", { hasText: `Moved 2 items to Bin ${stamp}` })).toBeVisible();

  await page.goto(`/?folder=${target.id}`);
  await expect(page.locator(".folder-card", { hasText: `Shelf ${stamp}` })).toBeVisible();
  for (const title of titles) await expect(card(title)).toBeVisible();
});

test("move a document with the Move dialog, making a new folder on the way", async ({ page, request }) => {
  const title = `Report ${Date.now()}`;
  await createDocument(request, title);
  await page.goto("/");
  await page.locator(".doc-card", { hasText: title }).getByLabel("Document actions").click();
  await page.locator(".menu-item", { hasText: "Move to…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("New folder name").fill(`Archive ${title}`);
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: `Move to Archive ${title}` }).click();
  await expect(page.locator(".doc-card", { hasText: title })).toHaveCount(0);
  await page.locator(".folder-card", { hasText: `Archive ${title}` }).click();
  await expect(page.locator(".doc-card", { hasText: title })).toBeVisible();
  // Recent still lists every document, wherever it's filed.
  await page.getByRole("tab", { name: "Recent" }).click();
  await expect(page.locator(".doc-card", { hasText: title })).toBeVisible();
});
