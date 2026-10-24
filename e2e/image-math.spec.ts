import { deflateSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/** A small opaque PNG. Width in the document comes from the markdown, not the file. */
function png(width = 40, height = 24) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4;
      raw[at] = 40;
      raw[at + 1] = 90;
      raw[at + 2] = 180;
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

async function upload(request: APIRequestContext) {
  const response = await request.post("/api/uploads", {
    multipart: { file: { name: "graph.png", mimeType: "image/png", buffer: png() } },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { url: string }).url;
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

async function waitForImage(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
}

function caretState(page: Page) {
  return page.evaluate(() => {
    const editor = document.querySelector(".doc-content") as HTMLElement;
    const selected = document.querySelector(".doc-image.ProseMirror-selectednode");
    return {
      gap: Boolean(editor.querySelector(".ProseMirror-gapcursor")),
      hidden: editor.classList.contains("ProseMirror-hideselection"),
      selected: Boolean(selected),
    };
  });
}

test("a click under a trailing image is a text caret, and a wide image stays on the page", async ({ page, request }) => {
  const url = await upload(request);
  const id = await createDocument(request, "Wide graph", `The curve is above.\n\n![Graph](${url}){width=2000px align=center}`);
  await openDocument(page, id);
  const image = page.locator(".doc-content .doc-image img");
  await waitForImage(image);

  const fit = await page.evaluate(() => {
    const content = document.querySelector(".page-content")!.getBoundingClientRect();
    const img = document.querySelector(".doc-content .doc-image img")!.getBoundingClientRect();
    return {
      contentRight: content.right,
      contentLeft: content.left,
      contentWidth: content.width,
      imgRight: img.right,
      imgLeft: img.left,
      imgWidth: img.width,
      centerDelta: Math.abs(img.left + img.width / 2 - (content.left + content.width / 2)),
    };
  });
  expect(fit.imgRight).toBeLessThanOrEqual(fit.contentRight + 1);
  expect(fit.imgLeft).toBeGreaterThanOrEqual(fit.contentLeft - 1);
  expect(fit.imgWidth).toBeGreaterThan(fit.contentWidth * 0.9);
  expect(fit.imgWidth).toBeLessThanOrEqual(fit.contentWidth + 1);
  expect(fit.centerDelta).toBeLessThan(12);

  const box = await image.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height + 28);
  await expect.poll(caretState.bind(null, page)).toMatchObject({ gap: false, hidden: false, selected: false });
  await page.keyboard.type("under the graph");

  await expect.poll(async () =>
    page.evaluate(() => {
      const image = document.querySelector(".doc-content .doc-image");
      const next = image?.nextElementSibling;
      return { tag: next?.tagName ?? "", text: next?.textContent ?? "" };
    }),
  ).toEqual({ tag: "P", text: "under the graph" });
  expect(await caretState(page)).toMatchObject({ gap: false, hidden: false });
});

test("the empty line under an image is that paragraph", async ({ page, request }) => {
  const url = await upload(request);
  const id = await createDocument(request, "Empty line", `![Graph](${url}){width=220px align=center}\n\n&nbsp;`);
  await openDocument(page, id);
  const image = page.locator(".doc-content .doc-image img");
  await waitForImage(image);
  const paragraph = page.locator(".doc-content > p");
  await expect(paragraph).toHaveCount(1);
  const box = await paragraph.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x + 8, box!.y + box!.height / 2);
  await expect.poll(caretState.bind(null, page)).toMatchObject({ gap: false, hidden: false, selected: false });
  await page.keyboard.type("still this line");
  await expect(paragraph).toHaveCount(1);
  await expect(paragraph).toContainText("still this line");
  expect(await caretState(page)).toMatchObject({ gap: false, selected: false });
});

test("a percent width fits the column and the picture bar is one quiet row", async ({ page, request }) => {
  const url = await upload(request);
  const id = await createDocument(request, "Percent", `![Plot](${url}){width=70% align=center}`);
  await openDocument(page, id);
  const image = page.locator(".doc-content .doc-image img");
  await waitForImage(image);

  const ratio = await page.evaluate(() => {
    const content = document.querySelector(".page-content")!.getBoundingClientRect();
    const img = document.querySelector(".doc-content .doc-image img")!.getBoundingClientRect();
    return { ratio: img.width / content.width, centerDelta: Math.abs(img.left + img.width / 2 - (content.left + content.width / 2)) };
  });
  expect(ratio.ratio).toBeGreaterThan(0.65);
  expect(ratio.ratio).toBeLessThan(0.75);
  expect(ratio.centerDelta).toBeLessThan(12);

  await image.click();
  const bar = page.locator(".picture-bar");
  await expect(bar).toBeVisible();
  const shape = await bar.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    labels: [...element.querySelectorAll("button")].map((button) => (button.textContent ?? "").trim()),
  }));
  expect(shape.height).toBeLessThan(48);
  expect(shape.labels).toEqual(["Wrap text options", "Image options"]);
  await expect(bar.getByRole("button")).toHaveCount(2);
  await expect(bar.getByRole("button", { name: "Wrap text options", exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Image options", exact: true })).toBeVisible();
});

test("text beside and across a wrapped image stays editable", async ({ page, request }) => {
  const url = await upload(request);
  const id = await createDocument(
    request,
    "Wrap",
    `![Beside](${url}){width=160px align=left wrap=square}\n\nWords sit beside the picture and continue across the line so a click here edits them.\n\n![Front](${url}){width=140px align=right wrap=front}\n\nA sentence on the left of the front picture stays editable.\n\n![Behind](${url}){width=180px align=left wrap=behind}\n\nThis sentence runs across the picture and must stay editable when the picture sits behind it.`,
  );
  await openDocument(page, id);
  const images = page.locator(".doc-content .doc-image img");
  await expect(images).toHaveCount(3);
  await waitForImage(images.nth(2));

  const beside = page.locator(".doc-content > p").nth(0);
  const besideBox = await beside.boundingBox();
  const squareBox = await images.nth(0).boundingBox();
  expect(besideBox && squareBox).toBeTruthy();
  await page.mouse.click(squareBox!.x + squareBox!.width + 24, besideBox!.y + 8);
  await expect.poll(caretState.bind(null, page)).toMatchObject({ gap: false, hidden: false, selected: false });
  await page.keyboard.type("EDIT ");
  await expect(beside).toContainText("EDIT");

  const front = page.locator(".doc-content > p").nth(1);
  const frontBox = await front.boundingBox();
  const frontImage = await images.nth(1).boundingBox();
  expect(frontBox && frontImage).toBeTruthy();
  await page.mouse.click(frontBox!.x + 12, frontBox!.y + 8);
  expect(frontBox!.x + 12).toBeLessThan(frontImage!.x);
  await expect.poll(caretState.bind(null, page)).toMatchObject({ selected: false, gap: false });
  await page.keyboard.type("LEFT ");
  await expect(front).toContainText("LEFT");

  const behindImage = images.nth(2);
  const covered = await behindImage.boundingBox();
  expect(covered).toBeTruthy();
  const hit = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return { tag: target?.tagName ?? "", image: Boolean(target?.closest("img")) };
  }, { x: covered!.x + covered!.width / 2, y: covered!.y + covered!.height / 2 });
  expect(hit.image).toBe(false);
  await page.mouse.click(covered!.x + covered!.width / 2, covered!.y + covered!.height / 2);
  await expect.poll(caretState.bind(null, page)).toMatchObject({ selected: false, gap: false });
  await page.keyboard.type("UNDER ");
  await expect(page.locator(".doc-content > p").nth(2)).toContainText("UNDER");

  await images.nth(0).click();
  await expect(page.locator(".picture-bar")).toBeVisible();
  await expect(page.locator(".doc-image.ProseMirror-selectednode")).toHaveCount(1);
});

test("a displayed equation renders as math", async ({ page, request }) => {
  const id = await createDocument(
    request,
    "Equation",
    "See the curve.\n\n$$\ny = x^2 - 2x - 3\n$$\n\n$$y = x^2 - 2x - 3$$",
  );
  await openDocument(page, id);
  const displays = page.locator(".math-display .katex");
  await expect(displays).toHaveCount(2);
  await expect(page.locator(".katex-error")).toHaveCount(0);
  await expect(displays.first()).toBeVisible();
  await expect(displays.first()).toContainText("y");
});
