import { expect, test, type Page } from "@playwright/test";

async function newBlankDocument(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Blank document" }).click();
  await page.waitForURL(/\/d\//);
  await expect(page.locator(".doc-content")).toBeVisible();
}

test("a web link and a file link can be inserted, opened, and survive a reload", async ({ page }) => {
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  await page.keyboard.type("See the notes and the file.");
  await expect(doc.locator("p").first()).toHaveText("See the notes and the file.");

  const selectWord = async (word: string) => {
    await doc.click();
    await page.keyboard.press("Home");
    const index = "See the notes and the file.".indexOf(word);
    for (let i = 0; i < index; i += 1) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < word.length; i += 1) await page.keyboard.press("Shift+ArrowRight");
  };

  await selectWord("notes");
  await page.getByRole("button", { name: "Insert link" }).click();
  await page.getByPlaceholder("Paste or type a link").fill("https://example.com/notes");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(doc.locator('a[href="https://example.com/notes"]')).toHaveText("notes");

  await selectWord("file");
  await page.getByRole("button", { name: "Insert link" }).click();
  await page.getByPlaceholder("Paste or type a link").fill("file:///tmp/notes.pdf");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(doc.locator('a[href="file:///tmp/notes.pdf"]')).toHaveText("file");

  await expect(page.locator(".sync-status")).toHaveText(/Saved/);
  await page.reload();
  await expect(doc.locator('a[href="https://example.com/notes"]')).toHaveText("notes");
  await expect(doc.locator('a[href="file:///tmp/notes.pdf"]')).toHaveText("file");

  await page.evaluate(() => {
    const opened: string[] = [];
    (window as unknown as { __opened: string[] }).__opened = opened;
    window.open = ((url?: string | URL) => {
      opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  });
  await doc.locator('a[href="https://example.com/notes"]').click({ modifiers: ["Control"] });
  await doc.locator('a[href="file:///tmp/notes.pdf"]').click({ modifiers: ["Control"] });
  await doc.locator('a[href="file:///tmp/notes.pdf"]').click();
  await page.getByRole("button", { name: "Open link" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened?: string[] }).__opened ?? [])).toEqual([
    "https://example.com/notes",
    "file:///tmp/notes.pdf",
    "file:///tmp/notes.pdf",
  ]);
});

