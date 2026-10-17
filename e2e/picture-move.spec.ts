import { deflateSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

function widePng() {
  const width = 40;
  const height = 20;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4;
      raw[at] = x < width / 2 ? 220 : 30;
      raw[at + 1] = x < width / 2 ? 40 : 70;
      raw[at + 2] = x < width / 2 ? 40 : 210;
      raw[at + 3] = 255;
    }
  }
  const crc = (data: Buffer) => {
    let c = ~0;
    for (const byte of data) {
      c ^= byte;
      for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

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

test("drag, delete, caret, margins, handles and picture menus", async ({ page, request }) => {
  const upload = await request.post("/api/uploads", {
    multipart: { file: { name: "wide.png", mimeType: "image/png", buffer: widePng() } },
  });
  expect(upload.status()).toBe(201);
  const url = ((await upload.json()) as { url: string }).url;
  const id = await createDocument(
    request,
    "Move a picture",
    `Above the picture.\n\n![Stripe](${url}){width=180px align=left}\n\nUnder the picture starts here and keeps going so a drop can split this sentence in half.\n\nA later paragraph sits further down the page.`,
  );
  await openDocument(page, id);
  const image = page.locator(".doc-content .doc-image img");
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(40);

  await image.click();
  const figure = page.locator(".doc-content .doc-image");
  await expect(figure).toHaveClass(/ProseMirror-selectednode/);
  await expect(figure.locator(".image-handle")).toHaveCount(8);
  await expect(figure.locator(".image-rotate-dot")).toBeVisible();
  const bar = page.locator(".picture-bar");
  await expect(bar.getByRole("button")).toHaveCount(2);
  await expect(bar.getByRole("button", { name: "Wrap text" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Image options" })).toBeVisible();

  await bar.getByRole("button", { name: "Wrap text" }).click();
  const wrapMenu = page.getByRole("menu", { name: "Wrap text" });
  await expect(wrapMenu.getByRole("menuitemcheckbox")).toHaveText(["In line", "Wrap text", "Break text", "Behind text", "In front of text"]);
  await expect(wrapMenu.getByRole("menuitemcheckbox", { name: "Break text" })).toHaveAttribute("aria-checked", "true");
  await wrapMenu.screenshot({ path: "/tmp/picture-wrap.png" });
  await bar.getByRole("button", { name: "Wrap text" }).click();
  await expect(wrapMenu).toBeHidden();

  await bar.getByRole("button", { name: "Image options" }).click();
  const options = page.getByRole("dialog", { name: "Image options" });
  await expect(options.getByText("Size & rotation")).toBeVisible();
  await expect(options.getByRole("textbox", { name: "Width", exact: true })).toBeVisible();
  await expect(options.getByRole("textbox", { name: "Height", exact: true })).toBeVisible();
  await expect(options.getByRole("textbox", { name: "Width scale", exact: true })).toBeVisible();
  await expect(options.getByRole("textbox", { name: "Height scale", exact: true })).toBeVisible();
  await expect(options.getByRole("checkbox", { name: "Lock aspect ratio" })).toBeChecked();
  await expect(options.getByRole("textbox", { name: "Angle", exact: true })).toBeVisible();
  await expect(options.getByRole("button", { name: "Rotate 90 degrees" })).toBeVisible();
  await expect(options.getByRole("button", { name: "Reset size and rotation" })).toBeVisible();
  await options.screenshot({ path: "/tmp/picture-options.png" });
  await options.getByRole("button", { name: "Close" }).click();

  const frame = () =>
    page.evaluate(() => {
      const box = document.querySelector(".image-frame")!.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    });

  const lineCaret = () =>
    page.evaluate(() => {
      const caret = document.querySelector(".picture-line-caret") as HTMLElement | null;
      const box = document.querySelector(".image-frame")!.getBoundingClientRect();
      const rect = caret && !caret.hidden ? caret.getBoundingClientRect() : null;
      return {
        hidden: !rect,
        left: rect?.left ?? 0,
        top: rect?.top ?? 0,
        bottom: rect?.bottom ?? 0,
        frameLeft: box.left,
        frameRight: box.right,
        frameTop: box.top,
        frameBottom: box.bottom,
      };
    });

  const above = page.locator(".doc-content p", { hasText: "Above the picture." });
  const aboveBox = await above.boundingBox();
  expect(aboveBox).toBeTruthy();
  await page.mouse.click(aboveBox!.x + aboveBox!.width - 2, aboveBox!.y + aboveBox!.height / 2);
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await lineCaret()).hidden).toBe(false);
  const down = await lineCaret();
  expect(Math.abs(down.left - down.frameLeft)).toBeLessThan(4);
  expect(down.bottom).toBeGreaterThan(down.frameBottom - 6);
  expect(down.top).toBeGreaterThan(down.frameTop + down.frameBottom - down.frameTop - 40);
  await expect(figure).not.toHaveClass(/ProseMirror-selectednode/);

  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await lineCaret()).hidden).toBe(true);
  const underText = await page.evaluate(() => {
    const sel = document.getSelection();
    return sel?.anchorNode?.textContent ?? "";
  });
  expect(underText).toContain("Under the picture");

  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await lineCaret()).hidden).toBe(false);
  const up = await lineCaret();
  expect(Math.abs(up.left - up.frameLeft)).toBeLessThan(4);
  expect(up.bottom).toBeGreaterThan(up.frameBottom - 6);

  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await lineCaret()).hidden).toBe(true);
  const aboveText = await page.evaluate(() => document.getSelection()?.anchorNode?.textContent ?? "");
  expect(aboveText).toContain("Above the picture");

  const beforeMargin = await frame();
  const pageBox = await page.locator(".page-stack").boundingBox();
  expect(pageBox).toBeTruthy();
  await page.mouse.click(pageBox!.x + 16, (beforeMargin.top + beforeMargin.bottom) / 2);
  await expect(figure).toHaveClass(/ProseMirror-selectednode/);

  await page.mouse.click(beforeMargin.right + 36, (beforeMargin.top + beforeMargin.bottom) / 2);
  await expect.poll(async () => {
    const caret = await lineCaret();
    return !caret.hidden && Math.abs(caret.left - (caret.frameRight - 2)) < 6 && caret.bottom > caret.frameBottom - 6;
  }).toBe(true);

  await image.click();
  const startSize = await page.evaluate(() => {
    const img = document.querySelector(".doc-image img") as HTMLImageElement;
    return { width: img.offsetWidth, height: img.offsetHeight };
  });
  const east = figure.locator(".image-handle-e");
  const eastBox = await east.boundingBox();
  expect(eastBox).toBeTruthy();
  await page.mouse.move(eastBox!.x + eastBox!.width / 2, eastBox!.y + eastBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(eastBox!.x + 70, eastBox!.y + eastBox!.height / 2, { steps: 8 });
  await page.mouse.up();
  const squished = await page.evaluate(() => {
    const img = document.querySelector(".doc-image img") as HTMLImageElement;
    return { width: img.offsetWidth, height: img.offsetHeight };
  });
  expect(squished.width).toBeGreaterThan(startSize.width + 30);
  expect(Math.abs(squished.height - startSize.height)).toBeLessThan(3);

  const corner = figure.locator(".image-handle-se");
  const cornerBox = await corner.boundingBox();
  expect(cornerBox).toBeTruthy();
  const beforeCorner = squished;
  await page.mouse.move(cornerBox!.x + cornerBox!.width / 2, cornerBox!.y + cornerBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(cornerBox!.x + 50, cornerBox!.y + 10, { steps: 8 });
  await page.mouse.up();
  const sized = await page.evaluate(() => {
    const img = document.querySelector(".doc-image img") as HTMLImageElement;
    return { width: img.offsetWidth, height: img.offsetHeight, ratio: img.offsetWidth / img.offsetHeight };
  });
  expect(sized.width).toBeGreaterThan(beforeCorner.width + 20);
  expect(sized.height).toBeGreaterThan(beforeCorner.height + 8);
  expect(Math.abs(sized.ratio - beforeCorner.width / beforeCorner.height)).toBeLessThan(0.08);

  const dot = figure.locator(".image-rotate-dot");
  const dotBox = await dot.boundingBox();
  const turnedFrame = await frame();
  expect(dotBox).toBeTruthy();
  await page.mouse.move(dotBox!.x + dotBox!.width / 2, dotBox!.y + dotBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move((turnedFrame.left + turnedFrame.right) / 2 + 90, (turnedFrame.top + turnedFrame.bottom) / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => figure.getAttribute("data-rotate")).toBe("90");
  await page.screenshot({ path: "/tmp/picture-selected.png" });

  const later = page.locator(".doc-content p", { hasText: "A later paragraph" });
  const laterBox = await later.boundingBox();
  expect(laterBox).toBeTruthy();
  const dragFrom = await image.boundingBox();
  expect(dragFrom).toBeTruthy();
  const fromX = dragFrom!.x + dragFrom!.width / 2;
  const fromY = dragFrom!.y + dragFrom!.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(laterBox!.x + 80, laterBox!.y + laterBox!.height / 2, { steps: 12 });
  const caret = await page.evaluate(() => {
    const el = document.querySelector(".image-drop-caret") as HTMLElement | null;
    if (!el) return null;
    const style = getComputedStyle(el);
    return { hidden: el.hidden, width: style.width, color: style.backgroundColor };
  });
  expect(caret?.hidden).toBe(false);
  expect(caret?.width).toBe("3px");
  expect(caret?.color).toBe("rgb(26, 115, 232)");
  await page.mouse.up();
  await expect.poll(async () =>
    page.evaluate(() => {
      const kids = [...document.querySelector(".doc-content")!.children];
      const imageAt = kids.findIndex((el) => el.classList.contains("doc-image"));
      const laterAt = kids.findIndex((el) => el.textContent?.includes("further down"));
      const underAt = kids.findIndex((el) => el.textContent?.includes("Under the picture"));
      return imageAt > underAt && laterAt >= 0 && (imageAt === laterAt - 1 || kids[imageAt + 1]?.textContent?.includes("further") || kids[imageAt - 1]?.textContent?.includes("later"));
    }),
  ).toBe(true);

  await image.click();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".doc-content .doc-image")).toHaveCount(0);
});
