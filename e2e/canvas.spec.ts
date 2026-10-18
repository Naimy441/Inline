import { expect, test } from "@playwright/test";

test("the home Canvas card is a blank page and opens an empty canvas", async ({ page }) => {
  await page.goto("/");
  const card = page.locator(".template-card").filter({ hasText: "Canvas" }).first();
  await expect(card).toBeVisible();
  await expect(card.locator(".template-title")).toHaveText("Canvas");
  await expect(card).not.toContainText("Designed");
  await expect(card.locator(".template-thumb")).toHaveText("");
  await expect(card.locator(".template-thumb")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(card.locator(".template-thumb")).toHaveCSS("background-color", "rgb(38, 38, 36)");
  await card.click();
  await expect(page.locator(".doc-content[data-canvas-root]")).toBeVisible();
  await expect(page.locator(".titlebar .canvas-kind-badge")).toHaveText("Canvas");
  await expect(page.locator(".canvas-design-tools")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit design", exact: true })).toHaveCount(0);
  await expect(page.locator(".doc-content")).not.toContainText("PROJECT PROPOSAL");
  await expect(page.locator(".doc-content")).not.toContainText("A better beginning");
  await expect(page.locator(".doc-content .is-empty")).toBeVisible();
});

test("Canvas pages are styled, editable, undoable, persistent, and version checked", async ({ page, request }) => {
  const response = await request.post("/api/documents", { data: { canvas: "editorial", title: "Canvas editing test" } });
  expect(response.ok()).toBeTruthy();
  const { document } = await response.json();
  const id = document.meta.id;
  await page.goto(`/d/${id}`);
  await expect(page.locator('.doc-content[data-canvas-root]')).toBeVisible();
  await expect(page.locator(".titlebar .canvas-kind-badge")).toHaveText("Canvas");
  await expect(page.locator(".canvas-design-tools")).toHaveCount(0);
  const heading = page.locator('.doc-content [data-id="title"]');
  await expect(heading).toHaveCSS("font-size", "56px");
  await heading.click();
  await page.keyboard.press("Home");
  await page.keyboard.type("My correction: ");
  await expect(heading).toContainText("My correction");
  const undo = process.platform === "darwin" ? "Meta+z" : "Control+z";
  const redo = process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z";
  let undos = 0;
  while (undos < 8 && (await heading.textContent())?.includes("My correction")) {
    await page.keyboard.press(undo);
    undos += 1;
  }
  await expect(heading).not.toContainText("My correction");
  for (let step = 0; step < undos; step += 1) await page.keyboard.press(redo);
  await expect(heading).toContainText("My correction");
  await expect.poll(async () => (await (await request.get(`/api/documents/${id}/canvas`)).json()).html).toContain("My correction");
  const before = await (await request.get(`/api/documents/${id}/canvas`)).json();
  await heading.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" extra");
  await expect.poll(async () => (await (await request.get(`/api/documents/${id}/canvas`)).json()).version).toBeGreaterThan(before.version);
  const stale = await request.patch(`/api/documents/${id}/canvas`, { data: { epoch: before.epoch, version: before.version, operation: "styles", css: "" } });
  expect(stale.status()).toBe(422);
  await page.reload();
  await expect(page.locator('.doc-content [data-id="title"]')).toContainText("My correction");
  await expect(page.locator(".titlebar .canvas-kind-badge")).toHaveText("Canvas");
  await expect(page.getByRole("button", { name: "Edit design", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check layout", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select section", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move section up", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move section down", exact: true })).toHaveCount(0);
  await expect(page.locator(".canvas-layout-notice")).toHaveCount(0);
});

test("hovering a canvas block shows a drag handle that reorders", async ({ page, request }) => {
  const response = await request.post("/api/documents", { data: { canvas: "editorial", title: "Block handles" } });
  expect(response.ok()).toBeTruthy();
  const { document } = await response.json();
  const id = document.meta.id;
  const source = await (await request.get(`/api/documents/${id}/canvas`)).json();
  const changed = await request.patch(`/api/documents/${id}/canvas`, {
    data: {
      epoch: source.epoch,
      version: source.version,
      operation: "replace",
      html: "<Canvas><Text id=\"one\">Alpha block</Text><Text id=\"two\">Beta block</Text></Canvas>",
      css: "p { font-size: 16pt; }",
    },
  });
  expect(changed.ok()).toBeTruthy();
  await page.goto(`/d/${id}`);
  const one = page.locator('.doc-content [data-id="one"]');
  const two = page.locator('.doc-content [data-id="two"]');
  await expect(one).toBeVisible();
  await expect(page.getByRole("button", { name: "Add block", exact: true })).toHaveCount(0);
  await one.hover();
  const drag = page.getByRole("button", { name: "Drag block", exact: true });
  await expect(drag).toBeVisible();
  await page.mouse.move(8, 8);
  await expect(drag).toBeHidden();
  await two.hover();
  const grip = await drag.boundingBox();
  expect(grip).toBeTruthy();
  const first = await one.boundingBox();
  expect(first).toBeTruthy();
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip!.x + grip!.width / 2, first!.y + 4, { steps: 12 });
  await expect(page.locator(".image-drop-caret")).toBeVisible();
  await page.mouse.up();
  const order = async () => page.locator(".doc-content").innerText();
  await expect.poll(order).toMatch(/Beta block[\s\S]*Alpha block/);
  await expect.poll(async () => (await (await request.get(`/api/documents/${id}/canvas`)).json()).html).toMatch(/id="two"[\s\S]*id="one"/);
});