test("links use a compact bar, and a typed URL becomes a link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  await page.keyboard.type("See the notes and the file here.");
  await expect(doc.locator("p").first()).toHaveText("See the notes and the file here.");

  const selectWord = async (word: string) => {
    await doc.locator("p").first().click();
    const selected = await page.evaluate((wanted) => {
      const root = document.querySelector(".doc-content");
      if (!(root instanceof HTMLElement)) return "";
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = node.textContent ?? "";
        const index = text.indexOf(wanted);
        if (index >= 0) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + wanted.length);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return selection?.toString() ?? "";
        }
        node = walker.nextNode();
      }
      return "";
    }, word);
    expect(selected).toBe(word);
  };

  await selectWord("notes");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByLabel("Link text")).toHaveCount(0);
  await expect(page.getByLabel("Ask Claude to edit")).toHaveCount(0);
  const url = page.getByLabel("Link URL");
  await expect(url).toBeVisible();
  const bubble = url.locator("xpath=ancestor::div[contains(@class,'bubble')]");
  const box = await bubble.boundingBox();
  await page.locator(".titlebar").click();
  await expect(url).toHaveCount(0);
  await expect(page.locator(".link-bar")).toHaveCount(0);
  expect(box).not.toBeNull();

  await selectWord("notes");
  await page.evaluate(async () => {
    await navigator.clipboard.writeText("https://example.com/from-clipboard");
  });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(url).toHaveValue("https://example.com/from-clipboard");
  await page.keyboard.press("Enter");
  await expect(doc.locator('a[href="https://example.com/from-clipboard"]')).toHaveText("notes");
  await expect(url).toHaveCount(0);

  await doc.locator('a[href="https://example.com/from-clipboard"]').click({ button: "right" });
  await expect(page.locator(".menu")).toBeVisible();
  await expect(page.locator(".link-bar")).toHaveCount(0);
  await expect(url).toHaveCount(0);
  await page.keyboard.press("Escape");

  await doc.locator('a[href="https://example.com/from-clipboard"]').click();
  const bar = page.locator(".link-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("https://example.com/from-clipboard");
  await expect(bar.getByRole("button", { name: "Open link" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Edit link" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Remove link" })).toBeVisible();
  await expect(bar.locator("img")).toHaveCount(0);
  const barBox = await bar.boundingBox();
  expect(barBox && barBox.height).toBeLessThan(56);
  await page.evaluate(() => {
    const opened: string[] = [];
    (window as unknown as { __opened: string[] }).__opened = opened;
    window.open = ((url?: string | URL) => {
      opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  });
  await bar.locator(".bubble-url").click();
  await bar.getByRole("button", { name: "Open link" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened?: string[] }).__opened ?? [])).toEqual([
    "https://example.com/from-clipboard",
    "https://example.com/from-clipboard",
  ]);

  await page.keyboard.press("End");
  await page.keyboard.type(" https://example.com");
  await page.keyboard.press("Space");
  await expect(doc.locator('a[href="https://example.com"]')).toHaveText("https://example.com");
  await page.keyboard.type("hello ");
  await expect(doc.locator("a", { hasText: "hello" })).toHaveCount(0);
  await page.keyboard.type("example.com ");
  await expect(doc.locator("a", { hasText: /^example\.com$/ })).toHaveCount(0);
  await page.keyboard.type("www.example.com");
  await page.keyboard.press("Enter");
  await expect(doc.locator('a[href="https://www.example.com"]')).toHaveText("www.example.com");
});

test("Ctrl+K prefills a granted clipboard URL and does not ask when it is not granted", async ({ page, context }) => {
  await page.addInitScript(() => {
    const clipboard = navigator.clipboard;
    const readText = clipboard.readText.bind(clipboard);
    clipboard.readText = () => {
      const mark = window as unknown as { __clipboardReads?: number };
      mark.__clipboardReads = (mark.__clipboardReads ?? 0) + 1;
      return readText();
    };
  });
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  await page.keyboard.type("Notes");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByLabel("Link URL")).toBeVisible();
  await page.waitForTimeout(400);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __clipboardReads?: number }).__clipboardReads ?? 0)).toBe(0);
  await expect(page.getByRole("button", { name: "Paste", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async () => {
    await navigator.clipboard.writeText("https://example.com/quiet");
  });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByLabel("Link URL")).toHaveValue("https://example.com/quiet");
});

test("typing is saved and survives a reload", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  await page.keyboard.type("# Field notes\nThe first **bold** line.\n");
  await expect(page.locator(".sync-status")).toHaveText(/Saved/);
  await page.reload();
  await expect(page.locator(".doc-content h1")).toHaveText("Field notes");
  await expect(page.locator(".doc-content strong")).toHaveText("bold");
});

