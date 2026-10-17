import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const MEMO = "# Quarterly memo\n\nThe meeting is on Tuesday. This memo summarizes what we shipped and what slipped.\n\n- First point\n- Second point\n\nThe rest of the page is here so there is somewhere to scroll.";

async function createDocument(request: APIRequestContext, title: string, markdown: string) {
  const response = await request.post("/api/documents", { data: { title, markdown } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { document: { meta: { id: string } } }).document.meta.id;
}

async function openDocument(page: Page, id: string) {
  await page.goto(`/d/${id}`);
  await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(".sheet").first()).toBeVisible();
}

async function chooseZoom(page: Page, label: string) {
  await page.locator(".tb-zoom").click();
  await page.getByRole("menuitemcheckbox", { name: label, exact: true }).click();
  await expect(page.locator(".tb-zoom")).toHaveText(new RegExp(`^${label}`));
}

/** Ctrl+wheel on the canvas. Zoom tracks `point` when one is given. */
async function ctrlWheel(page: Page, deltaY: number, point?: { x: number; y: number }) {
  await page.locator(".canvas").evaluate(
    (canvas, arg) => {
      const box = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: arg.deltaY,
          deltaMode: 0,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
          clientX: arg.x ?? box.left + box.width / 2,
          clientY: arg.y ?? box.top + box.height / 2,
        }),
      );
    },
    { deltaY, x: point?.x, y: point?.y },
  );
}

async function chooseFit(page: Page) {
  await page.locator(".tb-zoom").click();
  await page.locator(".menu-item", { hasText: /^Fit$/ }).click();
  await expect(page.locator(".menu")).toHaveCount(0);
}

test("manual zoom stays centered and the zoomed page scrolls on both axes", async ({ page, request }) => {
  await openDocument(page, await createDocument(request, "Zoom memo", MEMO));
  const toggle = page.locator(".claude-toggle");
  if (((await toggle.getAttribute("class")) ?? "").includes("is-active")) await toggle.click();

  await chooseZoom(page, "100%");
  const fitted = await page.locator(".canvas").evaluate((canvas) => ({
    overflowX: canvas.scrollWidth - canvas.clientWidth,
    overflowY: canvas.scrollHeight - canvas.clientHeight,
  }));
  expect(fitted.overflowX).toBeLessThanOrEqual(1);
  expect(fitted.overflowY).toBeGreaterThan(40);

  // A plain wheel must keep scrolling (it is not cancelled) and must not zoom.
  const wheel = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".canvas")!;
    let prevented = true;
    const onWheel = (event: WheelEvent) => {
      prevented = event.defaultPrevented;
    };
    canvas.addEventListener("wheel", onWheel);
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 240, bubbles: true, cancelable: true }));
    canvas.removeEventListener("wheel", onWheel);
    return { prevented, label: document.querySelector(".tb-zoom")!.textContent ?? "" };
  });
  expect(wheel.prevented).toBe(false);
  expect(wheel.label).toContain("100%");

  const scrolled = await page.locator(".canvas").evaluate((canvas) => {
    const before = document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect().top;
    canvas.scrollTop = 180;
    const after = document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect().top;
    return { scrollTop: canvas.scrollTop, moved: before - after };
  });
  expect(scrolled.scrollTop).toBeGreaterThan(40);
  expect(scrolled.moved).toBeGreaterThan(40);
  await page.locator(".canvas").evaluate((canvas) => {
    canvas.scrollTop = 0;
    canvas.scrollLeft = 0;
  });

  await chooseZoom(page, "200%");
  const zoomed = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".canvas")!;
    const frame = document.querySelector<HTMLElement>(".page-stack-frame")!;
    const sheet = document.querySelector<HTMLElement>(".sheet")!;
    const canvasBox = canvas.getBoundingClientRect();
    const frameBox = frame.getBoundingClientRect();
    const sheetBox = sheet.getBoundingClientRect();
    return {
      shift: Math.abs(sheetBox.left - frameBox.left),
      widthGap: Math.abs(sheetBox.width - frameBox.width),
      centerGap: Math.abs(sheetBox.left + sheetBox.width / 2 - (canvasBox.left + canvasBox.width / 2)),
      topGap: Math.abs(sheetBox.top - frameBox.top),
      overflowX: canvas.scrollWidth - canvas.clientWidth,
      overflowY: canvas.scrollHeight - canvas.clientHeight,
    };
  });
  expect(zoomed.shift).toBeLessThan(2);
  expect(zoomed.widthGap).toBeLessThan(2);
  expect(zoomed.topGap).toBeLessThan(2);
  expect(zoomed.centerGap).toBeLessThan(24);
  expect(zoomed.overflowX).toBeGreaterThan(40);
  expect(zoomed.overflowY).toBeGreaterThan(40);

  const reach = await page.locator(".canvas").evaluate((canvas) => {
    const sheetOf = () => document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect();
    const view = () => canvas.getBoundingClientRect();
    canvas.scrollLeft = 0;
    canvas.scrollTop = 0;
    const start = { left: sheetOf().left - view().left, top: sheetOf().top - view().top };
    canvas.scrollLeft = canvas.scrollWidth;
    canvas.scrollTop = canvas.scrollHeight;
    const endSheet = sheetOf();
    const endView = view();
    return {
      start,
      endRight: endView.right - endSheet.right,
      endBottom: endView.bottom - endSheet.bottom,
    };
  });
  expect(reach.start.left).toBeGreaterThan(-1);
  expect(reach.start.left).toBeLessThan(80);
  expect(reach.start.top).toBeGreaterThan(-1);
  expect(reach.endRight).toBeGreaterThan(-1);
  expect(reach.endRight).toBeLessThan(80);
  expect(reach.endBottom).toBeGreaterThan(-1);
  expect(reach.endBottom).toBeLessThan(160);
});

