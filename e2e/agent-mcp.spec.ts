import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * End-to-end proof of Inline's agentic MCP surface: a real MCP client (the
 * official SDK, the same one Claude Code uses) talks to /api/mcp on the real
 * Next.js server while a real browser has the document open. Every test
 * checks both sides: what the MCP tools report and what the user sees.
 */

// ---------------------------------------------------------------------------
// MCP helpers

type ToolCall = { text: string; isError: boolean };

async function connect(baseURL: string) {
  const client = new Client({ name: "inline-e2e", version: "1.0.0" });
  // No Origin header is sent, as with Claude Code, so the proxy's CSRF check lets it through.
  const { token } = (await (await fetch(new URL("/api/mcp/connect", baseURL))).json()) as { token: string };
  await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", baseURL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function withClient<T>(baseURL: string, run: (client: Client) => Promise<T>) {
  const client = await connect(baseURL);
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

class Mcp {
  constructor(private readonly baseURL: string) {}

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
    return withClient(this.baseURL, async (client) => {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      return { text: content.map((item) => item.text ?? "").join("\n"), isError: Boolean(result.isError) };
    });
  }

  /** Call a tool that must succeed and return its text. */
  async ok(name: string, args: Record<string, unknown> = {}) {
    const result = await this.call(name, args);
    expect(result.isError, `${name} failed: ${result.text}`).toBe(false);
    return result.text;
  }

  /** Markdown body of a document, without read_document's header and line numbers. */
  async markdown(documentId: string) {
    const text = await this.ok("read_document", { document_id: documentId });
    return text
      .split("\n")
      .slice(1)
      .filter((line) => /^\s*\d+\t/.test(line))
      .map((line) => line.replace(/^\s*\d+\t/, ""))
      .join("\n");
  }
}

/** Tool names and hints straight from lib/agent/tools.ts, so the test can't drift from the registry. */
function toolsFromSource() {
  const source = readFileSync(path.join(__dirname, "..", "lib", "agent", "tools.ts"), "utf8");
  const blocks = source.split("defineTool({").slice(1);
  return blocks.map((block) => {
    const name = /name:\s*"([a-z_]+)"/.exec(block)?.[1];
    const write = /\n\s*write:\s*(true|false)/.exec(block)?.[1];
    if (!name || !write) throw new Error(`Could not parse a tool definition: ${block.slice(0, 120)}`);
    return { name, write: write === "true", destructive: /\n\s*destructive:\s*true/.test(block) };
  });
}

// ---------------------------------------------------------------------------
// Browser helpers

async function createDocument(request: APIRequestContext, input: { title?: string; markdown?: string } = {}) {
  const response = await request.post("/api/documents", { data: input });
  expect(response.status()).toBe(201);
  const { document } = (await response.json()) as { document: { meta: { id: string; title: string } } };
  return document.meta;
}

/** Open a document and wait until its live event stream is connected. */
async function openInEditor(page: Page, id: string) {
  const stream = page.waitForResponse((response) => response.url().includes(`/api/documents/${id}/events`));
  await page.goto(`/d/${id}`);
  await expect(page.locator(".doc-content")).toBeVisible();
  await stream;
}

async function newDocumentInEditor(page: Page, request: APIRequestContext, input: { title?: string; markdown?: string } = {}) {
  const meta = await createDocument(request, input);
  await openInEditor(page, meta.id);
  return meta;
}

/** Text of the document's paragraphs as the user reads it, without the struck-through text of pending deletions. */
async function readableParagraphs(page: Page) {
  return page.locator(".doc-content").evaluate((root) =>
    [...root.querySelectorAll(":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > ul li, :scope > ol li")].map((element) => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".review-delete, .review-controls").forEach((node) => node.remove());
      return (clone.textContent ?? "").replace(/ /g, " ").trim();
    }),
  );
}

async function waitUntilSaved(page: Page) {
  await expect(page.locator(".sync-status")).toHaveText(/Saved/, { timeout: 15_000 });
}

/** Hover a pending change so its Keep / Undo controls appear in the margin. */
async function revealControls(page: Page, text: string) {
  await page.locator(".doc-content .review-insert", { hasText: text }).first().hover();
  await expect(page.locator(".review-controls")).toBeVisible();
}

/**
 * External MCP clients have no document of their own, so open_document is shown
 * in the most recently focused tab. Focus ours, ask the agent to open `target`,
 * and follow the toast. Other spec files running in parallel can steal focus
 * between the two steps, so retry a few times.
 */