test("font and font size apply to the phrase that was selected", async ({ page }) => {
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  const sentence = "Alpha beta gamma delta.";
  await page.keyboard.type(sentence);
  await expect(doc.locator("p").first()).toHaveText(sentence);

  const selectWord = async (word: string) => {
    await doc.click();
    await page.keyboard.press("Home");
    const index = sentence.indexOf(word);
    for (let i = 0; i < index; i += 1) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < word.length; i += 1) await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe(word);
  };

  await selectWord("beta");
  await page.getByRole("button", { name: "Font", exact: true }).click();
  const fonts = page.getByRole("listbox", { name: "Fonts" });
  await expect(fonts).toBeVisible();
  // The search box has focus, and the phrase is still the selection.
  await expect(page.getByRole("textbox", { name: "Search fonts" })).toBeFocused();
  await expect(page.locator(".format-selection")).toHaveText("beta");
  await fonts.getByRole("option", { name: "Georgia", exact: true }).click();
  const beta = doc.locator("span", { hasText: /^beta$/ });
  await expect(beta).toHaveAttribute("style", /font-family:[^;]*Georgia/);
  await expect(doc.locator("p").first()).toHaveText(sentence);
  await expect(beta).toHaveText("beta");

  await selectWord("gamma");
  const size = page.getByRole("textbox", { name: "Font size" });
  await size.click();
  await expect(size).toBeFocused();
  await expect(page.locator(".format-selection")).toHaveText("gamma");
  await size.fill("20");
  await size.press("Enter");
  const gamma = doc.locator("span", { hasText: /^gamma$/ });
  await expect(gamma).toHaveAttribute("style", /font-size:\s*20pt/);
  await expect(beta).toHaveAttribute("style", /font-family:[^;]*Georgia/);
  await expect(beta).not.toHaveAttribute("style", /font-size/);
  await expect(doc.locator("p").first()).toHaveText(sentence);

  await selectWord("delta");
  await page.getByRole("button", { name: "Increase font size" }).click();
  await page.getByRole("button", { name: "Increase font size" }).click();
  const delta = doc.locator("span", { hasText: /^delta$/ });
  await expect(delta).toHaveAttribute("style", /font-size:\s*13pt/);
  await expect(gamma).toHaveAttribute("style", /font-size:\s*20pt/);
  await expect(beta).not.toHaveAttribute("style", /font-size/);
  await expect(doc.locator("span", { hasText: /^Alpha/ })).toHaveCount(0);
});

test("a toolbar button acts on a selection the browser hasn't reported yet", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  await page.keyboard.type("Hello world");
  await expect(page.locator(".doc-content p").first()).toHaveText("Hello world");
  // Select and click in one go, before the browser's selectionchange event can reach the editor.
  await page.evaluate(() => {
    const text = document.querySelector(".doc-content p")!.firstChild!;
    window.getSelection()!.setBaseAndExtent(text, 0, text, text.textContent!.length);
    document.querySelector<HTMLButtonElement>('.toolbar [aria-label="Bold"]')!.click();
  });
  await expect(page.locator(".doc-content strong")).toHaveText("Hello world");
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
  const panel = page.locator(".agent-panel");
  if (await panel.count()) await panel.getByRole("button", { name: "Close panel" }).click();
  await expect(page.locator(".status-corner")).toContainText("2 pages");
});

test("comments attach to the selected text", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  await page.keyboard.type("A sentence worth a source.");
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

test("selecting text does not open a selection action bar", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  await page.keyboard.type("A sentence to select.");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("A sentence to select.");
  await expect(page.locator(".bubble")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask Claude" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit with Claude" })).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Italic" })).toBeVisible();
  // The document toolbar still formats the selection.
  await page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Bold" }).click();
  await expect(page.locator(".doc-content strong")).toHaveText("A sentence to select.");
});

test("toolbar buttons show tooltips", async ({ page }) => {
  await newBlankDocument(page);
  await page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Bold" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText(/^Bold\s+(Ctrl|⌘)\+?B$/);
});

test("spelling underlines misspellings as you type, and a word can be added to the dictionary", async ({ page }) => {
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  await page.keyboard.type("The righteois path.");
  const underlined = doc.locator(".spelling-error");
  // Hunspell loads with the document; the line shows up without a reload.
  // Only the misspelling is marked. "The" and "path" stay plain.
  await expect(underlined).toHaveText("righteois", { timeout: 15_000 });
  await underlined.click({ button: "right" });
  await expect(page.getByText("Shift+right-click for spelling suggestions")).toHaveCount(0);
  await expect(page.getByText("Definitions and synonyms")).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /Look up “righteois”/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Add “righteois” to dictionary/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Hide spelling underlines" })).toBeVisible();

  // A word with no red underline offers neither spelling action.
  await page.keyboard.press("Escape");
  await doc.locator("p").click({ button: "right", position: { x: 8, y: 8 } });
  await expect(page.getByRole("menuitem", { name: /Look up “The”/ })).toBeVisible();
  await expect(page.getByText("Definitions and synonyms")).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /to dictionary/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Hide spelling underlines" })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await underlined.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Add “righteois” to dictionary/ }).click();
  await expect(doc.locator(".spelling-error")).toHaveCount(0);
  await expect(doc.locator('[spellcheck="false"]')).toHaveText("righteois");

  await page.keyboard.press("End");
  await page.keyboard.type(" worng");
  const again = doc.locator(".spelling-error");
  await expect(again).toHaveText("worng", { timeout: 15_000 });
  await again.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide spelling underlines" }).click();
  await expect(doc).toHaveAttribute("spellcheck", "false");
  await expect(doc.locator(".spelling-error")).toHaveCount(0);
});

