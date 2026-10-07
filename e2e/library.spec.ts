import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createZip } from "../lib/doc/zip";

/** The Google Docs import tip, thumbnails for imported documents, and Claude organizing folders from the home page. */

test.describe.configure({ mode: "serial" });

async function createDocument(request: APIRequestContext, title: string, markdown = `# ${title}\n\nSome words about ${title}.`) {
  const response = await request.post("/api/documents", { data: { title, markdown } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { document: { meta: { id: string } } }).document.meta.id;
}

async function showGoogleTip(page: Page, request: APIRequestContext) {
  await request.patch("/api/preferences", { data: { googleImportDismissed: false } });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Import from Google Docs" })).toBeVisible();
}

test("the Google Docs tip explains Takeout and stays dismissed", async ({ page, request, context }) => {
  await showGoogleTip(page, request);
  const tip = page.getByRole("region", { name: "Import from Google Docs" });
  await tip.getByRole("button", { name: "takeout.google.com" }).click();
  const guide = page.getByRole("dialog", { name: "Import your Google Docs" });
  await expect(guide).toBeVisible();
  await expect(guide.getByRole("link", { name: "Open takeout.google.com" })).toHaveAttribute("href", "https://takeout.google.com/");
  await expect(guide.locator(".takeout-steps li")).toHaveCount(5);
  await guide.getByRole("button", { name: "Done" }).click();

  await tip.getByLabel("Dismiss").click();
  await expect(tip).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: /Start something new/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Import from Google Docs" })).toHaveCount(0);
  // Kept on the server too, so a fresh browser doesn't show it either.
  const other = await context.browser()!.newPage();
  await other.goto(page.url());
  await expect(other.getByRole("heading", { name: /Start something new/ })).toBeVisible();
  await expect(other.getByRole("region", { name: "Import from Google Docs" })).toHaveCount(0);
  await other.close();
});

test("importing a Takeout ZIP keeps Drive's folders, draws thumbnails and retires the tip", async ({ page, request }) => {
  const stamp = Date.now();
  const source = await createDocument(request, `Source ${stamp}`, `# Pitch ${stamp}\n\nWhy we should build it.`);
  const docx = new Uint8Array(await (await request.get(`/api/documents/${source}/export?format=docx`)).body());
  const zip = createZip([
    { name: `Takeout/Drive/Clients ${stamp}/Pitch ${stamp}.docx`, data: docx },
    { name: "Takeout/archive_browser.html", data: "<html></html>" },
  ]);
  await showGoogleTip(page, request);
  await page.getByRole("button", { name: "Show me how" }).click();
  await page.locator('input[type="file"][accept*=".zip"]').setInputFiles({ name: "takeout-001.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await expect(page.locator(".toast", { hasText: "Imported 1 document in 1 folder" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Import from Google Docs" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Import your Google Docs" })).toHaveCount(0);

  const folder = page.locator(".folder-card", { hasText: `Clients ${stamp}` });
  await expect(folder).toBeVisible();
  // The imported document was never opened, yet its cover is a real picture of the first page.
  await expect(folder.locator(".folder-tile img.cover-light")).toHaveCount(1, { timeout: 30_000 });
  const list = (await (await request.get("/api/documents")).json()) as { documents: Array<{ title: string; thumbnailAt?: number }> };
  expect(list.documents.find((doc) => doc.title === `Pitch ${stamp}`)?.thumbnailAt).toBeTruthy();
});

test("Claude files documents from the home page, and the page updates as it works", async ({ page, request }) => {
  const title = `Invoice ${Date.now()}`;
  await createDocument(request, title);
  await page.goto("/");
  await expect(page.locator(".doc-card", { hasText: title })).toBeVisible();

  await page.getByRole("button", { name: "Organize with Claude" }).click();
  const panel = page.getByRole("complementary", { name: "Claude" });
  await expect(panel.getByRole("heading", { name: "Organize with Claude" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Sort everything into folders" })).toBeVisible();
  const composer = page.getByLabel("Message Claude");
  await expect(composer).toBeEnabled();
  await composer.fill(`file "${title}" in "Finance/Invoices"`);
  await composer.press("Enter");

  const reply = panel.locator(".msg-assistant").last();
  await expect(reply).toContainText(`${title}” in Finance/Invoices.`);
  await expect(reply).toContainText("Moved a document to “Finance/Invoices”");
  // Without a reload, the document leaves the top level and the new folder shows it.
  await expect(page.locator(".doc-card", { hasText: title })).toHaveCount(0);
  const finance = page.locator(".folder-card", { hasText: "Finance" });
  await expect(finance).toBeVisible();
  await finance.click();
  await page.locator(".folder-card", { hasText: "Invoices" }).click();
  await expect(page.locator(".crumbs")).toContainText("Finance");
  await expect(page.locator(".doc-card", { hasText: title })).toBeVisible();

  // Ctrl/Cmd+J closes and reopens the panel, which keeps the chat.
  await page.keyboard.press("ControlOrMeta+j");
  await expect(panel).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByRole("complementary", { name: "Claude" }).locator(".msg-assistant").last()).toContainText("Filed");
});
