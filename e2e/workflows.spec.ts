import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { GOOGLE_PASSAGE } from "../tests/support/googleClipboard";

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
    const row = page.locator(".doc-card", { hasText: title });
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

  test("Empty trash deletes everything in the trash after confirming", async ({ page, request }) => {
    const title = `Scrap ${Date.now()}`;
    const id = await createDocument(request, title, "Throwaway.");
    await request.patch(`/api/documents/${id}`, { data: { trashed: true } });
    await page.goto("/");
    await page.getByRole("tab", { name: /Trash/ }).click();
    await expect(page.locator(".doc-card", { hasText: title })).toHaveCount(1);
    await expect(page.getByText("stay in the trash until you delete them")).toBeVisible();
    await page.getByRole("button", { name: "Empty trash" }).click();
    await page.getByRole("dialog", { name: "Empty the trash?" }).getByRole("button", { name: "Delete forever" }).click();
    await expect(page.getByText("Trash is empty.")).toBeVisible();
    const list = (await (await request.get("/api/documents?trashed=1")).json()) as { documents: unknown[] };
    expect(list.documents).toHaveLength(0);
  });

  test("a Word file imports as a new document", async ({ page, request }) => {
    // Make a .docx with Inline's own exporter, then import it through the home page.
    const id = await createDocument(request, "Source", "# Imported plan\n\n- first point\n- second point\n\nClosing **bold** line.");
    const docx = await (await request.get(`/api/documents/${id}/export?format=docx`)).body();
    await page.goto("/");
    await page.locator('input[type="file"][accept*=".docx"]').setInputFiles({ name: "Plan from Word.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx });
    await expect(page).toHaveURL(/\/d\//);
    await expect(page.locator(".doc-content h1")).toHaveText("Imported plan");
    await expect(page.locator(".doc-content li")).toHaveText(["first point", "second point"]);
    await expect(page.locator(".doc-content strong")).toHaveText("bold");
  });

  test("Download all saves a backup ZIP", async ({ page, request }) => {
    await createDocument(request, "In the backup", "Hello.");
    await page.goto("/");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download all" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^Inline documents .*\.zip$/);
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
  // A 1x1 PNG.
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

  const paste = (page: Page, data: { html?: string; png?: boolean }) =>
    page.locator(".doc-content").evaluate((element, { html, png }) => {
      const transfer = new DataTransfer();
      if (html) transfer.setData("text/html", html);
      if (png) {
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        transfer.items.add(new File([bytes], "shot.png", { type: "image/png" }));
      }
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, { html: data.html, png: data.png ? PNG : undefined });

  test("pasted images are uploaded instead of kept as data URLs", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Paste images", "Text."));
    await page.locator(".doc-content").click();
    await paste(page, { png: true });
    const images = page.locator(".doc-content .doc-image img");
    await expect(images).toHaveCount(1);
    await expect(images.first()).toHaveAttribute("src", /^\/api\/uploads\//);

    await paste(page, { html: `<p>From a web page</p><img src="data:image/png;base64,${PNG}">` });
    await expect(images).toHaveCount(2);
    await expect(images.nth(1)).toHaveAttribute("src", /^\/api\/uploads\//);
  });

  test("text pasted from Google Docs is spaced, wrapped and colored as Google shows it", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "From Google", ""));
    await page.locator(".doc-content").click();
    await paste(page, { html: GOOGLE_PASSAGE });
    const blocks = page.locator(".doc-content > p");
    await expect(blocks).toHaveCount(6);
    const layout = await page.locator(".doc-content").evaluate((root) => {
      const paragraphs = Array.from(root.children) as HTMLElement[];
      // The text of each line the long paragraph wraps into, from where its letters sit.
      const lines: string[] = [];
      let top: number | null = null;
      const walker = document.createTreeWalker(paragraphs[3]!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        for (let i = 0; i < node.length; i += 1) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const box = range.getClientRects()[0];
          if (!box) continue;
          if (top === null || Math.abs(box.top - top) > 3) lines.push("");
          top = box.top;
          lines[lines.length - 1] += node.data[i];
        }
      }
      return {
        texts: paragraphs.map((p) => p.textContent?.slice(0, 8)),
        lineHeights: paragraphs.map((p) => p.style.lineHeight),
        margins: paragraphs.map((p) => getComputedStyle(p).marginBottom),
        heights: paragraphs.map((p) => Math.round(p.getBoundingClientRect().height)),
        lineEnds: lines.map((line) => line.trim().split(" ").pop()),
      };
    });
    expect(layout.texts).toEqual(["3 parts ", "", "PROLOGUE", "Scene of", "", "Certainl"]);
    expect(layout.lineHeights).toEqual(Array(6).fill("1.15"));
    expect(layout.margins).toEqual(Array(6).fill("0px"));
    // A blank line is one line tall, like a line of text.
    expect(layout.heights[1]).toBe(layout.heights[2]);
    expect(layout.heights[4]).toBe(layout.heights[2]);
    // Where Google Docs breaks the paragraph's lines: a space at the end of a line hangs past the margin.
    expect(layout.lineEnds).toEqual(["it", "a", "the", "going", "a", "era."]);

    // Google's black is the page's text color, so it turns light in dark mode.
    await page.locator("html").evaluate((html) => html.setAttribute("data-theme", "dark"));
    const colors = await page.locator(".doc-content").evaluate((root) => [getComputedStyle(root).color, getComputedStyle(root.querySelector(".text-black")!).color]);
    expect(colors[1]).toBe(colors[0]);
    expect(colors[0]).not.toBe("rgb(0, 0, 0)");
  });

  test("a pasted picture leaves a text caret after it, and copies out as a picture", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Copy a picture", "Before."));
    await page.locator(".doc-content").click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await page.keyboard.press("Enter");
    await paste(page, { html: `<meta charset="utf-8"><img src="data:image/png;base64,${PNG}">` });
    const image = page.locator(".doc-content .doc-image img");
    await expect(image).toHaveAttribute("src", /^\/api\/uploads\//);
    await expect(page.locator(".doc-content > *")).toHaveCount(3);
    await expect(page.locator(".ProseMirror-selectednode")).toHaveCount(0);
    await expect(page.locator(".ProseMirror-gapcursor")).toHaveCount(0);
    await page.keyboard.type("After");
    await expect(page.locator(".doc-content > p").last()).toHaveText("After");

    await image.click();
    await expect(page.locator(".doc-content .doc-image.ProseMirror-selectednode")).toHaveCount(1);
    const copied = await page.locator(".doc-content").evaluate(async (root) => {
      const written: Record<string, string | number> = {};
      navigator.clipboard.write = async (items) => {
        for (const item of items) for (const type of item.types) written[type] = type === "image/png" ? (await item.getType(type)).size : await (await item.getType(type)).text();
      };
      const transfer = new DataTransfer();
      root.dispatchEvent(new ClipboardEvent("copy", { clipboardData: transfer, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { html: transfer.getData("text/html"), written };
    });
    expect(copied.html).toMatch(/<img src="data:image\/png;base64,[^"]+"/);
    expect(copied.html).toMatch(/data-inline-src="http:\/\/localhost:\d+\/api\/uploads\//);
    expect(copied.written["image/png"]).toBeGreaterThan(0);
    expect(copied.written["text/html"]).toBe(copied.html);
  });

  test("a selected image can be resized by dragging its handle", async ({ page, request }) => {
    const id = await createDocument(request, "Resize", "Before.");
    await openDocument(page, id);
    await page.locator(".doc-content").click();
    await paste(page, { png: true });
    const image = page.locator(".doc-content .doc-image img");
    await expect(image).toHaveAttribute("src", /^\/api\/uploads\//);
    await image.evaluate((img) => ((img as HTMLImageElement).style.width = "200px"));
    await image.click();
    const handle = page.locator(".doc-content .image-handle-right");
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(image).toHaveAttribute("style", /width: 3\d\dpx/);
    await expect
      .poll(async () => ((await (await request.get(`/api/documents/${id}`)).json()) as { document: { doc: unknown } }).document.doc)
      .toMatchObject({ content: expect.arrayContaining([expect.objectContaining({ type: "image", attrs: expect.objectContaining({ width: expect.stringMatching(/^3\d\dpx$/) }) })]) });
  });

  test("clicking off a photo clears the selection", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Photo", "Before the photo."));
    await page.locator(".doc-content").click();
    await paste(page, { png: true });
    const image = page.locator(".doc-content .doc-image img");
    await expect(image).toHaveAttribute("src", /^\/api\/uploads\//);
    await image.evaluate((img) => ((img as HTMLImageElement).style.width = "160px"));
    const selected = page.locator(".doc-content .doc-image.ProseMirror-selectednode");

    await image.click();
    await expect(selected).toHaveCount(1);

    // The gray area around the page.
    await page.locator(".canvas").click({ position: { x: 12, y: 12 } });
    await expect(selected).toHaveCount(0);

    await image.click();
    await expect(selected).toHaveCount(1);

    // The paper margin, outside the text.
    const sheet = await page.locator(".sheet").first().boundingBox();
    expect(sheet).toBeTruthy();
    await page.mouse.click(sheet!.x + 12, sheet!.y + 12);
    await expect(selected).toHaveCount(0);

    await image.click();
    await expect(selected).toHaveCount(1);

    // Blank space beside the photo, in its line, is the photo's margin and selects it.
    const figure = await page.locator(".doc-content .doc-image").boundingBox();
    expect(figure).toBeTruthy();
    await page.mouse.click(figure!.x + 8, figure!.y + figure!.height / 2);
    await expect(selected).toHaveCount(1);
    await page.mouse.click(figure!.x + 8, figure!.y + figure!.height / 2);
    await expect(selected).toHaveCount(1);

    await image.click();
    await expect(selected).toHaveCount(1);

    // Clicking the text still places the caret, and a keyboard selection still works.
    const paragraph = page.locator(".doc-content p").first();
    await paragraph.click();
    await expect(selected).toHaveCount(0);
    await page.keyboard.press("Home");
    await page.keyboard.type("Hi ");
    await expect(paragraph).toContainText("Hi Before the photo.");
    await expect(image).toHaveCount(1);
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("Hi Before the photo.");
  });

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
    // Select the line once the editor holds it: a selection made while the document is still loading is lost.
    const addComment = page.getByRole("button", { name: "Add comment" });
    await expect(async () => {
      await page.locator(".doc-content p").first().click();
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+End");
      await expect(addComment).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
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
    await page.getByPlaceholder("Name the current version").fill("Checkpoint");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".version-row", { hasText: "Checkpoint" })).toHaveCount(1);

    const doc = page.locator(".ProseMirror");
    await doc.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("Rewritten entirely.");
    await expect(page.locator(".sync-status")).toHaveText(/Saved/);

    await page.locator(".version-row", { hasText: "Checkpoint" }).click();
    await expect(page.locator(".version-page")).toContainText("The original wording.");
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText("changes that are not a saved version")).toBeVisible();
    await page.getByRole("button", { name: "Restore anyway" }).click();
    await expect(doc).toContainText("The original wording.");
    await expect(doc).not.toContainText("Rewritten entirely.");
  });

  test("a saved version can be compared with the current text", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Compare", "The meeting is on Tuesday.\n\nSecond paragraph."));
    await menu(page, "File", "Version history");
    await page.getByPlaceholder("Name the current version").fill("Before");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".version-row", { hasText: "Before" })).toHaveCount(1);

    await page.locator(".ProseMirror").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("The meeting is on Thursday.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second paragraph.");
    await expect(page.locator(".sync-status")).toHaveText(/Saved/);

    await page.locator(".version-row", { hasText: "Before" }).click();
    await page.getByRole("tab", { name: "Since then" }).click();
    const diff = page.getByLabel("Changes since this version");
    await expect(diff.locator("del")).toHaveText("Tuesday");
    await expect(diff.locator("ins")).toHaveText("Thursday");
    await expect(page.locator(".version-stats")).toContainText("+1 −1 words");
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

  test("asks whether to include pending changes", async ({ page, request }) => {
    await openDocument(page, await createDocument(request, "Pending export", "Original text."));
    await page.locator(".doc-content").click();
    await page.keyboard.press("ControlOrMeta+Alt+Shift+X");
    await page.keyboard.press("End");
    await page.keyboard.type(" Added.");
    await expect(page.locator(".doc-content .review-insert")).toContainText("Added.");

    const download = async (choice: string) => {
      const pending = page.waitForEvent("download");
      await menu(page, "File", "Download", "Markdown (.md)");
      await page.getByRole("dialog").getByRole("button", { name: choice }).click();
      const file = await pending;
      return (await readFile((await file.path())!)).toString();
    };
    expect(await download("Without them")).toBe("Original text.");
    expect(await download("Include them")).toBe("Original text. Added.");
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

  test("pages can't be framed by other sites and send security headers", async ({ request }) => {
    const response = await request.get("/");
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("the API refuses cross-site writes", async ({ request }) => {
    const response = await request.post("/api/documents", { data: { title: "x" }, headers: { origin: "https://evil.example" } });
    expect(response.status()).toBe(403);
  });
});
