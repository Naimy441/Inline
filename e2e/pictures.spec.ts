import { deflateSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** A 40×20 PNG, red on the left and blue on the right, so a turn changes the box. */
function widePng() {
  const width = 40;
  const height = 20;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4;
      const red = x < width / 2;
      raw[at] = red ? 220 : 30;
      raw[at + 1] = red ? 40 : 70;
      raw[at + 2] = red ? 40 : 210;
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

test("square wrap, behind, in front, crop and rotate survive a reload", async ({ page, request }) => {
  const upload = await request.post("/api/uploads", {
    multipart: { file: { name: "wide.png", mimeType: "image/png", buffer: widePng() } },
  });
  expect(upload.status()).toBe(201);
  const url = ((await upload.json()) as { url: string }).url;
  const id = await createDocument(
    request,
    "Pictures",
    `![Wide stripe](${url}){width=220px align=left}\n\nWords flow beside the picture and keep going across the line so wrap can put them next to it, under it, or behind it on the page.`,
  );
  await openDocument(page, id);
  const image = page.locator(".doc-content .doc-image img");
  await expect(image).toHaveAttribute("alt", /Wide stripe|alt text stays|stripe/);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(40);

  const layout = () =>
    page.evaluate(() => {
      const figure = document.querySelector(".doc-image") as HTMLElement;
      const frame = figure.querySelector(".image-frame") as HTMLElement;
      const img = figure.querySelector("img") as HTMLImageElement;
      const paragraph = document.querySelector(".doc-content p") as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const line = [...range.getClientRects()].find((rect) => rect.height > 2 && rect.width > 2);
      const box = frame.getBoundingClientRect();
      const turned = figure.querySelector(".image-turn") as HTMLElement;
      const visual = getComputedStyle(turned).transform !== "none" ? turned : img;
      const visualBox = visual.getBoundingClientRect();
      // The center stays on the picture after a turn. A corner of the layout box does not.
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        wrap: figure.dataset.wrap ?? "",
        crop: figure.dataset.crop ?? "",
        rotate: figure.dataset.rotate ?? "",
        alt: img.alt,
        width: img.style.width,
        frame: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
        line: line ? { left: line.left, top: line.top, bottom: line.bottom } : null,
        hit: hit?.tagName ?? "",
        // Layout size, not the turned box: a 90° turn would swap width and height.
        imgWidth: img.offsetWidth,
        frameWidth: frame.offsetWidth,
        imgShift: Number.parseFloat(img.style.marginLeft) || 0,
        visual: { width: visualBox.width, height: visualBox.height, transform: getComputedStyle(visual).transform },
      };
    });

  await image.click();
  const bar = page.locator(".picture-bar");
  const square = bar.getByRole("button", { name: "Square", exact: true });
  await expect(square).toBeVisible();

  await square.click();
  await expect.poll(async () => (await layout()).wrap).toBe("square");
  const beside = await layout();
  expect(beside.line).toBeTruthy();
  expect(beside.line!.left).toBeGreaterThan(beside.frame.right - 8);
  expect(beside.line!.top).toBeLessThan(beside.frame.bottom - 4);
  expect(beside.line!.bottom).toBeGreaterThan(beside.frame.top + 4);

  const upright = beside.visual;
  expect(upright.width).toBeGreaterThan(upright.height);
  await bar.getByLabel("Rotate").fill("90");
  await expect.poll(async () => (await layout()).rotate).toBe("90");
  const turned = await layout();
  expect(turned.visual.height).toBeGreaterThan(turned.visual.width);
  expect(turned.visual.transform).not.toBe("none");

  await bar.getByRole("button", { name: "Behind text" }).click();
  await expect.poll(async () => (await layout()).wrap).toBe("behind");
  await expect.poll(async () => (await layout()).hit).not.toBe("IMG");
  const behind = await layout();
  expect(behind.line!.top).toBeLessThan(behind.frame.bottom - 4);
  expect(behind.line!.left).toBeLessThan(behind.frame.right - 20);

  await bar.getByRole("button", { name: "In front of text" }).click();
  await expect.poll(async () => (await layout()).wrap).toBe("front");
  await expect.poll(async () => (await layout()).hit).toBe("IMG");

  await bar.getByLabel("Crop from left").fill("50");
  await bar.getByLabel("Crop from left").press("Tab");
  await expect.poll(async () => (await layout()).crop).toBe("50,0,0,0");
  const cropped = await layout();
  expect(cropped.imgWidth).toBeGreaterThan(cropped.frameWidth + 20);
  expect(cropped.imgShift).toBeLessThan(-10);

  await bar.getByRole("button", { name: "Square", exact: true }).click();
  await expect.poll(async () => (await layout()).wrap).toBe("square");
  await expect(page.locator(".sync-status")).toHaveText(/Saved/);
  await page.reload();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(40);
  const kept = await layout();
  expect(kept.wrap).toBe("square");
  expect(kept.crop).toBe("50,0,0,0");
  expect(kept.rotate).toBe("90");
  expect(kept.alt).toContain("stripe");
  expect(kept.line!.left).toBeGreaterThan(kept.frame.right - 8);
  expect(kept.imgWidth).toBeGreaterThan(kept.frameWidth + 20);
  expect(kept.imgShift).toBeLessThan(-10);
  expect(kept.visual.transform).not.toBe("none");
});
