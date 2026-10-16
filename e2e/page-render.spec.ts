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

async function screenshot(baseURL: string, documentId: string, page: number): Promise<Shot> {
  const client = await connect(baseURL);
  try {
    const result = await client.callTool({ name: "screenshot_page", arguments: { document_id: documentId, page } });
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

  const first = await screenshot(baseURL!, id, 1);
  const second = await screenshot(baseURL!, id, 2);
  const missing = await screenshot(baseURL!, id, 9);
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
