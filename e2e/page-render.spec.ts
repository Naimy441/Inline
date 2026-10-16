import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * screenshot_page of a document that is not open in an editor. The server
 * lays the page out in a headless browser with the real editor, then returns
 * a PNG. Page numbers are 1-based.
 */

type Shot = { text: string; isError: boolean; png: Buffer | null };

async function connect(baseURL: string) {
  const client = new Client({ name: "inline-page-render", version: "1.0.0" });
  const { token } = (await (await fetch(new URL("/api/mcp/connect", baseURL))).json()) as { token: string };
  await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", baseURL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function screenshot(baseURL: string, documentId: string, page: number, theme?: "light" | "dark"): Promise<Shot> {
  const client = await connect(baseURL);
  try {
    const result = await client.callTool({ name: "screenshot_page", arguments: { document_id: documentId, page, ...(theme ? { theme } : {}) } });
    const content = (result.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    const image = content.find((item) => item.type === "image" && item.mimeType === "image/png" && item.data);
    return {
      text: content.map((item) => item.text ?? "").join("\n"),
      isError: Boolean(result.isError),
      png: image?.data ? Buffer.from(image.data, "base64") : null,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function createDocument(request: APIRequestContext, markdown: string) {
  const response = await request.post("/api/documents", { data: { title: "Closed pages", markdown } });
  expect(response.status()).toBe(201);
  const { document } = (await response.json()) as { document: { meta: { id: string } } };
  return document.meta.id;
}

/** Where a phrase sits, as a 1-based page, from the sheet behind its line box. */
async function pageOf(page: Page, phrase: string) {
  return page.evaluate((needle) => {
    const sheets = [...document.querySelectorAll<HTMLElement>(".sheet")];
    const root = document.querySelector(".doc-content");
    if (!root) return 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      const at = node.data.indexOf(needle);
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        const rect = range.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        const index = sheets.findIndex((sheet) => {
          const box = sheet.getBoundingClientRect();
          return mid >= box.top - 1 && mid < box.bottom + 1;
        });
        return index + 1;
      }
      node = walker.nextNode() as Text | null;
    }
    return 0;
  }, phrase);
}

/** Dark pixels in the margin band and in the text band, to tell a laid-out page from a blank or a thumbnail. */
async function ink(page: Page, png: Buffer) {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(image, 0, 0);
    const { width, height } = canvas;
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const dark = (x0: number, y0: number, x1: number, y1: number) => {
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * width + x) * 4;
          if (pixels[i]! < 80 && pixels[i + 1]! < 80 && pixels[i + 2]! < 80) count += 1;
        }
      }
      return count;
    };
    // Letter, 1 inch margins, drawn at 1.5 pixels per point: the margin is 108px.
    return {
      width,
      height,
      topMargin: dark(0, 0, width, 70),
      leftMargin: dark(0, 140, 70, 280),
      body: dark(120, 120, width - 120, 320),
    };
  }, png.toString("base64"));
}

test("a closed document's first page and a later page are pictures of the laid-out page", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const id = await createDocument(
    request,
    ["PAGEONE opens the first page of this closed document.", "", "The first page has a second sentence so the picture is not a single word.", "", "\\pagebreak", "", "PAGETWO opens the later page.", "", "The later page has its own paragraph under that line."].join("\n"),
  );

  const first = await screenshot(baseURL!, id, 1, "light");
  const second = await screenshot(baseURL!, id, 2, "light");
  const missing = await screenshot(baseURL!, id, 9, "light");
  expect(first.isError, first.text).toBe(false);
  expect(second.isError, second.text).toBe(false);
  expect(first.text).toMatch(/Page 1 of 2/);
  expect(first.text).toMatch(/no editor open/);
  expect(second.text).toMatch(/Page 2 of 2/);
  expect(first.png).toBeTruthy();
  expect(second.png).toBeTruthy();
  expect(first.png!.equals(second.png!)).toBe(false);

  const top = await ink(page, first.png!);
  const later = await ink(page, second.png!);
  for (const band of [top, later]) {
    expect(band.width).toBeGreaterThan(880);
    expect(band.width).toBeLessThan(980);
    expect(band.height).toBeGreaterThan(1140);
    expect(band.height).toBeLessThan(1260);
    expect(band.topMargin).toBeLessThan(40);
    expect(band.leftMargin).toBeLessThan(40);
    expect(band.body).toBeGreaterThan(80);
  }

  await page.goto(`/render/${id}`);
  await page.waitForFunction(() => document.documentElement.dataset.renderStatus === "ready");
  expect(await pageOf(page, "PAGEONE")).toBe(1);
  expect(await pageOf(page, "PAGETWO")).toBe(2);

  expect(missing.isError).toBe(true);
  expect(missing.text).toMatch(/2 pages/);
  expect(missing.text).toMatch(/Pass a page from 1 to 2/);
  expect(missing.png).toBeNull();
});

