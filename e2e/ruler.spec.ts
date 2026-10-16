import { expect, test, type Page } from "@playwright/test";

const PARAGRAPH = "The first line of this paragraph is long enough to wrap onto a second line, so a first-line indent and a left indent land in different places.";

async function createDocument(request: import("@playwright/test").APIRequestContext, title: string, markdown: string) {
  const response = await request.post("/api/documents", { data: { title, markdown } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { document: { meta: { id: string } } }).document.meta.id;
}

async function openDocument(page: Page, id: string) {
  await page.goto(`/d/${id}`);
  await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(".sheet").first()).toBeVisible();
  const toggle = page.locator(".claude-toggle");
  if (((await toggle.getAttribute("class")) ?? "").includes("is-active")) await toggle.click();
}

async function chooseZoom(page: Page, label: string) {
  await page.locator(".tb-zoom").click();
  await page.locator(".menu-item", { hasText: label }).click();
  await expect(page.locator(".tb-zoom")).toContainText(label);
}

async function showRulerItem(page: Page) {
  await page.getByRole("button", { name: "View", exact: true }).click();
  return page.getByRole("menuitemcheckbox", { name: "Show ruler" });
}

async function dragMarker(page: Page, name: string, inches: number) {
  const marker = page.getByRole("slider", { name });
  const box = await marker.boundingBox();
  if (!box) throw new Error(`No box for ${name}`);
  const pxPerInch = await page.locator(".doc-ruler-track").evaluate((el) => {
    const inchesWide = Number((el as HTMLElement).dataset.pageInches);
    return el.getBoundingClientRect().width / inchesWide;
  });
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + inches * pxPerInch, y, { steps: 12 });
  await page.mouse.up();
}

test("the ruler stays off until View turns it on, and indents follow the markers", async ({ page, request }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("inline-preferences"));
  await openDocument(page, await createDocument(request, "Ruler", PARAGRAPH));
  await chooseZoom(page, "100%");

  const off = await showRulerItem(page);
  await expect(off).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".doc-ruler-bar")).toHaveCount(0);
  await off.click();

  await expect(page.locator(".doc-ruler-bar")).toBeVisible();
  await expect(page.getByRole("slider", { name: "First-line indent" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Left indent" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Left margin" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Right indent" })).toBeVisible();
  await expect(page.locator(".doc-ruler-ticks text").filter({ hasText: "1" })).toBeVisible();

  const aligned = await page.evaluate(() => {
    const track = document.querySelector(".doc-ruler-track")!.getBoundingClientRect();
    const frame = document.querySelector(".page-stack-frame")!.getBoundingClientRect();
    return { dx: Math.abs(track.left - frame.left), dw: Math.abs(track.width - frame.width), height: document.querySelector(".doc-ruler-bar")!.getBoundingClientRect().height };
  });
  expect(aligned.dx).toBeLessThan(2);
  expect(aligned.dw).toBeLessThan(2);
  expect(aligned.height).toBeLessThan(40);

  await chooseZoom(page, "150%");
  const scaled = await page.evaluate(() => {
    const track = document.querySelector(".doc-ruler-track")!.getBoundingClientRect();
    const frame = document.querySelector(".page-stack-frame")!.getBoundingClientRect();
    const inches = Number((document.querySelector(".doc-ruler-track") as HTMLElement).dataset.pageInches);
    return { dx: Math.abs(track.left - frame.left), dw: Math.abs(track.width - frame.width), pxPerInch: track.width / inches };
  });
  expect(scaled.dx).toBeLessThan(2);
  expect(scaled.dw).toBeLessThan(2);
  expect(scaled.pxPerInch).toBeGreaterThan(140);
  expect(scaled.pxPerInch).toBeLessThan(148);

  await chooseZoom(page, "100%");
  await page.locator(".doc-content").click();
  const placed = await page.evaluate(() => {
    const para = document.querySelector(".doc-content p")!.getBoundingClientRect();
    const content = document.querySelector(".page-content")!.getBoundingClientRect();
    const sheet = document.querySelector(".sheet")!.getBoundingClientRect();
    const ruler = document.querySelector(".doc-ruler-track")!.getBoundingClientRect();
    const marker = document.querySelector(".doc-ruler-marker.is-first")!.getBoundingClientRect();
    return {
      paraTop: Math.round(para.top - sheet.top),
      contentTop: Math.round(content.top - sheet.top),
      paraLeft: Math.round(para.left - content.left),
      marker: Math.round(marker.left + marker.width / 2 - content.left),
      rulerVsSheet: Math.round(ruler.left - sheet.left),
    };
  });
  expect(placed.paraTop).toBe(placed.contentTop);
  expect(placed.paraLeft).toBe(0);
  expect(placed.marker).toBe(0);
  expect(placed.rulerVsSheet).toBe(0);
  await dragMarker(page, "First-line indent", 0.5);
  await expect(page.locator(".doc-content p").first()).toHaveAttribute("style", /text-indent:\s*0\.5in/);

  await dragMarker(page, "Left indent", 0.5);
  const afterLeft = (await page.locator(".doc-content p").first().getAttribute("style")) ?? "";
  expect(afterLeft).toMatch(/margin-left:\s*0\.5in/);
  expect(afterLeft).not.toMatch(/text-indent:\s*0\.5in/);
  const indented = await page.evaluate(() => {
    const para = document.querySelector(".doc-content p")!.getBoundingClientRect();
    const content = document.querySelector(".page-content")!.getBoundingClientRect();
    const first = document.querySelector(".doc-ruler-marker.is-first")!.getBoundingClientRect();
    const left = document.querySelector(".doc-ruler-marker.is-left")!.getBoundingClientRect();
    return {
      paraLeft: Math.round(para.left - content.left),
      first: Math.round(first.left + first.width / 2 - content.left),
      left: Math.round(left.left + left.width / 2 - content.left),
    };
  });
  expect(indented).toEqual({ paraLeft: 48, first: 48, left: 48 });

  expect(await page.evaluate(() => localStorage.getItem("inline-preferences"))).toContain('"showRuler":true');
  await page.reload();
  await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(".doc-ruler-bar")).toBeVisible();
  const still = await showRulerItem(page);
  await expect(still).toHaveAttribute("aria-checked", "true");
  await still.click();
  await expect(page.locator(".doc-ruler-bar")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(".doc-ruler-bar")).toHaveCount(0);
  const hidden = await showRulerItem(page);
  await expect(hidden).toHaveAttribute("aria-checked", "false");
});