async function fractionAt(page: Page, point: { x: number; y: number }) {
  return page.evaluate(({ x, y }) => {
    const sheet = document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect();
    const view = document.querySelector<HTMLElement>(".canvas")!.getBoundingClientRect();
    return {
      fx: (x - sheet.left) / sheet.width,
      fy: (y - sheet.top) / sheet.height,
      centerGap: Math.abs(sheet.left + sheet.width / 2 - (view.left + view.width / 2)),
      width: sheet.width,
    };
  }, point);
}

test("ctrl+scroll zooms toward the pointer and stops at the 100% lock", async ({ page, request }) => {
  await openDocument(page, await createDocument(request, "Pinch memo", MEMO));
  await chooseZoom(page, "100%");
  const sheet = page.locator(".sheet").first();
  const spot = await sheet.boundingBox();
  expect(spot).toBeTruthy();
  const point = { x: spot!.x + spot!.width * 0.2, y: spot!.y + 140 };
  const before = await fractionAt(page, point);

  await ctrlWheel(page, -160, point);
  await expect(page.locator(".tb-zoom")).not.toHaveText(/^100%/);
  const zoomed = await fractionAt(page, point);
  expect(zoomed.width).toBeGreaterThan(before.width + 40);
  expect(Math.abs(zoomed.fx - before.fx)).toBeLessThan(0.02);
  expect(Math.abs(zoomed.fy - before.fy)).toBeLessThan(0.02);
  expect(zoomed.centerGap).toBeGreaterThan(40);

  const reach = await page.locator(".canvas").evaluate((canvas) => {
    const sheetOf = () => document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect();
    const view = () => canvas.getBoundingClientRect();
    canvas.scrollLeft = 0;
    canvas.scrollTop = 0;
    const start = { left: sheetOf().left - view().left, top: sheetOf().top - view().top };
    canvas.scrollLeft = canvas.scrollWidth;
    canvas.scrollTop = canvas.scrollHeight;
    const endSheet = sheetOf();
    const endView = view();
    return {
      start,
      endRight: endView.right - endSheet.right,
      endBottom: endView.bottom - endSheet.bottom,
    };
  });
  expect(reach.start.left).toBeGreaterThan(8);
  expect(reach.start.top).toBeGreaterThan(8);
  expect(reach.endRight).toBeGreaterThan(8);
  expect(reach.endBottom).toBeGreaterThan(8);

  await ctrlWheel(page, 800, point);
  await expect(page.locator(".tb-zoom")).toHaveText(/^100%/);
  const back = await fractionAt(page, point);
  expect(back.centerGap).toBeLessThan(24);
});