async function openViaAgent(page: Page, current: string, target: string) {
  const toastBox = page.locator(".toast", { hasText: "Claude opened another document." }).last();
  for (let attempt = 0; attempt < 8; attempt++) {
    const focused = page.waitForResponse((response) => response.url().includes(`/api/documents/${current}/selection`));
    await page.locator(".doc-content").evaluate((element) => (element as HTMLElement).blur());
    await page.locator(".doc-content").focus();
    await focused;
    const text = await mcp.ok("open_document", { document_id: target });
    expect(text).toMatch(/^Opened ".+" in the editor\.$/);
    const shown = await expect(toastBox)
      .toBeVisible({ timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (shown) break;
  }
  await toastBox.locator(".toast-action", { hasText: "Open" }).click();
  await page.waitForURL(`**/d/${target}`);
  await expect(page.locator(".doc-content")).toBeVisible();
}

let mcp: Mcp;

test.beforeEach(async ({ baseURL }) => {
  mcp = new Mcp(baseURL!);
});

// ---------------------------------------------------------------------------
// Handshake and tool registry

test.describe("handshake", () => {
  test("server identifies itself as Inline and explains how to use it", async ({ baseURL }) => {
    await withClient(baseURL!, async (client) => {
      const info = client.getServerVersion();
      expect(info?.name).toBe("inline");
      expect(info?.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(client.getServerCapabilities()?.tools).toBeTruthy();
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("Inline is a document editor");
      expect(instructions).toContain("keep or undo");
    });
  });

  test("tools/list exposes every registered tool with correct hints and schemas", async ({ baseURL }) => {
    const expected = toolsFromSource();
    expect(expected.length).toBeGreaterThanOrEqual(27);
    const { tools } = await withClient(baseURL!, (client) => client.listTools());

    expect(tools.map((tool) => tool.name).sort()).toEqual(expected.map((tool) => tool.name).sort());
    for (const definition of expected) {
      const tool = tools.find((item) => item.name === definition.name)!;
      expect(tool.description, definition.name).toBeTruthy();
      expect(tool.title ?? tool.annotations?.title, definition.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, `${definition.name} readOnlyHint`).toBe(!definition.write);
      expect(tool.annotations?.destructiveHint, `${definition.name} destructiveHint`).toBe(definition.destructive);
      expect(tool.annotations?.openWorldHint, `${definition.name} openWorldHint`).toBe(false);
      expect(tool.inputSchema.type).toBe("object");
    }

    // Spot-check the contracts clients depend on.
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("edit_document")!.inputSchema.required).toEqual(expect.arrayContaining(["old_string", "new_string"]));
    expect(byName.get("insert_content")!.inputSchema.required).toEqual(expect.arrayContaining(["content", "position"]));
    expect(Object.keys(byName.get("read_document")!.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["document_id", "offset", "limit"]));
    expect(byName.get("write_document")!.annotations?.destructiveHint).toBe(true);
    expect(byName.get("restore_version")!.annotations?.destructiveHint).toBe(true);
    expect(byName.get("read_document")!.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("edit_document")!.annotations?.readOnlyHint).toBe(false);
  });

  test("the endpoint rejects cross-site browser requests", async ({ request }) => {
    const response = await request.post("/api/mcp", {
      headers: { Origin: "https://evil.example", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(response.status()).toBe(403);
  });

  test("the endpoint needs the MCP token, and Help shows the command that carries it", async ({ request }) => {
    const call = (headers: Record<string, string> = {}) =>
      request.post("/api/mcp", { headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    expect((await call()).status()).toBe(401);
    expect((await call({ Authorization: "Bearer wrong" })).status()).toBe(401);
    const { token, command } = (await (await request.get("/api/mcp/connect")).json()) as { token: string; command: string };
    expect(command).toContain(`--header "Authorization: Bearer ${token}"`);
    expect((await call({ Authorization: `Bearer ${token}` })).status()).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Review flow: live edits, keep and undo

test.describe("review of agent edits", () => {
  test("edit_document appears live as a pending change and Keep makes it permanent", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Keep flow", markdown: "The meeting is on Tuesday.\n\nBring the quarterly report." });
    await expect(page.locator(".doc-content p").first()).toHaveText("The meeting is on Tuesday.");

    const text = await mcp.ok("edit_document", { document_id: id, old_string: "on Tuesday", new_string: "on Thursday at noon" });
    expect(text).toContain("marked for the user's review");

    // Live, without reload: the new text is tinted and the old text struck through.
    await expect(page.locator(".doc-content .review-insert")).toContainText("Thursday at noon");
    await expect(page.locator(".doc-content .review-delete")).toContainText("Tuesday");
    await expect(page.locator(".review-bar-count")).toHaveText("1 change by Claude");
    expect(await mcp.ok("get_pending_changes", { document_id: id })).toMatch(/1 pending change.*\n- \S+ \(line 1, by Claude\): "Tuesday" → "Thursday at noon"/);

    await revealControls(page, "Thursday");
    await page.locator(".review-controls .review-keep").click();

    await expect(page.locator(".doc-content .review-insert")).toHaveCount(0);
    await expect(page.locator(".doc-content .review-delete")).toHaveCount(0);
    await expect(page.locator(".review-bar")).toHaveCount(0);
    await expect(page.locator(".doc-content p").first()).toHaveText("The meeting is on Thursday at noon.");
    await expect.poll(() => mcp.ok("get_pending_changes", { document_id: id })).toBe("No pending changes.");
    expect(await mcp.markdown(id)).toBe("The meeting is on Thursday at noon.\n\nBring the quarterly report.");

    await page.reload();
    await expect(page.locator(".doc-content p").first()).toHaveText("The meeting is on Thursday at noon.");
    await expect(page.locator(".doc-content .review-insert")).toHaveCount(0);
  });

  test("page counts leave out struck-out text that's awaiting review", async ({ page, request }) => {
    const filler = "The clerk counted the names in his little book while the rain kept falling on the roof.";
    const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ${filler} Cut ${i}: ${filler.repeat(3)}`);
    const { id } = await newDocumentInEditor(page, request, { title: "Pending count", markdown: paragraphs.join("\n\n") });
    await expect(page.locator(".statusbar")).toContainText("3 pages");
    await mcp.ok("multi_edit_document", { document_id: id, edits: paragraphs.map((_, i) => ({ old_string: ` Cut ${i}: ${filler.repeat(3)}`, new_string: "" })) });
    await expect(page.locator(".review-bar-count")).toHaveText("30 changes by Claude");

    const pending = await mcp.ok("get_page_count", { document_id: id });
    const kept = Number(pending.match(/fills (\d+) pages? once the pending changes are kept/)?.[1]);
    expect(kept, pending).toBeLessThan(3);
    expect(pending).toContain("The editor shows 3 pages until then");

    // Once kept, the editor lays out exactly the count Claude was given.
    await page.locator(".review-bar .btn-primary").click();
    await expect(page.locator(".doc-content .review-delete")).toHaveCount(0);
    await expect(page.locator(".statusbar")).toContainText(`${kept} page`);
    await expect.poll(async () => (await mcp.ok("get_page_count", { document_id: id })).match(/fills (\d+) pages?, as laid out/)?.[1]).toBe(String(kept));
  });

  test("pages lay out again after Keep all removes struck-out text", async ({ page, request }) => {
    const filler = "The clerk counted the names in his little book while the rain kept falling on the roof.";
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${filler.repeat(1 + (i % 4))} Cut sentence ${i} is long enough to take most of a line on the page with it.`);
    const { id } = await newDocumentInEditor(page, request, { title: "Keep all layout", markdown: paragraphs.join("\n\n") });
    const edits = paragraphs.map((_, i) => ({ old_string: ` Cut sentence ${i} is long enough to take most of a line on the page with it.`, new_string: ` Short ${i}.` }));
    await mcp.ok("multi_edit_document", { document_id: id, edits });
    await expect(page.locator(".review-bar-count")).toHaveText("40 changes by Claude");

    await page.locator(".review-bar .btn-primary").click();
    await expect(page.locator(".doc-content .review-delete")).toHaveCount(0);

    // Every line of text sits inside a page's text area, not in a margin or between pages.
    const outside = () =>
      page.evaluate(() => {
        const sheets = [...document.querySelectorAll(".sheet")].map((sheet) => sheet.getBoundingClientRect());
        const margin = 96 * (sheets[0]!.height / 1056);
        const range = document.createRange();
        const text = document.createTreeWalker(document.querySelector(".doc-content")!, NodeFilter.SHOW_TEXT);
        let count = 0;
        while (text.nextNode()) {
          range.selectNodeContents(text.currentNode);
          for (const line of range.getClientRects()) {
            const middle = (line.top + line.bottom) / 2;
            if (!sheets.some((sheet) => middle > sheet.top + margin && middle < sheet.bottom - margin)) count += 1;
          }
        }
        return count;
      });
    // Nothing else changes the document, so a layout that went stale would stay stale.
    await page.waitForTimeout(1000);
    expect(await outside()).toBe(0);
  });

  test("Undo in the editor restores the original text for the user and for the agent", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Undo flow", markdown: "Revenue grew 4% last year.\n\nCosts were flat." });

    await mcp.ok("edit_document", { document_id: id, old_string: "Revenue grew 4% last year.", new_string: "Revenue grew a staggering 40% last year." });
    await expect(page.locator(".doc-content .review-insert")).toContainText("staggering");

    await revealControls(page, "staggering");
    await page.locator(".review-controls .review-undo").click();

    await expect(page.locator(".doc-content .review-insert")).toHaveCount(0);
    await expect(page.locator(".doc-content .review-delete")).toHaveCount(0);
    expect(await readableParagraphs(page)).toEqual(["Revenue grew 4% last year.", "Costs were flat."]);
    await expect.poll(() => mcp.markdown(id)).toBe("Revenue grew 4% last year.\n\nCosts were flat.");
    expect(await mcp.ok("get_pending_changes", { document_id: id })).toBe("No pending changes.");
  });

  test("revert_changes from MCP removes the highlight in the browser", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Revert flow", markdown: "First point.\n\nSecond point." });

    await mcp.ok("multi_edit_document", {
      document_id: id,
      edits: [
        { old_string: "First point.", new_string: "First point, expanded." },
        { old_string: "Second point.", new_string: "Second point, expanded." },
      ],
    });
    await expect(page.locator(".doc-content .review-insert")).toHaveCount(2);
    await expect(page.locator(".review-bar-count")).toHaveText("2 changes by Claude");

    // Retract one change by id, then the rest.
    const pending = await mcp.ok("get_pending_changes", { document_id: id });
    const ids = [...pending.matchAll(/^- (\S+) \(/gm)].map((match) => match[1]!);
    expect(ids).toHaveLength(2);
    expect(await mcp.ok("revert_changes", { document_id: id, change_ids: [ids[0]] })).toContain("Reverted 1 change");
    await expect(page.locator(".doc-content .review-insert")).toHaveCount(1);
    await expect(page.locator(".review-bar-count")).toHaveText("1 change by Claude");

    expect(await mcp.ok("revert_changes", { document_id: id, all: true })).toContain("Reverted 1 change");
    await expect(page.locator(".doc-content .review-insert")).toHaveCount(0);
    await expect(page.locator(".doc-content .review-delete")).toHaveCount(0);
    await expect(page.locator(".review-bar")).toHaveCount(0);
    expect(await readableParagraphs(page)).toEqual(["First point.", "Second point."]);

    const nothing = await mcp.call("revert_changes", { document_id: id, all: true });
    expect(nothing).toEqual({ isError: true, text: "No matching pending changes." });
  });

  test("keep_changes from MCP accepts edits and clears the review bar", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Keep via MCP", markdown: "Draft sentence." });
    await mcp.ok("edit_document", { document_id: id, old_string: "Draft sentence.", new_string: "Final sentence." });
    await expect(page.locator(".review-bar")).toBeVisible();

    expect(await mcp.ok("keep_changes", { document_id: id, all: true })).toContain("Kept 1 change");
    await expect(page.locator(".review-bar")).toHaveCount(0);
    await expect(page.locator(".doc-content .review-insert")).toHaveCount(0);
    await expect(page.locator(".doc-content p")).toHaveText(["Final sentence."]);
  });

  test("Keep all in the review bar accepts every pending change", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Keep all", markdown: "one\n\ntwo\n\nthree" });
    await mcp.ok("edit_document", { document_id: id, old_string: "one", new_string: "ONE" });
    await mcp.ok("edit_document", { document_id: id, old_string: "three", new_string: "THREE" });
    await expect(page.locator(".review-bar-count")).toHaveText("2 changes by Claude");

    await page.locator(".review-bar .btn-primary", { hasText: "Keep all" }).click();
    await expect(page.locator(".review-bar")).toHaveCount(0);
    await expect.poll(() => mcp.ok("get_pending_changes", { document_id: id })).toBe("No pending changes.");
    expect(await mcp.markdown(id)).toBe("ONE\n\ntwo\n\nTHREE");
  });
});

// ---------------------------------------------------------------------------
// Rendering of agent writes

test.describe("agent writes render in the editor", () => {
  test("write_document renders headings, lists and emphasis", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Write" });
    await mcp.ok("write_document", {
      document_id: id,
      content: "# Launch plan\n\nWe ship on **Friday** with *care*.\n\n## Risks\n\n- Load spikes\n- Late reviews\n\n1. Freeze\n2. Ship",
    });

    const doc = page.locator(".doc-content");
    await expect(doc.locator("h1")).toHaveText("Launch plan");
    await expect(doc.locator("h2")).toHaveText("Risks");
    await expect(doc.locator("strong")).toHaveText("Friday");
    await expect(doc.locator("em")).toHaveText("care");
    await expect(doc.locator("ul > li")).toHaveText(["Load spikes", "Late reviews"]);
    await expect(doc.locator("ol > li")).toHaveText(["Freeze", "Ship"]);
    await expect(doc.locator(".review-insert").first()).toBeVisible();
    await expect(page.locator(".review-bar")).toBeVisible();
    expect(await mcp.ok("get_outline", { document_id: id })).toMatch(/# Launch plan[\s\S]*## Risks/);
  });

  test("insert_content adds blocks at the end and after a given line", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Insert", markdown: "Alpha\n\nGamma" });

    await mcp.ok("insert_content", { document_id: id, content: "Delta", position: "end" });
    await expect.poll(() => readableParagraphs(page)).toEqual(["Alpha", "Gamma", "Delta"]);

    // Line 1 is "Alpha", line 2 the blank separator, line 3 "Gamma".
    await mcp.ok("insert_content", { document_id: id, content: "Beta", position: "after_line", line: 1 });
    await expect.poll(() => readableParagraphs(page)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);

    await mcp.ok("insert_content", { document_id: id, content: "## Start", position: "start" });
    await expect(page.locator(".doc-content h2")).toHaveText("Start");
    await expect(page.locator(".doc-content .review-block")).toHaveCount(3);

    const missingLine = await mcp.call("insert_content", { document_id: id, content: "x", position: "after_line" });
    expect(missingLine.isError).toBe(true);
    expect(missingLine.text).toContain("line is required");
  });

  test("format_text applies bold, color, highlight and links that render in the editor", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Format", markdown: "The quick brown fox jumps over the lazy dog." });
    const doc = page.locator(".doc-content");

    await mcp.ok("format_text", { document_id: id, text: "quick", bold: true });
    await expect(doc.locator("strong")).toHaveText("quick");

    await mcp.ok("format_text", { document_id: id, text: "brown", color: "#c5221f" });
    const brown = doc.locator('span[style*="color"]', { hasText: "brown" });
    await expect(brown).toHaveCSS("color", "rgb(197, 34, 31)");

    await mcp.ok("format_text", { document_id: id, text: "lazy", highlight: true });
    await expect(doc.locator("mark")).toHaveText("lazy");

    await mcp.ok("format_text", { document_id: id, text: "dog", link: "https://example.com/dog" });
    await expect(doc.locator('a[href="https://example.com/dog"]')).toHaveText("dog");

    // Formatting-only changes are flagged for review without striking anything through.
    await expect(doc.locator(".review-format").first()).toBeVisible();
    await expect(doc.locator(".review-delete")).toHaveCount(0);
    expect(await mcp.markdown(id)).toBe("The **quick** brown fox jumps over the ==lazy== [dog](https://example.com/dog).");

    const ambiguous = await mcp.call("format_text", { document_id: id, text: "o", italic: true });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toMatch(/appears \d+ times/);
  });

  test("set_paragraph_style turns a line into a centered heading", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Style", markdown: "Chapter one\n\nIt was a dark night." });
    await mcp.ok("set_paragraph_style", { document_id: id, from_line: 1, type: "heading", level: 2, align: "center" });
    const heading = page.locator(".doc-content h2");
    await expect(heading).toHaveText("Chapter one");
    await expect(heading).toHaveCSS("text-align", "center");
    expect((await mcp.markdown(id)).split("\n")[0]).toBe("## Chapter one {align=center}");
  });
});

// ---------------------------------------------------------------------------
// Comments

test.describe("comments", () => {
  test("add_comment shows a card; the user's reply and resolve reach list_comments", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Comments", markdown: "Our churn fell sharply in Q3.\n\nSee appendix." });
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await expect(page.locator(".side-panel[aria-label=Comments]")).toBeVisible();

    const added = await mcp.ok("add_comment", { document_id: id, text: "fell sharply", comment: "Cite the source for this number." });
    const commentId = /Added comment (\S+) on line 1/.exec(added)?.[1];
    expect(commentId).toBeTruthy();

    const card = page.locator(".comment-card", { hasText: "Cite the source for this number." });
    await expect(card).toBeVisible();
    await expect(card.locator(".comment-author").first()).toHaveText("Claude");
    await expect(card.locator(".comment-quote")).toHaveText("fell sharply");
    await expect(page.locator(`.doc-content [data-comment-id="${commentId}"]`)).toHaveText("fell sharply");
    // Comments are not content changes.
    await expect(page.locator(".review-bar")).toHaveCount(0);

    // The user replies in the UI.
    await card.click();
    const replyBox = card.locator(".comment-reply-box textarea");
    await replyBox.fill("Source is the Q3 board deck.");
    await replyBox.press("Enter");
    await expect(card.locator(".comment-reply .comment-body")).toHaveText("Source is the Q3 board deck.");
    await expect
      .poll(() => mcp.ok("list_comments", { document_id: id }))
      .toContain(`[${commentId}] Claude on "fell sharply": Cite the source for this number.\n    ↳ User: Source is the Q3 board deck.`);

    // Claude replies over MCP and the user sees it.
    await mcp.ok("reply_to_comment", { document_id: id, comment_id: commentId, reply: "Thanks, added a footnote." });
    await expect(card.locator(".comment-reply .comment-body").last()).toHaveText("Thanks, added a footnote.");

    // The user resolves it in the UI.
    await card.getByRole("button", { name: "Resolve" }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(() => mcp.ok("list_comments", { document_id: id })).toBe("No open comments.");
    expect(await mcp.ok("list_comments", { document_id: id, include_resolved: true })).toContain(`[${commentId}] (resolved)`);

    // Reopening over MCP brings the card back.
    await mcp.ok("resolve_comment", { document_id: id, comment_id: commentId, resolved: false });
    await expect(page.locator(".comment-card", { hasText: "Cite the source" })).toBeVisible();
  });

  test("comments the user writes in the editor are visible to the agent", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "User comment" });
    await page.locator(".doc-content").click();
    await page.keyboard.type("Commentable sentence here.");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Control+Alt+m");
    await page.keyboard.type("Is this accurate?");
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".comment-card .comment-body")).toHaveText("Is this accurate?");

    await expect.poll(() => mcp.ok("list_comments", { document_id: id })).toMatch(/\] User on "Commentable sentence here\.": Is this accurate\?/);
    expect(await mcp.ok("get_editor_context", { document_id: id })).toContain("1 open comment");
  });
});

