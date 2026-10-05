import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** End-to-end flows across the home page, the editor, exports and collaboration. (MCP flows live in agent-mcp.spec.ts.) */

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

test.describe("home page", () => {
  test("search, trash, restore and delete forever", async ({ page, request }) => {
    const title = `Budget ${Date.now()}`;
    await createDocument(request, title, "Numbers and plans.");
    await page.goto("/");
    const row = page.locator(".doc-row", { hasText: title });
    await expect(row).toHaveCount(1);

    await page.getByLabel("Search documents").fill("no document matches this");
    await expect(row).toHaveCount(0);
    await page.getByLabel("Search documents").fill(title.slice(0, 12));
    await expect(row).toHaveCount(1);
    await page.getByLabel("Search documents").fill("");

    await row.getByLabel("Document actions").click();
    await page.locator(".menu-item", { hasText: "Move to trash" }).click();
    await expect(row).toHaveCount(0);

    await page.getByRole("tab", { name: /Trash/ }).click();
    await expect(row).toHaveCount(1);
    await row.getByLabel("Document actions").click();
    await page.locator(".menu-item", { hasText: "Restore" }).click();
    await expect(row).toHaveCount(0);
    await page.getByRole("tab", { name: "Recent" }).click();
    await expect(row).toHaveCount(1);

    await row.getByLabel("Document actions").click();
    await page.locator(".menu-item", { hasText: "Move to trash" }).click();
    await page.getByRole("tab", { name: /Trash/ }).click();
    await row.getByLabel("Document actions").click();
    await page.locator(".menu-item", { hasText: "Delete forever" }).click();
    await expect(row).toHaveCount(0);
    const list = (await (await request.get("/api/documents?trashed=1")).json()) as { documents: Array<{ title: string }> };
    expect(list.documents.some((doc) => doc.title === title)).toBe(false);
  });

  test("dark theme persists across reloads", async ({ page }) => {
    await page.goto("/");
    const html = page.locator("html");
    const before = await html.getAttribute("data-theme");
    await page.getByRole("button", { name: before === "dark" ? "Light theme" : "Dark theme" }).click();
    const after = before === "dark" ? "light" : "dark";
    await expect(html).toHaveAttribute("data-theme", after);
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", after);
  });
});

test.describe("editing", () => {
  test("undo and redo", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Undo", "Start"));
    const doc = page.locator(".doc-content");
    await doc.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" added");
    await expect(doc).toContainText("Start added");
    await page.keyboard.press("Control+z");
    await expect(doc).not.toContainText("added");
    await page.keyboard.press("Control+Shift+z");
    await expect(doc).toContainText("Start added");
  });

  test("tables can be inserted and grown", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Table", "Before the table"));
    await page.locator(".doc-content").click();
    await page.keyboard.press("Control+End");
    await menu(page, "Insert", "Table", "2 × 2");
    await expect(page.locator(".doc-content table tr")).toHaveCount(2);
    await page.keyboard.type("Cell A");
    await menu(page, "Format", "Table", "Insert row below");
    await expect(page.locator(".doc-content table tr")).toHaveCount(3);
    await menu(page, "Format", "Table", "Insert column right");
    await expect(page.locator(".doc-content table tr").first().locator("td, th")).toHaveCount(3);
    await expect(page.locator(".doc-content table")).toContainText("Cell A");
  });

  test("find and replace all", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Replace", "red apple, red pear, red plum"));
    await page.locator(".doc-content").click();
    await page.keyboard.press("Control+h");
    await page.getByLabel("Find", { exact: true }).fill("red");
    await expect(page.locator(".find-count")).toHaveText("1 of 3");
    await page.getByLabel("Replace with").fill("green");
    await page.getByRole("button", { name: "Replace all" }).click();
    await expect(page.locator(".doc-content")).toContainText("green apple, green pear, green plum");
    await expect(page.locator(".sync-status")).toHaveText(/Saved/);
    const md = await (await request.get(`${page.url().replace(/.*\/d\//, "/api/documents/")}/export?format=md`)).text();
    expect(md.trim()).toBe("green apple, green pear, green plum");
  });

  test("comments take replies and can be resolved", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Comments", "A claim without a source."));
    await page.locator(".doc-content p").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Control+Alt+m");
    await page.keyboard.type("Which source?");
    await page.keyboard.press("Control+Enter");
    // The draft card stays until the server has saved the comment; wait for it to close.
    await expect(page.locator(".comment-card.is-draft")).toHaveCount(0);
    const card = page.locator(".comment-card", { hasText: "Which source?" });
    await card.click();
    await card.getByPlaceholder("Reply…").fill("The 2024 survey.");
    await card.getByPlaceholder("Reply…").press("Enter");
    await expect(card.locator(".comment-reply .comment-body")).toHaveText("The 2024 survey.");

    await card.getByRole("button", { name: "Resolve" }).click();
    await expect(card).toHaveCount(0);
    await expect(page.locator(".doc-content .comment-hl")).toHaveCount(0);
    await page.getByRole("button", { name: "Show resolved (1)" }).click();
    await expect(card).toHaveClass(/is-resolved/);
    await card.getByRole("button", { name: "Reopen" }).click();
    await expect(page.locator(".doc-content .comment-hl")).toHaveCount(1);
  });

  test("a saved version can be restored", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "History", "The original wording."));
    await menu(page, "File", "Version history");
    await page.getByPlaceholder("Name this version (optional)").fill("Checkpoint");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".version-row", { hasText: "Checkpoint" })).toHaveCount(1);

    const doc = page.locator(".ProseMirror");
    await doc.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("Rewritten entirely.");
    await expect(page.locator(".sync-status")).toHaveText(/Saved/);

    await page.locator(".version-row", { hasText: "Checkpoint" }).click();
    await expect(page.locator(".version-preview")).toContainText("The original wording.");
    await page.getByRole("button", { name: "Restore this version" }).click();
    await expect(doc).toContainText("The original wording.");
    await expect(doc).not.toContainText("Rewritten entirely.");
  });
});

