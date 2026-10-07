import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { readZip } from "../lib/server/unzip";

/** A Word copy of every document, kept in a folder on disk (INLINE_MIRROR_DIR in playwright.config.ts). */

const mirrorDir = process.env.INLINE_E2E_MIRROR_DIR!;

test("documents are copied to the folder on disk as Word files, in their folders", async ({ page, request }) => {
  const stamp = Date.now();
  const folder = ((await (await request.post("/api/folders", { data: { name: `Clients ${stamp}` } })).json()) as { folder: { id: string } }).folder;
  const response = await request.post("/api/documents", { data: { title: `Proposal ${stamp}`, markdown: `# Proposal ${stamp}\n\nScope and budget.`, folderId: folder.id } });
  expect(response.status()).toBe(201);

  await page.goto("/");
  await page.getByRole("button", { name: "On this computer" }).click();
  const dialog = page.getByRole("dialog", { name: "Copies on this computer" });
  await expect(dialog.getByRole("textbox", { name: "Folder" })).toHaveValue(mirrorDir);
  await expect(dialog.getByRole("textbox", { name: "Folder" })).toBeDisabled();
  await expect(dialog).toContainText("Set by INLINE_MIRROR_DIR");
  await dialog.getByRole("button", { name: "Copy now" }).click();
  await expect(dialog.getByRole("status")).toContainText("Up to date");

  await expect(dialog.getByRole("button", { name: /^Show in (Finder|File Explorer|folder)$/ })).toBeVisible();

  const file = path.join(mirrorDir, `Clients ${stamp}`, `Proposal ${stamp}.docx`);
  await expect.poll(() => existsSync(file)).toBe(true);
  expect(readFileSync(file).subarray(0, 2).toString()).toBe("PK");
  await dialog.getByRole("button", { name: "Done" }).click();

  // Documents and folders offer to show their file on disk.
  await page.locator(".folder-card", { hasText: `Clients ${stamp}` }).getByLabel("Folder actions").click();
  await expect(page.getByRole("menuitem", { name: /^Show in (Finder|File Explorer|folder)$/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // Download all is that folder as a ZIP of Word files.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download all" }).click()]);
  const files = readZip(new Uint8Array(await readFile((await download.path())!)));
  const entry = files.get(`Clients ${stamp}/Proposal ${stamp}.docx`);
  expect(entry, [...files.keys()].join(", ")).toBeTruthy();
  expect(new TextDecoder().decode(readZip(entry!).get("word/document.xml"))).toContain("Scope and budget.");
});
