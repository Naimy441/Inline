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
  await page.locator(".menu-item", { hasText: label }).click();
  await expect(page.locator(".tb-zoom")).toContainText(label);
}

/** Ctrl+wheel on the canvas. The point is the left side of the view, which zoom must not chase. */
async function ctrlWheel(page: Page, deltaY: number) {
  await page.locator(".canvas").evaluate((canvas, deltaY) => {
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY,
        deltaMode: 0,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        clientX: box.left + Math.min(48, box.width / 4),
        clientY: box.top + box.height / 2,
      }),
    );
  }, deltaY);
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

test("trackpad pinch and a two-finger touch zoom around the middle of the view", async ({ page, request }) => {
  await openDocument(page, await createDocument(request, "Pinch memo", MEMO));
  await chooseZoom(page, "100%");
  const sheet = page.locator(".sheet").first();
  const spot = await sheet.boundingBox();
  expect(spot).toBeTruthy();
  // Off to the side on purpose: zoom must not chase this point.
  const point = { x: spot!.x + spot!.width * 0.2, y: spot!.y + 160 };
  const before = await sheet.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width };
  });

  await page.mouse.move(point.x, point.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");
  await expect(page.locator(".tb-zoom")).toContainText("200%");

  const afterWheel = await page.evaluate(({ x }) => {
    const sheet = document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect();
    const frame = document.querySelector<HTMLElement>(".page-stack-frame")!.getBoundingClientRect();
    const canvas = document.querySelector<HTMLElement>(".canvas")!;
    const view = canvas.getBoundingClientRect();
    return {
      width: sheet.width,
      aligned: Math.abs(sheet.left - frame.left) < 2 && Math.abs(sheet.width - frame.width) < 2,
      fx: (x - sheet.left) / sheet.width,
      centerGap: Math.abs(sheet.left + sheet.width / 2 - (view.left + view.width / 2)),
      overflowX: canvas.scrollWidth - canvas.clientWidth,
    };
  }, point);
  expect(afterWheel.width).toBeGreaterThan(before.width + 20);
  expect(afterWheel.aligned).toBe(true);
  expect(afterWheel.overflowX).toBeGreaterThan(0);
  // The page started centered, so the middle of the view is the middle of the page.
  expect(afterWheel.centerGap).toBeLessThan(24);
  const beforeFx = (point.x - before.left) / before.width;
  expect(Math.abs(afterWheel.fx - beforeFx)).toBeGreaterThan(0.04);

  await chooseZoom(page, "100%");
  const touch = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".canvas");
    const sheet = document.querySelector<HTMLElement>(".sheet");
    if (!canvas || !sheet || typeof Touch !== "function") return { supported: false as const };
    const box = sheet.getBoundingClientRect();
    const midX = box.left + box.width / 2;
    const midY = box.top + 180;
    const finger = (id: number, x: number, y: number) =>
      new Touch({ identifier: id, target: canvas, clientX: x, clientY: y, pageX: x, pageY: y, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
    const fire = (type: string, points: Touch[]) => {
      canvas.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: points, targetTouches: points, changedTouches: points }));
    };
    const beforeWidth = box.width;
    const beforeTransform = document.querySelector<HTMLElement>(".page-stack")!.style.transform;
    fire("touchstart", [finger(1, midX - 50, midY), finger(2, midX + 50, midY)]);
    fire("touchmove", [finger(1, midX - 60, midY), finger(2, midX + 60, midY)]);
    // The scale has to change while the fingers are still down, not on touchend.
    const during = document.querySelector<HTMLElement>(".page-stack")!.style.transform;
    fire("touchend", []);
    return { supported: true as const, beforeWidth, beforeTransform, during };
  });
  expect(touch.supported).toBe(true);
  if (touch.supported) {
    expect(touch.during).not.toBe(touch.beforeTransform);
    expect(touch.during).toContain("scale(");
    await expect(page.locator(".tb-zoom")).toContainText("200%");
    const after = await sheet.evaluate((element) => element.getBoundingClientRect().width);
    expect(after).toBeGreaterThan(touch.beforeWidth + 20);
  }
});

