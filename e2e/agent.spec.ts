import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * The Claude panel end to end. The test server runs a scripted Claude
 * (INLINE_FAKE_CLAUDE=1, lib/agent/testing/e2eModel.ts) that acts through
 * Inline's real MCP tools, so everything after the model is the real path:
 * the agent runtime, the event stream, live review and the panel UI.
 */

async function openWithClaude(page: Page, request: APIRequestContext, markdown: string) {
  const response = await request.post("/api/documents", { data: { title: "Agent test", markdown } });
  const id = ((await response.json()) as { document: { meta: { id: string } } }).document.meta.id;
  await page.goto(`/d/${id}`);
  await showClaude(page);
  return id;
}

async function showClaude(page: Page) {
  // Wait for the editor so the panel's open state has been restored before toggling it.
  await expect(page.locator(".doc-content")).toHaveAttribute("contenteditable", "true");
  const toggle = page.locator(".claude-toggle");
  if (!((await toggle.getAttribute("class")) ?? "").includes("is-active")) await toggle.click();
  await expect(page.getByLabel("Message Claude")).toBeEnabled();
}

async function ask(page: Page, text: string) {
  const composer = page.getByLabel("Message Claude");
  await composer.fill(text);
  await composer.press("Enter");
}

const lastReply = (page: Page) => page.locator(".msg-assistant").last();

test("Claude edits the document and the user keeps the change", async ({ page, request }) => {
  await openWithClaude(page, request, "The meeting is on Tuesday.");
  await ask(page, 'replace "Tuesday" with "Thursday"');

  await expect(page.locator(".msg-user-text").last()).toHaveText('replace "Tuesday" with "Thursday"');
  await expect(lastReply(page)).toContainText("Replaced Tuesday with Thursday.");
  await expect(lastReply(page).locator(".tool")).toHaveCount(2);
  await expect(lastReply(page).locator(".tool.is-error")).toHaveCount(0);
  await expect(page.locator(".todos")).toContainText("Make the edit");
  await expect(lastReply(page).locator(".change-card")).toContainText("Edited");

  await expect(page.locator(".doc-content .review-insert")).toContainText("Thursday");
  await expect(page.locator(".review-bar")).toBeVisible();
  await page.locator(".review-bar").getByRole("button", { name: "Keep all" }).click();
  await expect(page.locator(".review-bar")).toHaveCount(0);
  await expect(page.locator(".doc-content")).toHaveText("The meeting is on Thursday.");
});

test("undoing Claude's change from the reply restores the text", async ({ page, request }) => {
  await openWithClaude(page, request, "Keep the original wording.");
  await ask(page, 'replace "original" with "rewritten"');
  await expect(page.locator(".doc-content .review-insert")).toContainText("rewritten");
  await lastReply(page).locator(".change-card").getByRole("button", { name: "Undo all" }).click();
  await expect(page.locator(".doc-content")).toHaveText("Keep the original wording.");
  await expect(page.locator(".review-bar")).toHaveCount(0);
});

test("a failed edit is shown as a failed tool call", async ({ page, request }) => {
  await openWithClaude(page, request, "Nothing to see here.");
  await ask(page, 'replace "missing words" with "anything"');
  await expect(lastReply(page)).toContainText("I could not make that edit");
  await expect(lastReply(page).locator(".tool.is-error")).toHaveCount(1);
  await expect(page.locator(".doc-content")).toHaveText("Nothing to see here.");
});

test("Claude can leave a comment", async ({ page, request }) => {
  await openWithClaude(page, request, "Revenue grew 40% last year.");
  await ask(page, 'comment on "grew 40%": Add the source for this figure.');
  await expect(lastReply(page)).toContainText("I left a comment.");
  await expect(page.locator(".doc-content .comment-hl")).toHaveText("grew 40%");
  await page.getByRole("button", { name: "Comments" }).click();
  const card = page.locator(".comment-card", { hasText: "Add the source for this figure." });
  await expect(card).toBeVisible();
  await expect(card.locator(".comment-author")).toHaveText("Claude");
});

test("follow-ups queue while Claude works, and Stop ends the turn", async ({ page, request }) => {
  await openWithClaude(page, request, "A long document.");
  await ask(page, "Review everything, take your time");
  await expect(lastReply(page)).toContainText("Starting a long review.");

  await ask(page, "Then summarize it");
  await expect(page.locator(".queue-item")).toHaveText(/Then summarize it/);
  await page.getByLabel("Remove from queue").click();
  await expect(page.locator(".queue-item")).toHaveCount(0);

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(lastReply(page).locator(".msg-note")).toHaveText(/^Stopped\./);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.locator(".msg-user")).toHaveCount(1);
});

test("an error explains itself and Retry runs the message again", async ({ page, request }) => {
  await openWithClaude(page, request, "Text.");
  await ask(page, `Please fail once ${Date.now()}`);
  await expect(lastReply(page).locator(".msg-error")).toContainText(/sign/i);
  await lastReply(page).getByRole("button", { name: "Retry" }).click();
  await expect(lastReply(page)).toContainText("You said: Please fail once");
  await expect(page.locator(".msg-assistant")).toHaveCount(1);
});

test("the conversation survives a reload", async ({ page, request }) => {
  await openWithClaude(page, request, "Text.");
  await ask(page, "Remember this message");
  await expect(lastReply(page)).toContainText("You said: Remember this message");
  await page.reload();
  await showClaude(page);
  await expect(page.locator(".msg-user-text")).toHaveText("Remember this message");
  await expect(lastReply(page)).toContainText("You said: Remember this message");
});