test("a 50% toolbar lock stops zoom-out there and centers", async ({ page, request }) => {
  await openDocument(page, await createDocument(request, "Lock memo", MEMO));
  await chooseZoom(page, "50%");
  const sheet = page.locator(".sheet").first();
  const spot = await sheet.boundingBox();
  expect(spot).toBeTruthy();
  const point = { x: spot!.x + spot!.width * 0.25, y: spot!.y + 100 };
  const before = await fractionAt(page, point);
  expect(before.centerGap).toBeLessThan(24);

  await ctrlWheel(page, -160, point);
  await expect(page.locator(".tb-zoom")).not.toHaveText(/^50%/);
  const zoomed = await fractionAt(page, point);
  expect(zoomed.width).toBeGreaterThan(before.width + 20);
  expect(Math.abs(zoomed.fx - before.fx)).toBeLessThan(0.02);
  expect(zoomed.centerGap).toBeGreaterThan(24);

  await ctrlWheel(page, 800, point);
  await expect(page.locator(".tb-zoom")).toHaveText(/^50%/);
  const back = await fractionAt(page, point);
  expect(back.centerGap).toBeLessThan(24);
});

test("a two-finger touch zooms in toward the fingers while they move", async ({ page, request }) => {
  await openDocument(page, await createDocument(request, "Touch memo", MEMO));
  await chooseZoom(page, "100%");
  const sheet = page.locator(".sheet").first();
  const touch = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".canvas");
    const sheet = document.querySelector<HTMLElement>(".sheet");
    if (!canvas || !sheet || typeof Touch !== "function") return { supported: false as const };
    const box = sheet.getBoundingClientRect();
    const midX = box.left + box.width * 0.3;
    const midY = box.top + 180;
    const finger = (id: number, x: number, y: number) =>
      new Touch({ identifier: id, target: canvas, clientX: x, clientY: y, pageX: x, pageY: y, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
    const fire = (type: string, points: Touch[]) => {
      canvas.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: points, targetTouches: points, changedTouches: points }));
    };
    const beforeWidth = box.width;
    const beforeTransform = document.querySelector<HTMLElement>(".page-stack")!.style.transform;
    fire("touchstart", [finger(1, midX - 40, midY), finger(2, midX + 40, midY)]);
    fire("touchmove", [finger(1, midX - 70, midY), finger(2, midX + 70, midY)]);
    const during = document.querySelector<HTMLElement>(".page-stack")!.style.transform;
    fire("touchend", []);
    return { supported: true as const, beforeWidth, beforeTransform, during };
  });
  expect(touch.supported).toBe(true);
  if (touch.supported) {
    expect(touch.during).not.toBe(touch.beforeTransform);
    expect(touch.during).toContain("scale(");
    await expect(page.locator(".tb-zoom")).not.toHaveText(/^100%/);
    const after = await sheet.evaluate((element) => element.getBoundingClientRect().width);
    expect(after).toBeGreaterThan(touch.beforeWidth + 20);
  }
});

test("Fit leaves half an inch on each side and refits when a panel opens", async ({ page, request }) => {
  await openDocument(page, await createDocument(request, "Fit memo", MEMO));
  const toggle = page.locator(".claude-toggle").first();
  if (!((await toggle.getAttribute("class")) ?? "").includes("is-active")) await toggle.click();
  await expect(page.locator(".agent-panel")).toBeVisible();
  await chooseFit(page);

  const gaps = () =>
    page.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>(".canvas")!;
      const sheet = document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect();
      const view = canvas.getBoundingClientRect();
      return {
        left: sheet.left - view.left,
        right: view.right - sheet.right,
        width: sheet.width,
        overflow: canvas.scrollWidth - canvas.clientWidth,
      };
    });

  const open = await gaps();
  expect(Math.abs(open.left - 48)).toBeLessThan(12);
  expect(Math.abs(open.right - 48)).toBeLessThan(12);
  expect(open.overflow).toBeLessThanOrEqual(2);

  await toggle.click();
  await expect(page.locator(".agent-panel")).toBeHidden();
  const closed = await gaps();
  expect(closed.width).toBeGreaterThan(open.width + 30);
  expect(Math.abs(closed.left - 48)).toBeLessThan(12);
  expect(Math.abs(closed.right - 48)).toBeLessThan(12);
  expect(closed.overflow).toBeLessThanOrEqual(2);

  await toggle.click();
  await expect(page.locator(".agent-panel")).toBeVisible();
  const refit = await gaps();
  expect(Math.abs(refit.width - open.width)).toBeLessThan(8);
  expect(Math.abs(refit.left - 48)).toBeLessThan(12);

  const edge = () =>
    page.locator(".sheet").first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.borderTopWidth, style: style.borderTopStyle, outline: style.outlineStyle };
    });
  await page.locator("html").evaluate((html) => {
    html.dataset.theme = "light";
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await edge()).toEqual({ width: "0px", style: "none", outline: "none" });
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await edge()).toEqual({ width: "0px", style: "none", outline: "none" });
});