test("zooming again from the left edge does not jump back to center", async ({ page, request }) => {
  await openDocument(page, await createDocument(request, "Pan memo", MEMO));
  await chooseZoom(page, "150%");

  const canvas = page.locator(".canvas");
  // Stay under 200% so the next zoom still has room to grow. Small steps if 150% still fits.
  for (let step = 0; step < 8; step += 1) {
    const state = await canvas.evaluate((node) => ({
      overflow: node.scrollWidth - node.clientWidth,
      label: document.querySelector(".tb-zoom")?.textContent ?? "",
    }));
    if (state.overflow > 80 && !state.label.includes("200%")) break;
    await ctrlWheel(page, -15);
    await page.waitForTimeout(120);
  }
  if ((await page.locator(".tb-zoom").innerText()).includes("200%")) {
    await ctrlWheel(page, 40);
    await page.waitForTimeout(200);
  }
  await expect.poll(() => canvas.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeGreaterThan(80);
  await expect(page.locator(".tb-zoom")).not.toContainText("200%");

  await canvas.evaluate((node) => {
    node.scrollLeft = 0;
  });
  const atEdge = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".canvas")!;
    const sheet = document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect();
    const view = canvas.getBoundingClientRect();
    return {
      centerGap: Math.abs(sheet.left + sheet.width / 2 - (view.left + view.width / 2)),
      sheetLeft: sheet.left - view.left,
      overflow: canvas.scrollWidth - canvas.clientWidth,
    };
  });
  expect(atEdge.overflow).toBeGreaterThan(80);
  expect(atEdge.sheetLeft).toBeGreaterThan(-1);
  expect(atEdge.sheetLeft).toBeLessThan(80);
  expect(atEdge.centerGap).toBeGreaterThan(80);

  // Ctrl+scroll, with the pointer on the left. Zoom must ignore it and must not recenter.
  await ctrlWheel(page, -120);
  await expect(page.locator(".tb-zoom")).toContainText("200%");

  const again = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".canvas")!;
    const sheet = document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect();
    const view = canvas.getBoundingClientRect();
    canvas.scrollLeft = 0;
    const start = document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect().left - canvas.getBoundingClientRect().left;
    canvas.scrollLeft = canvas.scrollWidth;
    const endView = canvas.getBoundingClientRect();
    const endSheet = document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect();
    return {
      centerGap: Math.abs(sheet.left + sheet.width / 2 - (view.left + view.width / 2)),
      sheetLeft: sheet.left - view.left,
      start,
      endRight: endView.right - endSheet.right,
    };
  });
  expect(again.centerGap).toBeGreaterThan(80);
  expect(again.sheetLeft).toBeLessThan(atEdge.sheetLeft + 80);
  expect(again.start).toBeGreaterThan(-1);
  expect(again.start).toBeLessThan(120);
  expect(again.endRight).toBeGreaterThan(-1);
  expect(again.endRight).toBeLessThan(80);

  // The toolbar uses the same anchor. A wider page stays where it was; a page that fits centers.
  await chooseZoom(page, "150%");
  const toolbar = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".canvas")!;
    const sheet = document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect();
    const view = canvas.getBoundingClientRect();
    return {
      overflow: canvas.scrollWidth - canvas.clientWidth,
      centerGap: Math.abs(sheet.left + sheet.width / 2 - (view.left + view.width / 2)),
    };
  });
  if (toolbar.overflow > 80) expect(toolbar.centerGap).toBeGreaterThan(80);
  else expect(toolbar.centerGap).toBeLessThan(24);

  await ctrlWheel(page, 400);
  await expect(page.locator(".tb-zoom")).toHaveText(/^50%/);

  const fitted = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".canvas")!;
    const sheet = document.querySelector<HTMLElement>(".sheet")!.getBoundingClientRect();
    const view = canvas.getBoundingClientRect();
    return {
      overflow: canvas.scrollWidth - canvas.clientWidth,
      centerGap: Math.abs(sheet.left + sheet.width / 2 - (view.left + view.width / 2)),
      left: sheet.left - view.left,
      right: view.right - sheet.right,
    };
  });
  expect(fitted.overflow).toBeLessThanOrEqual(1);
  expect(fitted.left).toBeGreaterThan(-1);
  expect(fitted.right).toBeGreaterThan(-1);
  expect(fitted.centerGap).toBeLessThan(24);
});
