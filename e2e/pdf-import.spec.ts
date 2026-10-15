import { expect, test } from "@playwright/test";
import { annotatedTestPdf } from "@/lib/pdf/import/testPdf";

test("a PDF imports as its pages, Claude rebuilds them as text, and its annotations can be shown over them", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto("/");
  await page.locator("input[type=file][accept*='.pdf']").setInputFiles({ name: "Lecture notes.pdf", mimeType: "application/pdf", buffer: Buffer.from(annotatedTestPdf()) });
  await page.waitForURL(/\/d\//, { timeout: 60_000 });
  const documentId = page.url().split("/d/")[1]!.split(/[?#]/)[0]!;

  // The scripted Claude (lib/agent/testing/e2eModel.ts) converts the page with the PDF tools, aligning and comparing it in this editor.
  await expect(page.locator(".doc-content")).toContainText("Binomial distributions look like bell curves", { timeout: 90_000 });
  await expect(page.locator(".msg-assistant").last()).toContainText("Lined up page 1", { timeout: 60_000 });
  await expect(page.locator(".doc-content img[title^='pdf-page:']")).toHaveCount(0);

  const record = await (await page.request.get(`/api/documents/${documentId}`)).json();
  const meta = (record.document ?? record).meta;
  expect(meta.pdfImport).toMatchObject({ pages: 1, inkPages: [1], status: "done", converted: [1] });
  expect(meta.settings.pageSetup.paperSize).toBe("letter");

  // The pen stroke was left off the page, and comes back over it from the View menu.
  await expect(page.locator(".pdf-annotations img")).toHaveCount(0);
  await page.getByRole("button", { name: "View" }).click();
  await page.getByRole("menuitemcheckbox", { name: /Show PDF annotations/ }).click();
  await expect(page.locator(".pdf-annotations img")).toHaveCount(1);
  const pdf = await (await page.request.get(`/api/documents/${documentId}/pdf`)).json();
  expect(pdf.pages[0].ink).toMatch(/^\/api\/uploads\//);
});
