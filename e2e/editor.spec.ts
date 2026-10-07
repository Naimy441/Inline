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

test("with no side panel open, comments float beside the page and save at once", async ({ page }) => {
  await newBlankDocument(page);
  const panel = page.locator(".agent-panel");
  if (await panel.count()) await panel.getByRole("button", { name: "Close panel" }).click();
  await page.locator(".doc-content").click();
  await page.keyboard.type("A sentence worth a note.");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Control+Alt+m");
  const draft = page.locator(".comment-float .comment-card.is-draft");
  await expect(draft).toBeVisible();
  await expect(page.locator(".doc-content .comment-hl.is-draft")).toHaveCount(1);
  await page.keyboard.type("Floating note.");
  await page.keyboard.press("Enter");
  // The card is there straight away, then anchored to its saved highlight.
  await expect(page.locator(".comment-float .comment-body")).toHaveText("Floating note.");
  await expect(page.locator(".doc-content .comment-hl")).toHaveCount(1);
  await expect(page.locator(".side-panel")).toHaveCount(0);
});

test("toolbar buttons show tooltips", async ({ page }) => {
  await newBlankDocument(page);
  await page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Bold" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText(/^Bold\s+(Ctrl|⌘)\+?B$/);
});

test("spelling underlines can be hidden, and a word added to the dictionary", async ({ page }) => {
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  await page.keyboard.type("Zorblat is here.");
  // Right-click on the word itself.
  await doc.locator("p").first().click({ button: "right", position: { x: 12, y: 8 } });
  await page.getByRole("menuitem", { name: /Add “Zorblat” to dictionary/ }).click();
  await expect(doc.locator('[spellcheck="false"]')).toHaveText("Zorblat");
  await doc.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide spelling underlines" }).click();
  await expect(doc).toHaveAttribute("spellcheck", "false");
});

test("document tabs can be added, renamed, reordered, exported and deleted", async ({ page }) => {
  await newBlankDocument(page);
  const firstUrl = page.url();
  await page.locator(".doc-content").click();
  await page.keyboard.type("First tab text.");
  await page.getByRole("button", { name: "Tabs & outline" }).click();
  const pane = page.getByRole("navigation", { name: "Document tabs" });
  await pane.getByRole("button", { name: "Add tab" }).click();
  await page.waitForURL((url) => url.href !== firstUrl);
  const name = pane.getByRole("textbox", { name: "Tab name" });
  await name.fill("Notes");
  await name.press("Enter");
  await expect(pane.locator(".tab-row.is-open")).toHaveText("Notes");
  await page.locator(".doc-content").click();
  await page.keyboard.type("Second tab text.");
  await expect(page.locator(".sync-status")).toHaveText(/Saved/);
  await expect(page.locator(".status-tab")).toHaveText("Notes");

  // Drag Notes above Tab 1.
  await pane.locator("li", { hasText: "Notes" }).dragTo(pane.locator("li", { hasText: "Tab 1" }), { targetPosition: { x: 40, y: 4 } });
  await expect(pane.locator(".tab-name")).toHaveText(["Notes", "Tab 1"]);

  // Downloads include every tab, in order.
  const id = new URL(page.url()).pathname.split("/").pop();
  const markdown = await (await page.request.get(`/api/documents/${id}/export?format=md&tabs=all`)).text();
  expect(markdown.indexOf("Second tab text.")).toBeLessThan(markdown.indexOf("First tab text."));

  // The first tab can be deleted too.
  await pane.getByRole("button", { name: "Tab 1", exact: true }).click();
  await expect(page.locator(".doc-content")).toContainText("First tab text.");
  await pane.locator(".tab-row", { hasText: "Tab 1" }).hover();
  await pane.getByRole("button", { name: "Tab 1 options" }).click();
  await page.getByRole("menuitem", { name: /^Delete/ }).click();
  await page.getByRole("button", { name: "Delete tab" }).click();
  await expect(pane.locator(".tab-row")).toHaveCount(1);
  await expect(page.locator(".doc-content")).toContainText("Second tab text.");
  // The document lives on under the remaining tab.
  const firstId = new URL(firstUrl).pathname.split("/").pop();
  const list = (await (await page.request.get("/api/documents")).json()) as { documents: Array<{ id: string }> };
  expect(list.documents.some((doc) => doc.id === id)).toBe(true);
  expect(list.documents.some((doc) => doc.id === firstId)).toBe(false);
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

test("equations typed as $…$ show typeset and open for editing when clicked", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  await page.keyboard.type("Energy is $E = mc^2$ and prices like $5 and $10 stay text.");
  await expect(page.locator(".doc-content .math-render .katex")).toHaveCount(1);
  await expect(page.locator(".doc-content")).toContainText("prices like $5 and $10");
  await page.keyboard.press("Enter");
  await page.keyboard.type("$$ \\frac{a}{b}");
  await expect(page.locator(".math-block.is-editing")).toHaveCount(1);
  // Clicking the inline equation leaves the displayed one, which shows typeset.
  await page.locator("p .math-render").click();
  await expect(page.locator(".math-block .katex-display")).toHaveCount(1);
  await expect(page.locator(".math-src.is-editing")).toHaveText("E = mc^2");
  await page.keyboard.type("+1");
  await expect(page.locator(".math-pop annotation")).toHaveText("E = mc^2+1");
  await page.keyboard.press("Escape");
  await expect(page.locator(".math-src.is-editing")).toHaveCount(0);
  await expect(page.locator(".sync-status")).toHaveText(/Saved/);
  const id = page.url().split("/d/")[1];
  const markdown = await (await page.request.get(`/api/documents/${id}/export?format=md`)).text();
  expect(markdown).toContain("Energy is $E = mc^2+1$ and prices like \\$5 and \\$10 stay text.");
  expect(markdown).toContain("$$\n\\frac{a}{b}\n$$");
});

test("picking a heading in the outline scrolls the page to it", async ({ page }) => {
  const filler = "Words that fill the page so the heading starts well below the fold of the window. ".repeat(14);
  const markdown = Array.from({ length: 6 }, (_, i) => `## Part ${i + 1}\n\n${filler}\n\n${filler}`).join("\n\n");
  const { document } = await (await page.request.post("/api/documents", { data: { title: "Outline", markdown } })).json();
  await page.goto(`/d/${document.meta.id}`);
  await expect(page.locator(".doc-content h2")).toHaveCount(6);
  if (!(await page.locator(".outline").count())) await page.getByRole("button", { name: "Tabs & outline" }).click();
  await page.locator(".outline-item", { hasText: "Part 5" }).click();
  const heading = page.locator(".doc-content h2", { hasText: "Part 5" });
  await expect(heading).toBeInViewport();
});

test("the logo goes home", async ({ page }) => {
  await newBlankDocument(page);
  await page.getByRole("button", { name: "All documents" }).click();
  await page.waitForURL((url) => url.pathname === "/");
});