test("a canvas page follows dark mode and print stays light", async ({ page, request }) => {
  const response = await request.post("/api/documents", { data: { canvas: "editorial", title: "Dark canvas" } });
  expect(response.ok()).toBeTruthy();
  const { document } = await response.json();
  await page.addInitScript(() => localStorage.setItem("inline-theme", "dark"));
  await page.goto(`/d/${document.meta.id}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const sheet = page.locator(".sheet").first();
  await expect(sheet).toHaveCSS("background-color", "rgb(38, 38, 36)");
  const ink = await page.locator(".doc-content[data-canvas-root]").evaluate((root) => getComputedStyle(root).color);
  const channels = ink.match(/\d+/g)?.map(Number) ?? [];
  expect(channels.reduce((sum, channel) => sum + channel, 0)).toBeGreaterThan(400);
  const opening = await page.locator('[data-id="opening"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(opening).not.toBe("rgb(238, 241, 231)");
  await page.emulateMedia({ media: "print" });
  await expect(sheet).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator(".doc-content[data-canvas-root]")).toHaveCSS("color", "rgb(37, 57, 47)");
});

test("Canvas browser export uses its actual HTML and all pages", async ({ page, request }) => {
  test.setTimeout(120_000);
  const created = await request.post("/api/documents", { data: { canvas: "research", title: "Canvas export test" } });
  const { document } = await created.json();
  const id = document.meta.id;
  await page.goto(`/d/${id}`);
  await expect(page.locator('.doc-content[data-canvas-root]')).toBeVisible();
  const source = await (await request.get(`/api/documents/${id}/canvas`)).json();
  const changed = await request.patch(`/api/documents/${id}/canvas`, { data: { epoch: source.epoch, version: source.version, operation: "replace", html: `<Canvas><Text as="h1" id="cover">A designed publication</Text><PageBreak></PageBreak><Text id="end">The second page.</Text></Canvas>`, css: "h1 {color:#123456;font-size:36pt}" } });
  expect(changed.ok()).toBeTruthy();
  await expect(page.locator(".sheet")).toHaveCount(2);
  const pdf = await request.get(`/api/documents/${id}/canvas/pdf`, { timeout: 90_000 });
  expect(pdf.ok(), await pdf.text()).toBeTruthy();
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  const bytes = await pdf.body();
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytes.byteLength).toBeGreaterThan(1000);
  const shot = await request.get(`/api/documents/${id}/canvas/render?page=2`, { timeout: 90_000 });
  expect(shot.ok(), await shot.text()).toBeTruthy();
  expect(shot.headers()["content-type"]).toBe("image/png");
  expect(shot.headers()["x-inline-pages"]).toBe("2");
});

test("a long paragraph stays editable as one paragraph across pages", async ({ page, request }) => {
  const created = await request.post("/api/documents", { data: { canvas: "research", title: "Spanning paragraph" } });
  const { document } = await created.json();
  const id = document.meta.id;
  const source = await (await request.get(`/api/documents/${id}/canvas`)).json();
  const text = "Careful editing preserves the meaning of a long document. ".repeat(150);
  const changed = await request.patch(`/api/documents/${id}/canvas`, { data: { epoch: source.epoch, version: source.version, operation: "replace", html: `<Canvas><Text id="long">${text}</Text></Canvas>`, css: "Canvas {font-family:Georgia;font-size:12pt;line-height:1.5} p {background-color:#f4e9d6}" } });
  expect(changed.ok()).toBeTruthy();
  await page.goto(`/d/${id}`);
  const paragraph = page.locator('.doc-content [data-id="long"]');
  await expect(paragraph).toBeVisible();
  await expect.poll(() => page.locator(".sheet").count()).toBeGreaterThan(1);
  await expect(paragraph).toHaveCount(1);
  await paragraph.click();
  await page.keyboard.type("A human correction. ");
  await expect(paragraph).toContainText("A human correction.");
  await expect(page.locator(".canvas-gap-mask[data-mask='desk']").first()).toBeVisible();
  const removed = await page.evaluate(() => {
    const root = document.querySelector('.doc-content [data-id="long"]');
    if (!root) return "";
    const sheets = [...document.querySelectorAll(".sheet")].map((sheet) => sheet.getBoundingClientRect());
    const pageOf = (y: number) => sheets.findIndex((rect) => y >= rect.top - 1 && y <= rect.bottom + 1);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let start: { node: Text; offset: number } | null = null;
    let end: { node: Text; offset: number } | null = null;
    let current = walker.nextNode();
    while (current) {
      const text = current as Text;
      for (let index = 0; index < text.length; index += 1) {
        const range = document.createRange();
        range.setStart(text, index);
        range.setEnd(text, Math.min(text.length, index + 1));
        const rect = range.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const at = pageOf(rect.top + rect.height / 2);
        if (at === 0 && !start) start = { node: text, offset: index };
        if (at > 0 && start) {
          end = { node: text, offset: Math.min(text.length, index + 12) };
          break;
        }
      }
      if (end) break;
      current = walker.nextNode();
    }
    if (!start || !end) return "";
    const selection = window.getSelection();
    if (!selection) return "";
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.addRange(range);
    return range.toString();
  });
  expect(removed.length).toBeGreaterThan(4);
  // Let the typed correction close its history group so undo restores only the deletion.
  await page.waitForTimeout(600);
  const before = (await paragraph.textContent()) ?? "";
  await page.keyboard.press("Backspace");
  await expect(paragraph).toHaveCount(1);
  await expect.poll(async () => (await paragraph.textContent())?.length ?? 0).toBeLessThan(before.length - 4);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect.poll(async () => paragraph.textContent()).toBe(before);
  await expect.poll(async () => (await (await request.get(`/api/documents/${id}/canvas`)).json()).html).toContain("A human correction.");
  await page.reload();
  await expect(page.locator('.doc-content [data-id="long"]')).toContainText("A human correction.");
  await expect(page.locator('.doc-content [data-id="long"]')).toHaveCount(1);
});