test.describe("page layout", () => {
  test("headers, page numbers and landscape pages", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Layout report", "Body text"));
    await menu(page, "Format", "Header & footer");
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Header", { exact: true }).fill("{title} draft");
    await dialog.getByLabel("Page numbers").check();
    await dialog.getByRole("tab", { name: "Page" }).click();
    await dialog.getByLabel("Orientation").selectOption("landscape");
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(dialog).toHaveCount(0);

    const sheet = page.locator(".sheet").first();
    await expect(sheet.locator(".sheet-header")).toContainText("Layout report draft");
    await expect(sheet.locator(".sheet-number")).toHaveText("1");
    const box = (await sheet.boundingBox())!;
    expect(box.width).toBeGreaterThan(box.height);

    await page.reload();
    await expect(page.locator(".sheet").first().locator(".sheet-header")).toContainText("Layout report draft");
  });
});

test.describe("downloads", () => {
  test("Markdown, Word and PDF files", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Export me", "# Heading\n\nSome **bold** text."));

    const download = async (label: string) => {
      const pending = page.waitForEvent("download");
      await menu(page, "File", "Download", label);
      const file = await pending;
      return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
    };

    const md = await download("Markdown (.md)");
    expect(md.name).toBe("Export me.md");
    expect(md.bytes.toString()).toContain("Some **bold** text.");

    const docx = await download("Word (.docx)");
    expect(docx.name).toBe("Export me.docx");
    expect(docx.bytes.subarray(0, 2).toString()).toBe("PK");

    const pdf = await download("PDF (.pdf)");
    expect(pdf.name).toBe("Export me.pdf");
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.bytes.toString("latin1")).toContain("Heading");
  });
});

test.describe("collaboration and Claude", () => {
  test("two tabs see each other's typing", async ({ browser, request }) => {
    const id = await createDocument(request, "Shared", "Shared start");
    const context = await browser.newContext();
    const [first, second] = [await context.newPage(), await context.newPage()];
    await openDocument(first, id);
    await openDocument(second, id);
    await first.locator(".doc-content").click();
    await first.keyboard.press("Control+End");
    await first.keyboard.type(" from tab one");
    await expect(second.locator(".doc-content")).toContainText("Shared start from tab one");
    await second.locator(".doc-content").click();
    await second.keyboard.press("Control+End");
    await second.keyboard.type(" and two");
    await expect(first.locator(".doc-content")).toContainText("Shared start from tab one and two");
    await context.close();
  });

  test("the API refuses cross-site writes", async ({ request }) => {
    const response = await request.post("/api/documents", { data: { title: "x" }, headers: { origin: "https://evil.example" } });
    expect(response.status()).toBe(403);
  });
});
