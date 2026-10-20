import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/agent/chats", { data: { settings: { provider: "claude", model: null, effort: "medium", mode: "agent", maxTurns: null } } });
});
test.afterEach(async ({ request }) => {
  await request.post("/api/agent/chats", { data: { settings: { provider: "claude", model: null, effort: "medium", mode: "agent", maxTurns: null } } });
});

async function selectProvider(page: Page, name: "Claude" | "Codex") {
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name, exact: true }).click();
  await expect(page.getByLabel(`Message ${name}`, { exact: true })).toBeEnabled();
}
async function send(page: Page, provider: string, text: string) {
  const composer = page.getByLabel(`Message ${provider}`, { exact: true });
  await composer.fill(text);
  await composer.press("Enter");
}

test("switch Claude and Codex in the same chat, review both edits and reload", async ({ page, request }) => {
  const response = await request.post("/api/documents", { data: { title: "Two providers", markdown: "Alpha beta gamma." } });
  const id = (await response.json()).document.meta.id;
  await page.goto(`/d/${id}`);
  await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
  if (!(await page.locator(".claude-toggle").getAttribute("class"))?.includes("is-active")) await page.locator(".claude-toggle").click();
  await expect(page.getByLabel("Message Claude", { exact: true })).toBeEnabled();
  await send(page, "Claude", 'replace "Alpha" with "First"');
  await expect(page.locator(".msg-assistant").last()).toContainText("Replaced Alpha with First.");
  await selectProvider(page, "Codex");
  await send(page, "Codex", 'replace "gamma" with "third"');
  await expect(page.locator(".msg-assistant").last()).toContainText("Replaced gamma with third.");
  await expect(page.locator(".review-bar")).toContainText("Claude and Codex");
  await page.locator(".review-bar").getByRole("button", { name: "Keep all" }).click();
  await expect(page.locator(".doc-content")).toHaveText("First beta third.");
  await page.reload();
  await expect(page.getByLabel("Message Codex", { exact: true })).toBeEnabled();
  await expect(page.locator(".msg-assistant")).toHaveCount(2);
  await selectProvider(page, "Claude");
  await send(page, "Claude", 'replace "beta" with "second"');
  await expect(page.locator(".msg-assistant").last()).toContainText("Replaced beta with second.");
  await expect(page.locator(".msg-assistant")).toHaveCount(3);
});

test("Codex uses its own plan usage and can be stopped", async ({ page, request }) => {
  const response = await request.post("/api/documents", { data: { title: "Codex usage", markdown: "Notes." } });
  const id = (await response.json()).document.meta.id;
  await page.goto(`/d/${id}`);
  await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
  if (!(await page.locator(".claude-toggle").getAttribute("class"))?.includes("is-active")) await page.locator(".claude-toggle").click();
  await selectProvider(page, "Codex");
  await send(page, "Codex", "wait for stop");
  await expect(page.locator(".msg-assistant").last()).toContainText("Working until stopped.");
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Pause Codex at" })).toBeVisible();
  await expect(page.locator(".usage-popover")).toContainText("codex · Session");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Message Codex", { exact: true })).toBeEnabled();
});

test("a Claude draft warmed before switching starts on Codex", async ({ page, request }) => {
  const response = await request.post("/api/documents", { data: { title: "Warmed draft", markdown: "Original text." } });
  const id = (await response.json()).document.meta.id;
  await page.goto(`/d/${id}`);
  await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
  if (!(await page.locator(".claude-toggle").getAttribute("class"))?.includes("is-active")) await page.locator(".claude-toggle").click();
  await expect(page.getByLabel("Message Claude", { exact: true })).toBeEnabled();
  await page.getByLabel("Message Claude", { exact: true }).fill('replace "Original" with "Updated"');
  await selectProvider(page, "Codex");
  await page.getByLabel("Message Codex", { exact: true }).press("Enter");
  await expect(page.locator(".msg-assistant").last()).toContainText("Codex");
  await expect(page.locator(".review-bar")).toContainText("by Codex");
});

test("Codex accepts PDF attachments through the built server", async ({ request }) => {
  const { buildTestPdf } = await import("../lib/pdf/import/testPdf");
  const pdf = Buffer.from(buildTestPdf([{ content: "BT /F1 12 Tf 72 700 Td (Attachment contents) Tj ET" }]));
  const upload = await request.post("/api/uploads", { multipart: { file: { name: "source.pdf", mimeType: "application/pdf", buffer: pdf } } });
  expect(upload.ok()).toBeTruthy();
  const attachment = await upload.json();
  const created = await request.post("/api/agent/chats", { data: { settings: { provider: "codex", model: "codex-test" }, message: { text: "Read this PDF", attachments: [{ id: attachment.id, name: attachment.name, mime: attachment.mime, size: attachment.size, kind: attachment.kind }] } } });
  expect(created.ok()).toBeTruthy();
  const { chat } = await created.json();
  await expect.poll(async () => {
    const response = await request.get(`/api/agent/chats/${chat.id}`);
    const current = (await response.json()).chat;
    return current.messages.at(-1)?.status;
  }, { timeout: 30_000 }).toBe("done");
});
