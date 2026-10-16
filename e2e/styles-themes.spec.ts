import { expect, test, type Locator, type Page } from "@playwright/test";

async function newBlankDocument(page: Page) {
  await page.goto("/");
  await page.locator(".template-card").first().click();
  await page.waitForURL(/\/d\//);
  await expect(page.locator(".doc-content")).toBeVisible();
}

/** Type into a dialog field and wait until React is showing that value, so Save cannot store the previous one. */
async function replaceField(field: Locator, value: string) {
  await field.fill(value);
  await expect(field).toHaveValue(value);
}

test("a shared style updates every use, and a theme follows a reload", async ({ page }) => {
  await newBlankDocument(page);
  const doc = page.locator(".doc-content");
  await doc.click();
  await page.keyboard.type("Alpha");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Beta");
  await expect(doc.locator("p")).toHaveCount(2);

  await page.getByRole("button", { name: "Paragraph style" }).click();
  await page.getByRole("menuitem", { name: "New style…" }).click();
  const dialog = page.getByRole("dialog", { name: "New style" });
  await replaceField(dialog.getByLabel("Name"), "Callout");
  await replaceField(dialog.getByLabel("Size"), "18");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  const apply = async (paragraph: number) => {
    await doc.locator("p").nth(paragraph).click();
    await page.getByRole("button", { name: "Paragraph style" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Callout", exact: true }).click();
  };
  await apply(0);
  await apply(1);
  await expect(doc.locator('[data-style="Callout"]')).toHaveCount(2);

  await page.getByRole("button", { name: "Paragraph style" }).click();
  await page.getByRole("menuitem", { name: "Modify style…" }).click();
  const modify = page.getByRole("dialog", { name: "Modify style" });
  const sizeField = modify.getByLabel("Size");
  await expect(sizeField).toHaveValue("18");
  await replaceField(sizeField, "22");
  await modify.getByRole("button", { name: "Save" }).click();
  await expect(modify).toBeHidden();

  const calloutSize = () =>
    page.locator(".page-stack style").innerText().then((css) => css.match(/\[data-style="Callout"\][^{]*\{[^}]*font-size:\s*[\d.]+pt/)?.[0] ?? "no Callout size");
  await expect.poll(calloutSize).toContain("font-size: 22pt");
  await expect(doc.locator('[data-style="Callout"]')).toHaveCount(2);

  // Direct size on one word stays put when the shared style changes again.
  await doc.locator("p").first().click();
  await page.keyboard.press("Home");
  for (let i = 0; i < "Alpha".length; i += 1) await page.keyboard.press("Shift+ArrowRight");
  const size = page.getByRole("textbox", { name: "Font size" });
  await replaceField(size, "16");
  await size.press("Enter");
  await expect(doc.locator("p").first()).toHaveText("Alpha");
  await page.getByRole("button", { name: "Paragraph style" }).click();
  await page.getByRole("menuitem", { name: "Modify style…" }).click();
  await expect(sizeField).toHaveValue("22");
  await replaceField(sizeField, "24");
  await modify.getByRole("button", { name: "Save" }).click();
  await expect.poll(calloutSize).toContain("font-size: 24pt");
  await expect(doc.locator('[data-style="Callout"]').first().locator("span").first()).toHaveAttribute("style", /font-size:\s*16pt/);

  await page.getByRole("button", { name: "Format", exact: true }).click();
  await page.getByRole("menuitem", { name: "Theme" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Classic", exact: true }).click();
  await expect.poll(() => page.locator(".page-stack").evaluate((el) => getComputedStyle(el).getPropertyValue("--theme-heading-font"))).toContain("Georgia");
  await expect.poll(() => page.locator(".page-stack").evaluate((el) => getComputedStyle(el).getPropertyValue("--theme-body-font"))).toContain("Times New Roman");
  await expect.poll(() => page.locator(".page-content").evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Times New Roman");

  await expect(page.locator(".sync-status")).toHaveText(/Saved/);
  await page.reload();
  await expect(doc.locator('[data-style="Callout"]')).toHaveCount(2);
  await expect.poll(calloutSize).toContain("font-size: 24pt");
  await expect.poll(() => page.locator(".page-stack").evaluate((el) => getComputedStyle(el).getPropertyValue("--theme-heading-font"))).toContain("Georgia");
  await expect(doc.locator('[data-style="Callout"]').first().locator("span").first()).toHaveAttribute("style", /font-size:\s*16pt/);
});
