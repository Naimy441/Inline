import { expect, test } from "@playwright/test";

test("Canvas pages are styled, editable, undoable, persistent, and version checked", async ({ page, request }) => {
  const response = await request.post("/api/documents", { data: { canvas: "editorial", title: "Canvas editing test" } });
  expect(response.ok()).toBeTruthy();
  const { document } = await response.json();
  const id = document.meta.id;
  await page.goto(`/d/${id}`);
  await expect(page.locator('.doc-content[data-canvas-root]')).toBeVisible();
  await expect(page.getByText("Canvas · editable pages")).toBeVisible();
  const heading = page.locator('.doc-content [data-id="title"]');
  await expect(heading).toHaveCSS("font-size", "56px");
  await heading.click();
  await page.keyboard.press("Home");
  await page.keyboard.type("My correction: ");
  await expect(heading).toContainText("My correction");
  await expect.poll(async () => (await (await request.get(`/api/documents/${id}/canvas`)).json()).html).toContain("My correction");
  const before = await (await request.get(`/api/documents/${id}/canvas`)).json();
  await page.getByRole("button", { name: "Edit design", exact: true }).click();
  await page.getByLabel("Stylesheet", { exact: true }).fill(before.css + '\nh1 { color: #bb3300; }');
  await page.getByRole("button", { name: "Apply design", exact: true }).click();
  await expect(heading).toHaveCSS("color", "rgb(187, 51, 0)");
  await heading.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(heading).not.toHaveCSS("color", "rgb(187, 51, 0)");
  await expect(heading).toContainText("My correction");
  await expect.poll(async () => (await (await request.get(`/api/documents/${id}/canvas`)).json()).version).toBeGreaterThan(before.version);
  const stale = await request.patch(`/api/documents/${id}/canvas`, { data: { epoch: before.epoch, version: before.version, operation: "styles", css: "" } });
  expect(stale.status()).toBe(422);
  await page.reload();
  await expect(page.locator('.doc-content [data-id="title"]')).toContainText("My correction");
  await page.getByRole("button", { name: "Check layout", exact: true }).click();
  await expect(page.getByText("Layout checked:", { exact: false })).toBeVisible();
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
