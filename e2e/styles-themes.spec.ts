import { expect, test, type Page } from "@playwright/test";

async function newBlankDocument(page: Page) {
  await page.goto("/");
  await page.locator(".template-card").first().click();
  await page.waitForURL(/\/d\//);
  await expect(page.locator(".doc-content")).toBeVisible();
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
  await dialog.getByLabel("Name").fill("Callout");
  await dialog.getByLabel("Size").fill("18");
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
  await modify.getByLabel("Size").fill("22");
  await modify.getByRole("button", { name: "Save" }).click();
  await expect(modify).toBeHidden();

  const css = () => page.locator(".page-stack style").innerText();
  await expect.poll(css).toContain("font-size: 22pt");
  await expect(doc.locator('[data-style="Callout"]')).toHaveCount(2);

  // Direct size on one word stays put when the shared style changes again.
  await doc.locator("p").first().click();
  await page.keyboard.press("Home");
  for (let i = 0; i < "Alpha".length; i += 1) await page.keyboard.press("Shift+ArrowRight");
  const size = page.getByRole("textbox", { name: "Font size" });
  await size.fill("16");
  await size.press("Enter");
  await expect(doc.locator("p").first()).toHaveText("Alpha");
  await page.getByRole("button", { name: "Paragraph style" }).click();
  await page.getByRole("menuitem", { name: "Modify style…" }).click();
  await modify.getByLabel("Size").fill("24");
  await modify.getByRole("button", { name: "Save" }).click();
  await expect.poll(css).toContain("font-size: 24pt");
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
  await expect.poll(css).toContain("font-size: 24pt");
  await expect.poll(() => page.locator(".page-stack").evaluate((el) => getComputedStyle(el).getPropertyValue("--theme-heading-font"))).toContain("Georgia");
  await expect(doc.locator('[data-style="Callout"]').first().locator("span").first()).toHaveAttribute("style", /font-size:\s*16pt/);
});