// ---------------------------------------------------------------------------
// User activity visible to the agent

test.describe("the agent sees what the user does", () => {
  test("typing is visible to read_document and the selection to get_editor_context", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request);
    await page.locator(".doc-content").click();
    await page.keyboard.type("# Trip notes\nPack the blue umbrella today.");
    await waitUntilSaved(page);

    await expect.poll(() => mcp.markdown(id)).toBe("# Trip notes\n\nPack the blue umbrella today.");
    expect(await mcp.ok("search_document", { document_id: id, pattern: "umbrella" })).toMatch(/1 matching line[\s\S]*\s3\tPack the blue umbrella today\./);

    // Select "umbrella today." with the keyboard (15 characters back from the end).
    await page.keyboard.press("End");
    for (let i = 0; i < "umbrella today.".length; i++) await page.keyboard.press("Shift+ArrowLeft");
    await expect.poll(() => mcp.ok("get_editor_context", { document_id: id })).toContain('Selection (lines 3-3):\n"""\numbrella today.\n"""');

    // A collapsed cursor is reported as a line.
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => mcp.ok("get_editor_context", { document_id: id })).toContain("Cursor is on line 1; nothing is selected.");
  });

  test("get_editor_context reports suggesting mode and the user's suggestions", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Suggest", markdown: "Plain text." });
    await page.locator(".tb-mode").click();
    await page.locator(".menu-item", { hasText: "Suggesting" }).click();
    await page.locator(".doc-content p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Suggested.");
    await expect(page.locator(".review-bar-count")).toHaveText("1 suggestion");

    await expect.poll(() => mcp.ok("get_editor_context", { document_id: id })).toContain("1 suggestion by the user awaiting review");
    expect(await mcp.ok("get_editor_context", { document_id: id })).toContain("The user's editor is in suggesting mode.");
    await expect.poll(() => mcp.ok("get_pending_changes", { document_id: id })).toMatch(/\(line 1, suggested by the user\): "" → "Suggested\."/);
  });
});