test("right-clicking a word opens definitions and synonyms", async ({ page }) => {
  await page.route("**/api/dictionary/lookup**", async (route) => {
    const word = new URL(route.request().url()).searchParams.get("word");
    if (word === "ephemeral") {
      await route.fulfill({
        json: {
          found: true,
          word: "ephemeral",
          meanings: [{ partOfSpeech: "adjective", definitions: ["Lasting for a short period of time."] }],
          synonyms: ["fleeting"],
        },
      });
      return;
    }
    await route.fulfill({ json: { found: false } });
  });
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  await page.keyboard.type("ephemeral");
  await doc.locator("p").first().click({ button: "right", position: { x: 12, y: 8 } });
  await expect(page.getByText("Shift+right-click for spelling suggestions")).toHaveCount(0);
  await expect(page.getByText("Definitions and synonyms")).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /to dictionary/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Hide spelling underlines" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: /Look up “ephemeral”/ }).click();
  const card = page.getByRole("dialog", { name: "Dictionary for ephemeral" });
  await expect(card).toContainText("Lasting for a short period of time.");
  await card.getByRole("button", { name: "Replace with fleeting" }).click();
  await expect(doc.locator("p").first()).toHaveText("fleeting");

  await page.keyboard.press("Control+a");
  await page.keyboard.type("Zorblat");
  await doc.locator("p").first().click({ button: "right", position: { x: 12, y: 8 } });
  await page.getByRole("menuitem", { name: /Look up “Zorblat”/ }).click();
  const missing = page.getByRole("dialog", { name: "Dictionary for Zorblat" });
  await expect(missing).toContainText("No dictionary entry for “Zorblat”.");
  await missing.getByRole("button", { name: "Ask Claude about “Zorblat”" }).click();
  await expect(page.getByLabel("Message Claude")).toHaveValue(/Define “Zorblat”/);
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
  await expect(page.locator(".title-tab-name")).toHaveText("Notes");
  await expect(page.locator(".status-tab")).toHaveCount(0);

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
  await expect(page.locator(".title-tab")).toHaveCount(0);
  await expect(page.locator(".status-tab")).toHaveCount(0);
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

test("the document name follows the first line until someone sets it", async ({ page }) => {
  await newBlankDocument(page);
  const title = page.locator(".title-input");
  const doc = page.locator(".doc-content");
  await expect(title).toHaveValue("Untitled document");
  await doc.click();
  await page.keyboard.type("Quarterly planning");
  await expect(title).toHaveValue("Quarterly planning");

  const styleAs = async (name: string) => {
    await page.getByRole("button", { name: "Paragraph style" }).click();
    await page.locator(".menu-text", { hasText: new RegExp(`^${name}$`) }).click();
  };
  await styleAs("Heading 1");
  await expect(doc.locator("h1")).toHaveText("Quarterly planning");
  await expect(title).toHaveValue("Quarterly planning");
  await styleAs("Title");
  await expect(doc.locator(".doc-title")).toHaveText("Quarterly planning");
  await expect(title).toHaveValue("Quarterly planning");
  await doc.locator(".doc-title").click();

  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(".title-input")!;
    const seen: string[] = [input.value];
    (window as unknown as { __titles: string[] }).__titles = seen;
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (!proto?.get || !proto.set) return;
    Object.defineProperty(input, "value", {
      configurable: true,
      get() {
        return proto.get!.call(this);
      },
      set(next: string) {
        if (seen[seen.length - 1] !== next) seen.push(next);
        proto.set!.call(this, next);
      },
    });
  });
  for (let i = 0; i < "planning".length; i += 1) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(doc.locator(".doc-title")).toHaveCount(2);
  await expect(doc.locator(".doc-title").nth(0)).toHaveText("Quarterly ");
  await expect(doc.locator(".doc-title").nth(1)).toHaveText("planning");
  await expect(title).toHaveValue("Quarterly");
  const duringSplit = await page.evaluate(() => (window as unknown as { __titles: string[] }).__titles);
  expect(duringSplit.every((value) => value !== "Untitled document")).toBe(true);
  expect(duringSplit.at(-1)).toBe("Quarterly");

  await title.click();
  await title.fill("Chosen name");
  await title.press("Enter");
  await expect(title).toHaveValue("Chosen name");
  await doc.locator(".doc-title").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" notes");
  await expect(doc.locator(".doc-title").first()).toHaveText("Quarterly  notes");
  await expect(title).toHaveValue("Chosen name");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(doc.locator(".doc-title").nth(0)).toHaveText("Qu");
  await expect(doc.locator(".doc-title").nth(1)).toHaveText("arterly  notes");
  await expect(title).toHaveValue("Chosen name");
  await expect(doc.locator(".doc-title").nth(2)).toHaveText("planning");
});

