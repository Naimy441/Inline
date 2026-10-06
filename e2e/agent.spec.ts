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
  // The reasoning is shown in full in the latest reply, with no scrolling inside it.
  const reasoning = lastReply(page).locator(".reasoning");
  await expect(reasoning).toHaveClass(/is-open/);
  await expect(reasoning.locator(".reasoning-body")).toContainText("read the document, then make the edit.");
  await expect(reasoning.locator(".reasoning-head")).toContainText(/Thought/);

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

test("each reply's Undo all touches only that reply's changes", async ({ page, request }) => {
  await openWithClaude(page, request, "Alpha beta gamma.");
  await ask(page, 'replace "Alpha" with "First"');
  await expect(lastReply(page)).toContainText("Replaced Alpha with First.");
  await ask(page, 'replace "gamma" with "third"');
  await expect(lastReply(page)).toContainText("Replaced gamma with third.");
  await expect(page.locator(".doc-content .review-insert")).toHaveText(["First", "third"]);

  // Both replies still have their own pending change, so both cards offer review.
  const cards = page.locator(".msg-assistant .change-card");
  await expect(cards.nth(0).getByRole("button", { name: "Undo all" })).toBeVisible();
  await cards.nth(1).getByRole("button", { name: "Undo all" }).click();
  // The first reply's change is untouched and still pending.
  await expect(page.locator(".doc-content .review-insert")).toHaveText(["First"]);
  await expect(page.locator(".doc-content .review-delete")).toHaveText(["Alpha"]);
  await expect(cards.nth(1).getByRole("button", { name: "Undo all" })).toHaveCount(0);
  await cards.nth(0).getByRole("button", { name: "Keep all" }).click();
  await expect(page.locator(".review-bar")).toHaveCount(0);
  await expect(page.locator(".doc-content")).toHaveText("First beta gamma.");
});

test("a reply lists its changes, each kept or undone on its own, and can be restored", async ({ page, request }) => {
  await openWithClaude(page, request, "Alpha beta gamma.");
  await ask(page, 'replace "Alpha" with "First"');
  await expect(lastReply(page)).toContainText("Replaced Alpha with First.");
  const card = lastReply(page).locator(".change-card");
  await card.getByRole("button", { name: /Show 1 change/ }).click();
  const item = lastReply(page).locator(".turn-diff-item");
  await expect(item).toHaveCount(1);
  await expect(item.locator("del")).toHaveText("Alpha");
  await expect(item.locator("ins")).toHaveText("First");
  await item.getByRole("button", { name: "Keep this change" }).click();
  await expect(page.locator(".review-bar")).toHaveCount(0);
  await expect(page.locator(".doc-content")).toHaveText("First beta gamma.");

  // Once reviewed, the reply offers to put the document back as it was before it.
  page.once("dialog", (dialog) => void dialog.accept());
  await card.getByRole("button", { name: "Restore to before" }).click();
  await expect(page.locator(".doc-content")).toHaveText("Alpha beta gamma.");
});

test("typing @ suggests other documents and inserts the mention", async ({ page, request }) => {
  const title = `Mention target ${Date.now()}`;
  await request.post("/api/documents", { data: { title, markdown: "Other text." } });
  await openWithClaude(page, request, "Main text.");
  const composer = page.getByLabel("Message Claude");
  await composer.pressSequentially("Compare with @Mention tar");
  const option = page.getByRole("listbox", { name: "Documents" }).getByRole("option", { name: title });
  await expect(option).toBeVisible();
  await composer.press("Enter");
  await expect(composer).toHaveValue(`Compare with @${title} `);
  await expect(page.getByRole("listbox", { name: "Documents" })).toHaveCount(0);
});

test("the inline prompt sends an edit about the selection straight to Claude", async ({ page, request }) => {
  await openWithClaude(page, request, "The meeting is on Tuesday.");
  await page.getByRole("button", { name: "Hide Claude" }).or(page.locator(".claude-toggle")).first().click();
  await page.locator(".doc-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+k");
  const prompt = page.getByLabel("Ask Claude to edit");
  await expect(prompt).toBeFocused();
  await prompt.fill('replace "Tuesday" with "Thursday"');
  await prompt.press("Enter");
  await expect(prompt).toHaveCount(0);
  // The panel opens with the message sent, and the edit lands for review.
  await expect(page.locator(".msg-user-text").last()).toHaveText('replace "Tuesday" with "Thursday"');
  await expect(page.locator(".doc-content .review-insert")).toContainText("Thursday");
});

test("the spelling shortcut sends the paragraph at the cursor to Claude", async ({ page, request }) => {
  await openWithClaude(page, request, "Ths sentence has a typo.");
  await page.locator(".doc-content").click();
  await page.keyboard.press("ControlOrMeta+Alt+x");
  await expect(page.locator(".msg-user-text").last()).toContainText("Fix spelling, grammar and punctuation in the selected text only.");
  await expect(page.locator(".chip-quote").last()).toContainText("Ths sentence has a typo.");
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

test("a message shows at once, with a live line saying what Claude is doing", async ({ page, request }) => {
  await openWithClaude(page, request, "A long document.");
  // Hold the request back: the message and Claude's activity must show before the server answers.
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/agent/chats", async (route) => {
    if (route.request().method() === "POST" && route.request().postDataJSON()?.message) await held;
    await route.continue();
  });
  await ask(page, "Review everything, take your time");
  await expect(page.locator(".msg-user-text")).toHaveText("Review everything, take your time");
  await expect(page.locator(".activity")).toBeVisible();
  await expect(page.locator(".activity .spark")).toBeVisible();
  release();
  await expect(lastReply(page)).toContainText("Starting a long review.");
  // While text streams, its writing dot is the sign of life; the waiting line steps aside.
  await expect(lastReply(page).locator(".md.is-writing")).toBeVisible();
  await expect(page.locator(".activity")).toHaveCount(0);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator(".activity")).toHaveCount(0);
  await expect(page.locator(".msg-user")).toHaveCount(1);
});

test("closing the panel keeps the unsent message", async ({ page, request }) => {
  await openWithClaude(page, request, "Some text.");
  const composer = page.getByLabel("Message Claude");
  await composer.fill("A draft I'm still writing");
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(composer).toHaveCount(0);
  await showClaude(page);
  await expect(composer).toHaveValue("A draft I'm still writing");
  await page.reload();
  await showClaude(page);
  await expect(page.getByLabel("Message Claude")).toHaveValue("A draft I'm still writing");
  // Sending clears it for good.
  await ask(page, "hello");
  await expect(page.getByLabel("Message Claude")).toHaveValue("");
  await page.reload();
  await showClaude(page);
  await expect(page.getByLabel("Message Claude")).toHaveValue("");
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