// ---------------------------------------------------------------------------
// Documents and settings

test.describe("documents and settings", () => {
  test("create_document and open_document navigate the open browser tab", async ({ page, request }) => {
    const original = await newDocumentInEditor(page, request, { title: "Origin doc", markdown: "Start here." });

    const created = await mcp.ok("create_document", { title: "Agent brief", content: "# Brief\n\nWritten by the agent.", open: false });
    const newId = /\(id (\S+)\)/.exec(created)?.[1]!;
    expect(newId).toBeTruthy();
    expect(await mcp.ok("list_documents")).toContain(`${newId}: "Agent brief"`);
    await expect(page.locator(".toast")).toHaveCount(0);

    await openViaAgent(page, original.id, newId);
    await expect(page.locator(".doc-content h1")).toHaveText("Brief");
    await expect(page.locator(".title-input")).toHaveValue("Agent brief");

    // And back again from the new document.
    await openViaAgent(page, newId, original.id);
    await expect(page.locator(".doc-content p")).toHaveText(["Start here."]);

    const missing = await mcp.call("open_document", { document_id: "nope-not-real" });
    expect(missing).toEqual({ isError: true, text: 'Document "nope-not-real" was not found.' });
  });

  test("update_document_settings changes font, margins, header and title in the editor", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Settings", markdown: "Body text." });
    const content = page.locator(".page-content");
    await expect(content).toHaveCSS("left", "96px");

    await mcp.ok("update_document_settings", {
      document_id: id,
      title: "Board memo",
      font_family: "Georgia",
      font_size: 14,
      margins: { left: 2 },
      header: "Confidential · {title}",
      header_align: "right",
      page_numbers: { enabled: true, position: "footer", align: "center" },
    });

    await expect(content).toHaveCSS("font-family", /Georgia/);
    await expect(content).toHaveCSS("font-size", /^18\.6/); // 14pt
    await expect(content).toHaveCSS("left", "192px"); // 2in at 96px/in
    await expect(page.locator(".sheet-header").first()).toHaveText("Confidential · Board memo");
    await expect(page.locator(".sheet-footer .sheet-number").first()).toHaveText("1");
    await expect(page.locator(".title-input")).toHaveValue("Board memo");

    const settings = JSON.parse(await mcp.ok("get_document_settings", { document_id: id })) as {
      title: string;
      fontFamily: string;
      fontSize: number;
      pageSetup: { margins: { left: number; right: number } };
      headerFooter: { header: string; headerAlign: string };
    };
    expect(settings.title).toBe("Board memo");
    expect(settings.fontFamily).toContain("Georgia");
    expect(settings.fontSize).toBe(14);
    expect(settings.pageSetup.margins).toMatchObject({ left: 2, right: 1 });
    expect(settings.headerFooter).toMatchObject({ header: "Confidential · {title}", headerAlign: "right" });

    // Survives a reload (persisted on the server, not just pushed to the tab).
    await page.reload();
    await expect(page.locator(".page-content")).toHaveCSS("left", "192px");
    await expect(page.locator(".sheet-header").first()).toHaveText("Confidential · Board memo");

    expect(await mcp.call("update_document_settings", { document_id: id })).toEqual({ isError: true, text: "No settings given." });
  });

  test("versions: save_version, list_versions and restore_version update the open editor", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Versions", markdown: "Version one text." });
    const saved = await mcp.ok("save_version", { document_id: id, label: "Before rewrite" });
    const versionId = /\((\S+)\)\.$/.exec(saved)?.[1];
    expect(versionId).toBeTruthy();

    await mcp.ok("write_document", { document_id: id, content: "Completely different text." });
    await expect.poll(() => readableParagraphs(page)).toEqual(["Completely different text."]);
    await mcp.ok("keep_changes", { document_id: id, all: true });

    expect(await mcp.ok("list_versions", { document_id: id })).toContain(`${versionId}: "Before rewrite" · claude`);
    expect(await mcp.ok("restore_version", { document_id: id, version_id: versionId })).toContain('to "Before rewrite"');
    await expect.poll(() => readableParagraphs(page)).toEqual(["Version one text."]);
    await expect(page.locator(".review-bar")).toHaveCount(0);
    expect(await mcp.ok("list_versions", { document_id: id })).toContain("Before restoring a version");
  });
});

