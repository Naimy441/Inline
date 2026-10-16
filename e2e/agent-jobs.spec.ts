import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Command failures and job control, through the scripted Claude
 * (INLINE_FAKE_CLAUDE=1) and the real tool runner.
 */

async function openWithClaude(page: Page, request: APIRequestContext, markdown: string) {
  const response = await request.post("/api/documents", { data: { title: "Agent jobs", markdown } });
  const id = ((await response.json()) as { document: { meta: { id: string } } }).document.meta.id;
  await page.goto(`/d/${id}`);
  await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
  const toggle = page.locator(".claude-toggle");
  if (!((await toggle.getAttribute("class")) ?? "").includes("is-active")) await toggle.click();
  await expect(page.getByLabel("Message Claude")).toBeEnabled();
  return id;
}

async function ask(page: Page, text: string) {
  const composer = page.getByLabel("Message Claude");
  await composer.fill(text);
  await composer.press("Enter");
}

const lastReply = (page: Page) => page.locator(".msg-assistant").last();

test("a broken plot shows stdout, stderr, and the exit reason", async ({ page, request }) => {
  await openWithClaude(page, request, "Plot space.");
  await ask(page, "run a broken plot");
  const reply = lastReply(page);
  await expect(reply).toContainText("exit 1 (finished with an error)");
  await expect(reply).toContainText("stdout-from-plot");
  await expect(reply).toContainText("stderr-from-plot");
  await expect(reply).toContainText("file-says # plot-marker");
  await expect(reply).toContainText("working directory: the document folder");
  const tool = reply.locator(".tool", { hasText: "python3 plot.py" });
  await tool.locator(".tool-head").click();
  await expect(tool.locator(".tool-result")).toContainText("stderr-from-plot");
  await expect(tool.locator(".tool-result")).toContainText("stdout-from-plot");
});

test("two independent reads run in one call", async ({ page, request }) => {
  const alpha = await request.post("/api/documents", { data: { title: "Alpha page", markdown: "Alpha body stays put." } });
  const beta = await request.post("/api/documents", { data: { title: "Beta page", markdown: "Beta body stays put." } });
  const alphaId = ((await alpha.json()) as { document: { meta: { id: string } } }).document.meta.id;
  const betaId = ((await beta.json()) as { document: { meta: { id: string } } }).document.meta.id;
  await openWithClaude(page, request, "The open page.");
  await ask(page, `read ${alphaId} and ${betaId} together`);
  const reply = lastReply(page);
  await expect(reply).toContainText("Started 2 jobs together");
  await expect(reply).toContainText("Alpha body stays put.");
  await expect(reply).toContainText("Beta body stays put.");
});

test("Claude can cancel a command while it is running", async ({ page, request }) => {
  await openWithClaude(page, request, "Wait here.");
  await ask(page, "cancel a long command");
  await expect(lastReply(page)).toContainText("was cancelled");
  await expect(lastReply(page)).not.toContainText("should-not-finish");
});

test("a background job's result is picked up on a later call", async ({ page, request }) => {
  await openWithClaude(page, request, "Come back for this.");
  await ask(page, "start a slow background command");
  await expect(lastReply(page)).toContainText("is still running");
  await expect(lastReply(page)).toContainText(/job_[0-9a-f]+/);
  await ask(page, "pick up the background job");
  await expect(lastReply(page)).toContainText("picked-up");
  await expect(lastReply(page)).toContainText("finished");
});