test("a long first line stays a short title while it is typed", async ({ page }) => {
  await newBlankDocument(page);
  await page.locator(".doc-content").click();
  const title = page.locator(".title-input");
  await expect(title).toHaveValue("Untitled document");
  await page.keyboard.type("This opening sentence keeps");
  await expect(title).toHaveValue("This opening sentence keeps");
  await page.keyboard.type(" going well past the point where a title would still be readable in a list");
  await expect(title).toHaveValue("This opening sentence keeps going well past the…");
  await page.keyboard.type(" and then some more words after that");
  await expect(title).toHaveValue("This opening sentence keeps going well past the…");
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
  const insertMenu = page.locator(".menu");
  await expect(insertMenu.locator(".menu-item", { hasText: "Equation" })).toBeVisible();
  await expect(insertMenu.locator(".menu-item", { hasText: "Footnote" })).toBeVisible();
  await expect(insertMenu.locator(".menu-item", { hasText: "Citation" })).toHaveCount(0);
  await expect(insertMenu.locator(".menu-item", { hasText: "Bibliography" })).toHaveCount(0);
  await expect(insertMenu.locator(".menu-item", { hasText: /^Date$/ })).toHaveCount(0);
  await insertMenu.locator(".menu-item", { hasText: "Special characters" }).click();
  const charmap = page.getByRole("dialog", { name: "Special characters" });
  await expect(charmap).toBeVisible();
  await expect(charmap).toContainText("172,808");
  await expect(charmap.locator(".charmap-code").first()).toHaveText(/^U\+[0-9A-F]{4,6}$/);
  await expect(charmap.getByLabel("Character category").locator("option")).toHaveText([
    "Symbol",
    "Punctuation",
    "Number",
    "Format & Whitespace",
    "Modifier",
    "Latin",
    "Other European Scripts",
    "American Scripts",
    "African Scripts",
    "Middle Eastern Scripts",
    "South Asian Scripts",
    "Southeast Asian Scripts",
    "Hangul",
    "Other East Asian Scripts",
    "Han",
    "Other",
  ]);
  await page.getByLabel("Search characters").fill("euro");
  await charmap.getByRole("button", { name: "EURO SIGN, U+20AC", exact: true }).click();
  await expect(page.locator(".doc-content p", { hasText: "SHOUT THIS€" })).toHaveCount(1);
  await page.getByLabel("Search characters").fill("U+00E9");
  const acute = charmap.getByRole("button", { name: "LATIN SMALL LETTER E WITH ACUTE, U+00E9", exact: true });
  await expect(acute).toBeVisible();
  await expect(acute.locator(".charmap-code")).toHaveText("U+00E9");
  await acute.click();
  await expect(page.locator(".doc-content p", { hasText: "SHOUT THIS€é" })).toHaveCount(1);

  await charmap.getByLabel("Character category").selectOption("Han");
  await charmap.getByLabel("Character block").selectOption("All blocks");
  await expect(charmap.locator(".charmap-meta")).toHaveText("Han · 114,327");
  await expect.poll(async () => charmap.locator(".charmap-cell").count()).toBeLessThan(200);
  await charmap.getByLabel("Character block").selectOption("CJK Unified Ideographs");
  const grid = charmap.locator(".charmap");
  await grid.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(charmap.getByRole("button", { name: /CJK UNIFIED IDEOGRAPH-9FFF, U\+9FFF/ })).toBeVisible();
  await expect.poll(async () => charmap.locator(".charmap-cell").count()).toBeLessThan(200);
  await page.keyboard.press("Escape");
  await page.locator(".doc-content p", { hasText: "SHOUT THIS" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type("z");
  await expect(page.locator(".doc-content p", { hasText: "SHOUT THIS€éz" })).toHaveCount(1);

  await page.locator(".menubar-item", { hasText: "Insert" }).click();
  await page.getByRole("menuitem", { name: /^Table of contents/ }).click();
  await expect(page.locator('.doc-content a[href^="#"]', { hasText: "first section" })).toHaveCount(1);
});

test("focus mode hides Claude", async ({ page }) => {
  await newBlankDocument(page);
  await expect(page.locator(".claude-toggle")).toBeVisible();
  await expect(page.locator(".doc-content .is-empty")).toBeVisible();
  const placeholder = () => page.locator(".doc-content .is-empty").evaluate((el) => getComputedStyle(el, "::before").content);
  expect(await placeholder()).toContain("ask Claude");

  await page.locator(".menubar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: "Focus mode" }).click();
  await expect(page.locator(".claude-toggle")).toBeHidden();
  await expect(page.locator(".agent-panel")).toHaveCount(0);
  await expect(page.locator(".usage-ring")).toHaveCount(0);
  expect(await placeholder()).toBe('"Start writing…"');

  await page.locator(".doc-content").click();
  await page.keyboard.type("Some words to select");
  await page.keyboard.press("ControlOrMeta+a");
  // Selecting text never opens the action bar, including while focus mode is on.
  await expect(page.locator(".bubble")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask Claude" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit with Claude" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);

  await page.locator(".menubar-item", { hasText: "View" }).click();
  await expect(page.locator(".menu-item", { hasText: "Claude panel" })).toHaveCount(0);
  await expect(page.locator(".menu-item", { hasText: "Focus mode" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator(".menubar-item", { hasText: "Tools" }).click();
  await expect(page.locator(".menu-item", { hasText: "Ask Claude" })).toHaveCount(0);
  await expect(page.locator(".menu-item", { hasText: "Check for AI-sounding writing" })).toHaveCount(0);
  await expect(page.locator(".menu-item", { hasText: "Word count" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator(".menubar-item", { hasText: "Help" }).click();
  await expect(page.locator(".menu-item", { hasText: "Connect Claude Code" })).toHaveCount(0);
  await page.locator(".menu-item", { hasText: "Keyboard shortcuts" }).click();
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts).not.toContainText("Ask Claude");
  await expect(shortcuts).not.toContainText("Show or hide Claude");
  await expect(shortcuts).toContainText("Keep the change at the cursor");
  await expect(shortcuts).toContainText("Bold");
  await page.keyboard.press("Escape");

  await page.locator(".doc-content").click({ button: "right" });
  await expect(page.locator(".menu .menu-item", { hasText: "Ask Claude" })).toHaveCount(0);
  await expect(page.locator(".menu .menu-item", { hasText: "Lock from Claude" })).toHaveCount(0);
  await expect(page.locator(".menu .menu-item", { hasText: "Comment" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator(".doc-content").click();
  await page.keyboard.press("ControlOrMeta+j");
  await page.keyboard.press("ControlOrMeta+l");
  await page.keyboard.press("ControlOrMeta+Alt+x");
  await expect(page.locator(".agent-panel")).toHaveCount(0);
  await expect(page.getByLabel("Ask Claude to edit")).toHaveCount(0);
  // ⌘K inserts a link. ⌘⇧K does not ask Claude while AI tools are hidden.
  await page.keyboard.press("ControlOrMeta+Shift+k");
  await expect(page.getByLabel("Ask Claude to edit")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByLabel("Ask Claude to edit")).toHaveCount(0);
  const linkField = page.getByPlaceholder("Paste or type a link");
  await expect(linkField).toBeVisible();
  await linkField.press("Escape");
  await expect(linkField).toHaveCount(0);

  await page.locator(".doc-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Control+Alt+m");
  await page.keyboard.type("A note.");
  await page.keyboard.press("Control+Enter");
  const card = page.locator(".comment-card", { hasText: "A note." });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "More" }).click();
  await expect(page.locator(".menu-item", { hasText: "Ask Claude to address this" })).toHaveCount(0);
  await expect(page.locator(".menu-item", { hasText: "Delete" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator(".menubar-item", { hasText: "View" }).click();
  await page.locator(".menu-item", { hasText: "Focus mode" }).click();
  await expect(page.locator(".claude-toggle")).toBeVisible();
  await page.locator(".doc-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.locator(".bubble")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask Claude" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit with Claude" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByLabel("Ask Claude to edit")).toHaveCount(0);
  await expect(page.getByPlaceholder("Paste or type a link")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Paste or type a link")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+k");
  await expect(page.getByLabel("Ask Claude to edit")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Ask Claude to edit")).toHaveCount(0);
  await page.locator(".menubar-item", { hasText: "Help" }).click();
  await expect(page.locator(".menu-item", { hasText: "Connect Claude Code" })).toBeVisible();
  await page.keyboard.press("Escape");
  await card.getByRole("button", { name: "More" }).click();
  await expect(page.locator(".menu-item", { hasText: "Ask Claude to address this" })).toBeVisible();
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

test("display equations can be cleared and deleted, and $$…$$ is a display equation", async ({ page }) => {
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  await page.keyboard.type("$$");
  await expect(page.locator(".math-block.is-editing")).toHaveCount(1);
  await page.keyboard.type("abc");
  await expect(page.locator(".math-block code")).toHaveText("abc");
  const editing = page.locator(".math-block.is-editing > .math-display");
  const background = await editing.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background === "rgba(0, 0, 0, 0)" || background === "transparent").toBe(true);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".math-display.is-empty")).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect(page.locator(".math-block")).toHaveCount(0);

  await page.keyboard.type("See $$E=mc^2$$ next.");
  await expect(page.locator(".math-block code")).toHaveText("E=mc^2");
  await expect(doc).toContainText("See");
  await expect(doc).toContainText("next.");

  const outside = "Before\n\n$$\nE=mc^2\n$$\n\nAfter";
  const deletedForward = await (await page.request.post("/api/documents", { data: { title: "Outside", markdown: outside } })).json();
  await page.goto(`/d/${deletedForward.document.meta.id}`);
  await expect(page.locator(".math-block")).toHaveCount(1);
  await page.getByText("Before", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Delete");
  await expect(page.locator(".math-block")).toHaveCount(0);

  const deletedBackward = await (await page.request.post("/api/documents", { data: { title: "Outside", markdown: outside } })).json();
  await page.goto(`/d/${deletedBackward.document.meta.id}`);
  await expect(page.locator(".math-block")).toHaveCount(1);
  await page.getByText("After", { exact: true }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".math-block")).toHaveCount(0);
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