// ---------------------------------------------------------------------------
// Concurrency

test.describe("concurrent editing", () => {
  test("the user types while an MCP edit lands; both survive and nothing desyncs after reload", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, {
      title: "Concurrent",
      markdown: "Intro paragraph that Claude will rewrite.\n\nUser paragraph:",
    });
    await page.locator(".doc-content p").nth(1).click();
    await page.keyboard.press("End");

    // Type slowly and land several agent edits in the middle of it.
    const typed = " the user keeps typing while the agent works";
    const typing = page.keyboard.type(typed, { delay: 35 });
    await page.waitForTimeout(250);
    await mcp.ok("edit_document", { document_id: id, old_string: "Intro paragraph that Claude will rewrite.", new_string: "Intro paragraph, rewritten by Claude." });
    await mcp.ok("insert_content", { document_id: id, content: "Agent footer.", position: "end" });
    await mcp.ok("format_text", { document_id: id, text: "Intro", bold: true });
    await typing;
    await waitUntilSaved(page);

    const expectedParagraphs = ["Intro paragraph, rewritten by Claude.", `User paragraph:${typed}`, "Agent footer."];
    await expect.poll(() => readableParagraphs(page)).toEqual(expectedParagraphs);
    await expect
      .poll(() => mcp.markdown(id))
      .toBe(`**Intro** paragraph, rewritten by Claude.\n\nUser paragraph:${typed}\n\nAgent footer.`);
    await expect(page.locator(".doc-content .review-insert").first()).toBeVisible();

    // The server's copy is what the browser shows, highlights included.
    await page.reload();
    await expect(page.locator(".doc-content")).toBeVisible();
    await expect.poll(() => readableParagraphs(page)).toEqual(expectedParagraphs);
    await expect(page.locator(".doc-content strong")).toHaveText("Intro");
    await expect(page.locator(".review-bar")).toBeVisible();

    // Keep everything and type again after reload: still in sync.
    await mcp.ok("keep_changes", { document_id: id, all: true });
    await expect(page.locator(".review-bar")).toHaveCount(0);
    await page.locator(".doc-content p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Done.");
    await waitUntilSaved(page);
    await expect.poll(() => mcp.markdown(id)).toBe(`**Intro** paragraph, rewritten by Claude.\n\nUser paragraph:${typed}\n\nAgent footer. Done.`);
  });

  test("typing survives a burst of agent edits that keep beating it to the server", async ({ page, request }) => {
    // Regression: a 409 whose catch-up steps had already arrived left the typing unsaved forever.
    const { id } = await newDocumentInEditor(page, request, { title: "Burst", markdown: "Agent lines go above.\n\nUser line:" });
    await page.locator(".doc-content p").last().click();
    await page.keyboard.press("End");
    const typed = " every key must reach the server";
    let typingDone = false;
    const typing = page.keyboard.type(typed, { delay: 10 }).then(() => (typingDone = true));
    let edits = 0;
    while (!typingDone) {
      await mcp.ok("insert_content", { document_id: id, content: `Agent line ${edits}.`, position: "start" });
      edits += 1;
    }
    await typing;
    await waitUntilSaved(page);
    await expect.poll(() => mcp.markdown(id)).toContain(`User line:${typed}`);
    await page.reload();
    await expect(page.locator(".doc-content p").last()).toHaveText(`User line:${typed}`);
  });

  test("two browser tabs and an MCP client converge on the same document", async ({ page, request, context }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Two tabs", markdown: "Shared line." });
    const other = await context.newPage();
    await openInEditor(other, id);

    await mcp.ok("edit_document", { document_id: id, old_string: "Shared line.", new_string: "Shared line, edited by the agent." });
    for (const tab of [page, other]) await expect(tab.locator(".doc-content .review-insert")).toContainText("edited by the agent");

    // Keeping in one tab clears the review in the other.
    await revealControls(other, "edited by the agent");
    await other.locator(".review-controls .review-keep").click();
    await expect(page.locator(".doc-content .review-insert")).toHaveCount(0);
    await expect(page.locator(".doc-content p")).toHaveText(["Shared line, edited by the agent."]);
    await other.close();
  });
});

