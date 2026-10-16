import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** Dropping a file on Home, and importing every Word document in a folder. */

async function createDocument(request: APIRequestContext, title: string, markdown: string) {
  const response = await request.post("/api/documents", { data: { title, markdown } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { document: { meta: { id: string } } }).document.meta.id;
}

async function exportDocx(request: APIRequestContext, id: string) {
  return new Uint8Array(await (await request.get(`/api/documents/${id}/export?format=docx`)).body());
}

/** Build the drag payload for a desktop file and dispatch it on Home. */
async function dragFile(page: Page, name: string, bytes: Uint8Array, type: string, kind: "dragenter" | "dragover" | "drop") {
  await page.evaluate(
    ({ name, bytes, type, kind }) => {
      const file = new File([new Uint8Array(bytes)], name, { type });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const home = document.querySelector(".home");
      if (!home) throw new Error("Home is not on the page.");
      home.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer }));
    },
    { name, bytes: [...bytes], type, kind },
  );
}

test("dropping a file on Home imports it", async ({ page, request }) => {
  const stamp = Date.now();
  const id = await createDocument(request, `Dropped ${stamp}`, `# Dropped ${stamp}\n\nBrought in by a drop.`);
  const docx = await exportDocx(request, id);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Start something new/ })).toBeVisible();

  const file = { name: `Dropped ${stamp}.docx`, bytes: docx, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  await dragFile(page, file.name, file.bytes, file.type, "dragenter");
  await dragFile(page, file.name, file.bytes, file.type, "dragover");
  await expect(page.getByRole("status").filter({ hasText: "Drop to import" })).toBeVisible();
  await dragFile(page, file.name, file.bytes, file.type, "drop");

  await expect(page).toHaveURL(/\/d\//);
  await expect(page.locator(".doc-content h1")).toHaveText(`Dropped ${stamp}`);
  await expect(page.locator(".doc-content")).toContainText("Brought in by a drop.");
});

test("Import folder takes every Word document, including nested ones, and skips the rest", async ({ page, request }) => {
  const stamp = Date.now();
  const budget = await createDocument(request, `Budget ${stamp}`, `# Budget ${stamp}\n\nRent.`);
  const notes = await createDocument(request, `Notes ${stamp}`, `# Notes ${stamp}\n\nIdeas.`);
  const dir = await mkdtemp(path.join(tmpdir(), "inline-import-"));
  await mkdir(path.join(dir, "Clients"));
  await writeFile(path.join(dir, "readme.txt"), "not a document");
  await writeFile(path.join(dir, `Budget ${stamp}.docx`), await exportDocx(request, budget));
  await writeFile(path.join(dir, "Clients", `Notes ${stamp}.docx`), await exportDocx(request, notes));
  await writeFile(path.join(dir, "Clients", `~$Notes ${stamp}.docx`), Buffer.from("lock"));
  // The sources are already in the library. Trash them so the cards below are the imported copies.
  await request.patch(`/api/documents/${budget}`, { data: { trashed: true } });
  await request.patch(`/api/documents/${notes}`, { data: { trashed: true } });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Import folder" })).toBeVisible();
  await page.locator("input[webkitdirectory]").setInputFiles(dir);

  await expect(page.locator(".toast", { hasText: "Imported 2 documents." })).toBeVisible();
  await expect(page.locator(".doc-card", { hasText: `Budget ${stamp}` })).toBeVisible();
  await expect(page.locator(".doc-card", { hasText: `Notes ${stamp}` })).toBeVisible();
  await expect(page.locator(".doc-card", { hasText: "readme" })).toHaveCount(0);
  await expect(page.locator(".doc-card", { hasText: "~$" })).toHaveCount(0);
});