/** Average color of the margin, and how much light or dark ink sits in the text. */
async function paper(page: Page, png: Buffer) {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const at = (x: number, y: number) => {
      const i = (y * canvas.width + x) * 4;
      return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
    };
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = 8; y < 48; y += 2) {
      for (let x = 8; x < 48; x += 2) {
        const pixel = at(x, y);
        r += pixel.r;
        g += pixel.g;
        b += pixel.b;
        n += 1;
      }
    }
    let lightInk = 0;
    let darkInk = 0;
    for (let y = 150; y < 320; y += 2) {
      for (let x = 150; x < canvas.width - 150; x += 3) {
        const pixel = at(x, y);
        if (pixel.r > 180 && pixel.g > 180 && pixel.b > 170) lightInk += 1;
        if (pixel.r < 40 && pixel.g < 40 && pixel.b < 40) darkInk += 1;
      }
    }
    return { r: r / n, g: g / n, b: b / n, lightInk, darkInk, width: canvas.width, height: canvas.height };
  }, png.toString("base64"));
}

function expectDarkPage(sample: { r: number; g: number; b: number; lightInk: number; darkInk: number }) {
  expect(sample.r).toBeGreaterThan(20);
  expect(sample.r).toBeLessThan(70);
  expect(sample.g).toBeLessThan(70);
  expect(sample.b).toBeLessThan(70);
  expect(sample.lightInk).toBeGreaterThan(20);
}

function expectLightPage(sample: { r: number; g: number; b: number; lightInk: number; darkInk: number }) {
  expect(sample.r).toBeGreaterThan(240);
  expect(sample.g).toBeGreaterThan(240);
  expect(sample.b).toBeGreaterThan(240);
  expect(sample.darkInk).toBeGreaterThan(20);
}

test("a dark-mode user gets a dark page, including one that is not open, unless light is asked for", async ({ page, request, baseURL }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(async () => ((await (await request.get("/api/preferences")).json()) as { preferences: { appearance?: string } }).preferences.appearance).toBe("dark");

  const closed = await createDocument(request, ["A closed document pictured for a dark-mode user.", "", "The paragraph is long enough that the picture has a line of text to see."].join("\n"));
  const dark = await screenshot(baseURL!, closed, 1);
  const light = await screenshot(baseURL!, closed, 1, "light");
  const again = await screenshot(baseURL!, closed, 1, "dark");
  expect(dark.isError, dark.text).toBe(false);
  expect(dark.text).toMatch(/no editor open/);
  expect(dark.text).toMatch(/dark appearance/);
  expect(light.text).toMatch(/light appearance/);
  expect(light.text).toMatch(/no editor open/);
  expect(again.text).toMatch(/dark appearance/);
  expectDarkPage(await paper(page, dark.png!));
  expectLightPage(await paper(page, light.png!));
  expectDarkPage(await paper(page, again.png!));

  const openId = await createDocument(request, ["An open document pictured in the appearance the user is using.", "", "This line keeps the page from being a single word."].join("\n"));
  const live = page.waitForResponse((res) => res.url().includes(`/api/documents/${openId}/events`) && res.ok());
  await page.goto(`/d/${openId}`);
  await live;
  await expect(page.locator(".doc-content")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const openDark = await screenshot(baseURL!, openId, 1);
  const openLight = await screenshot(baseURL!, openId, 1, "light");
  expect(openDark.isError, openDark.text).toBe(false);
  expect(openDark.text).toMatch(/as the editor lays it out/);
  expect(openDark.text).not.toMatch(/no editor open/);
  expect(openDark.text).toMatch(/appearance the user is using/);
  expect(openLight.text).toMatch(/light appearance/);
  expectDarkPage(await paper(page, openDark.png!));
  expectLightPage(await paper(page, openLight.png!));

  await page.goto("/");
  await page.getByRole("button", { name: "Light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(async () => ((await (await request.get("/api/preferences")).json()) as { preferences: { appearance?: string } }).preferences.appearance).toBe("light");
  const closedLight = await screenshot(baseURL!, closed, 1);
  expect(closedLight.isError, closedLight.text).toBe(false);
  expect(closedLight.text).toMatch(/no editor open/);
  expect(closedLight.text).toMatch(/light appearance/);
  expectLightPage(await paper(page, closedLight.png!));
});