// ---------------------------------------------------------------------------
// Errors

test.describe("error surface", () => {
  test("a bad old_string is a helpful tool error and nothing changes in the browser", async ({ page, request }) => {
    const { id } = await newDocumentInEditor(page, request, { title: "Errors", markdown: "The report is due Friday.\n\nThe report is long." });
    const before = await mcp.markdown(id);

    const missing = await mcp.call("edit_document", { document_id: id, old_string: "The report is due Monday.", new_string: "x" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("String to replace not found in the document");
    expect(missing.text).toContain("read_document");

    const ambiguous = await mcp.call("edit_document", { document_id: id, old_string: "The report is", new_string: "This report is" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("Found 2 matches of old_string (lines 1, 3)");

    const same = await mcp.call("edit_document", { document_id: id, old_string: "long", new_string: "long" });
    expect(same.isError).toBe(true);
    expect(same.text).toContain("No changes to make");

    // multi_edit is atomic: one bad edit means none apply.
    const partial = await mcp.call("multi_edit_document", {
      document_id: id,
      edits: [
        { old_string: "due Friday", new_string: "due Thursday" },
        { old_string: "does not exist", new_string: "x" },
      ],
    });
    expect(partial.isError).toBe(true);
    expect(partial.text).toContain("Edit 2 of 2 failed, so no edits were applied");

    const wrongDoc = await mcp.call("read_document", { document_id: "missing-document" });
    expect(wrongDoc.isError).toBe(true);
    expect(wrongDoc.text).toContain('Document "missing-document" was not found');

    const badArgs = await mcp.call("edit_document", { document_id: id, old_string: 42 });
    expect(badArgs.isError).toBe(true);
    expect(badArgs.text).toMatch(/old_string|new_string/);

    // Nothing reached the browser or the server.
    await page.waitForTimeout(500);
    expect(await readableParagraphs(page)).toEqual(["The report is due Friday.", "The report is long."]);
    await expect(page.locator(".doc-content .review-insert")).toHaveCount(0);
    await expect(page.locator(".review-bar")).toHaveCount(0);
    expect(await mcp.markdown(id)).toBe(before);
    expect(await mcp.ok("get_pending_changes", { document_id: id })).toBe("No pending changes.");
  });

  test("unknown tools are rejected by the protocol", async ({ baseURL }) => {
    await withClient(baseURL!, async (client) => {
      const result = await client.callTool({ name: "delete_everything", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/delete_everything not found/);
    });
  });
});

// ---------------------------------------------------------------------------
// A whole agent session, the way Claude Code would work

test("comprehensive: an agent reviews, edits and annotates a document while the user watches", async ({ page, request }) => {
  const { id } = await newDocumentInEditor(page, request, {
    title: "Field report",
    markdown: "# Field report\n\nWe visited three sites. The water levels was high at the first site.\n\n## Findings\n\n- Site A flooded\n- Site B dry\n\n## Next steps\n\nTBD",
  });
  await page.getByRole("button", { name: "Comments", exact: true }).click();

  // Orient.
  const outline = await mcp.ok("get_outline", { document_id: id });
  expect(outline).toMatch(/ 1\t# Field report — 13 words\n\s+5\t\s*## Findings — 6 words\n\s+10\t\s*## Next steps — 1 words/);
  const analysis = await mcp.ok("analyze_writing", { document_id: id });
  expect(analysis).toContain('Writing analysis of "Field report"');
  const hits = await mcp.ok("search_document", { document_id: id, pattern: "Site [AB]", regex: true });
  expect(hits).toContain("2 matching lines");

  // Fix grammar, fill in the plan, and flag something for the user.
  await mcp.ok("multi_edit_document", {
    document_id: id,
    edits: [
      { old_string: "water levels was high", new_string: "water levels were high" },
      { old_string: "TBD", new_string: "1. Install pumps at Site A\n2. Re-survey Site B in spring" },
    ],
  });
  await mcp.ok("format_text", { document_id: id, text: "Site A flooded", color: "#c5221f" });
  await mcp.ok("add_comment", { document_id: id, text: "three sites", comment: "Only two sites are listed in Findings." });

  const doc = page.locator(".doc-content");
  await expect(doc.locator(".review-insert", { hasText: "were" })).toBeVisible();
  await expect(doc.locator("ol > li")).toHaveText(["Install pumps at Site A", "Re-survey Site B in spring"]);
  await expect(doc.locator('span[style*="color"]', { hasText: "Site A flooded" })).toHaveCSS("color", "rgb(197, 34, 31)");
  await expect(page.locator(".comment-card", { hasText: "Only two sites" })).toBeVisible();

  const context = await mcp.ok("get_editor_context", { document_id: id });
  expect(context).toContain("1 open comment");
  expect(context).toMatch(/\d+ changes? by Claude awaiting review/);

  // The user keeps everything from the review bar.
  await page.locator(".review-bar .btn-primary", { hasText: "Keep all" }).click();
  await expect(page.locator(".review-bar")).toHaveCount(0);
  await expect.poll(() => mcp.ok("get_pending_changes", { document_id: id })).toBe("No pending changes.");

  const final = await mcp.markdown(id);
  expect(final).toContain("The water levels were high at the first site.");
  expect(final).toContain("1. Install pumps at Site A\n2. Re-survey Site B in spring");
  expect(final).not.toContain("TBD");

  await page.reload();
  await expect(page.locator(".doc-content ol > li")).toHaveCount(2);
  await expect(page.locator(".doc-content [data-comment-id]")).toHaveText("three sites");
});
