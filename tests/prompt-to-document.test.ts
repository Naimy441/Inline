import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";

import type { ChatRuntime } from "@/lib/agent/runtime";
import type { AssistantMessage, ToolPart } from "@/lib/agent/types";
import type { LiveDocument } from "@/lib/server/hub";

import { BrowserClient } from "./support/browser-client";
import { FakeClaude, type FakeTurn } from "./support/fake-claude";
import { useTempDataDir } from "./support/mcp";

/**
 * The core product flow, end to end: the user types a prompt in the agent
 * panel, Claude works through Inline's MCP tools, and the writing appears
 * live in the user's open editor as changes they can keep or undo.
 *
 * Claude is scripted (see support/fake-claude.ts), but like the real model
 * each script reads the document first and builds its edits from what the
 * tools returned. Everything else is real: the chat API, the runtime, the
 * in-process MCP server, the tools, the hub, the review API and a headless
 * collaborative editor standing in for the browser.
 */

useTempDataDir("inline-prompt-");
const claude = new FakeClaude();

let hub: ReturnType<typeof import("@/lib/server/hub").documentHub>;
let runtime: ReturnType<typeof import("@/lib/agent/runtime").agentRuntime>;
let messagesRoute: typeof import("@/app/api/agent/chats/[id]/messages/route");
let reviewRoute: typeof import("@/app/api/documents/[id]/review/route");
let toMarkdown: (doc: LiveDocument) => string;

before(async () => {
  const real = await import("@anthropic-ai/claude-agent-sdk");
  mock.module("@anthropic-ai/claude-agent-sdk", { namedExports: { ...real, query: claude.query } });
  hub = (await import("@/lib/server/hub")).documentHub();
  runtime = (await import("@/lib/agent/runtime")).agentRuntime();
  messagesRoute = await import("@/app/api/agent/chats/[id]/messages/route");
  reviewRoute = await import("@/app/api/documents/[id]/review/route");
  const { docToMarkdown } = await import("@/lib/doc/markdown");
  toMarkdown = (doc) => docToMarkdown(doc.doc);
});

after(() => {
  for (const chat of (runtime as unknown as { chats: Map<string, ChatRuntime> }).chats.values()) chat.close();
});

/** Open a document in the "browser" with an agent chat attached, like the editor page does. */
async function workspace(markdown: string, settings = {}) {
  const doc = await hub.create({ title: "Draft", markdown });
  hub.activeDocumentId = doc.id;
  const browser = new BrowserClient(doc);
  const chat = await runtime.create({ documentId: doc.id, settings });
  return { doc, browser, chat };
}

/** Send a prompt from the agent panel (through the API route) and wait for Claude to finish. */
async function prompt(chat: ChatRuntime, text: string, extra: Record<string, unknown> = {}) {
  const response = await messagesRoute.POST(
    new Request(`http://localhost/api/agent/chats/${chat.state.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, ...extra }) }),
    { params: Promise.resolve({ id: chat.state.id }) },
  );
  assert.equal(response.status, 202, await response.clone().text());
  const start = Date.now();
  while (chat.state.running || (chat.state.messages.at(-1) as AssistantMessage).status === "streaming") {
    if (Date.now() - start > 10_000) throw new Error("turn did not finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return chat.state.messages.at(-1) as AssistantMessage;
}

/** Keep or undo from the editor's review controls (the same API the browser calls). */
async function review(doc: LiveDocument, action: "accept" | "reject", ids: string[] | "all") {
  const response = await reviewRoute.POST(
    new Request(`http://localhost/api/documents/${doc.id}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ids }) }),
    { params: Promise.resolve({ id: doc.id }) },
  );
  assert.equal(response.status, 200);
}

/** Lines of read_document output without the header or number prefixes. */
function lines(readResult: string) {
  return readResult
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/^\s*\d+\t/, ""));
}

function toolNames(message: AssistantMessage) {
  return message.parts.filter((part): part is ToolPart => part.type === "tool").map((part) => part.name.replace("mcp__inline__", ""));
}

describe("the user prompts and Claude writes", () => {
  test("\"Write me a cover letter\" in an empty document drafts it live, and keeping it makes it final", async () => {
    const { doc, browser, chat } = await workspace("");
    let seenMidTurn = "";
    claude.script(async (turn: FakeTurn) => {
      const read = await turn.tool("mcp__inline__read_document", {});
      assert.match(read.text, /The document is empty/);
      turn.say("I'll draft a cover letter.");
      await turn.tool("mcp__inline__write_document", {
        content: "# Cover letter {.title}\n\nDear hiring team,\n\nI am applying for the editor role. I have shipped three writing tools.\n\nSincerely,\n\nSam",
      });
      // The user watches it appear while Claude is still working.
      seenMidTurn = browser.markdown;
      await turn.tool("mcp__inline__update_document_settings", { title: "Cover letter", font_family: "Georgia" });
      turn.say("Drafted. Review the highlighted changes and keep what you like.");
    });
    const message = await prompt(chat, "Write me a short cover letter for an editor role. Sign it Sam.");

    assert.match(seenMidTurn, /Dear hiring team,/);
    assert.equal(message.status, "done");
    assert.deepEqual(toolNames(message), ["read_document", "write_document", "update_document_settings"]);
    assert.equal(browser.markdown, toMarkdown(doc));
    assert.match(toMarkdown(doc), /^# Cover letter \{\.title\}\n\nDear hiring team,/);
    assert.doesNotMatch(toMarkdown(doc), /&nbsp;/, "no stray empty paragraph");
    assert.equal(doc.meta.title, "Cover letter");
    assert.ok(doc.hunks.length > 0, "the draft is pending review");
    assert.deepEqual(message.changes?.map((change) => change.documentId), [doc.id]);
    assert.ok(message.changes![0]!.added >= 20);

    await review(doc, "accept", "all");
    assert.equal(doc.hunks.length, 0);
    assert.equal(browser.hunks.length, 0);
    assert.match(toMarkdown(doc), /Sincerely,\n\nSam$/);
  });

  test("\"Make this more concise\" with a selection rewrites only the selected paragraph", async () => {
    const { doc, browser, chat } = await workspace(
      "Intro stays.\n\nIn order to be able to make progress on this project, it is really very important that we all actually agree on the scope first.\n\nOutro stays.",
    );
    const from = browser.find("In order to");
    const selected = "In order to be able to make progress on this project, it is really very important that we all actually agree on the scope first.";
    browser.select(from, from + selected.length);
    let contextBlock = "";
    claude.script(async (turn) => {
      contextBlock = turn.texts[0]!;
      const context = await turn.tool("mcp__inline__get_editor_context", {});
      const quoted = context.text.match(/"""\n([\s\S]*?)\n"""/)![1]!;
      await turn.tool("mcp__inline__edit_document", { old_string: quoted, new_string: "To make progress, we must first agree on the scope." });
      turn.say("Tightened the selected sentence.");
    });
    const message = await prompt(chat, "Make this more concise", { selection: { documentId: doc.id, text: selected, from, to: from + selected.length } });

    assert.match(contextBlock, /The user selected this text/);
    assert.equal(message.status, "done");
    assert.equal(toMarkdown(doc), "Intro stays.\n\nTo make progress, we must first agree on the scope.\n\nOutro stays.");
    assert.equal(browser.markdown, toMarkdown(doc));

    // Undo from the editor restores the user's original wording exactly.
    await review(doc, "reject", "all");
    assert.equal(toMarkdown(doc), `Intro stays.\n\n${selected}\n\nOutro stays.`);
  });

  test("\"Fix the typos\" makes several precise edits; the user keeps some and undoes one", async () => {
    const { doc, chat } = await workspace("Teh report is due on Fridya.\n\nPlease send feedbak to the team.");
    claude.script(async (turn) => {
      const read = await turn.tool("mcp__inline__read_document", {});
      const fixes: Array<[string, string]> = [
        ["Teh", "The"],
        ["Fridya", "Friday"],
        ["feedbak", "feedback"],
      ];
      const text = lines(read.text).join("\n");
      await turn.tool("mcp__inline__multi_edit_document", {
        edits: fixes.filter(([wrong]) => text.includes(wrong)).map(([wrong, right]) => ({ old_string: wrong, new_string: right })),
      });
      turn.say("Fixed three typos.");
    });
    await prompt(chat, "Fix the typos");
    assert.equal(toMarkdown(doc), "The report is due on Friday.\n\nPlease send feedback to the team.");
    const hunks = doc.hunksJSON();
    assert.equal(hunks.length, 3, JSON.stringify(hunks.map((hunk) => [hunk.deletedText, hunk.insertedText])));

    const friday = hunks.find((hunk) => hunk.insertedText === "Friday")!;
    await review(doc, "reject", [friday.id]);
    await review(doc, "accept", "all");
    assert.equal(toMarkdown(doc), "The report is due on Fridya.\n\nPlease send feedback to the team.");
  });

  test("\"Address the comments\" edits the text and replies to each comment", async () => {
    const { doc, browser, chat } = await workspace("Sales went up a lot.\n\nWe hired some people.");
    for (const [text, body] of [
      ["a lot", "How much?"],
      ["some people", "How many?"],
    ] as const) {
      const from = browser.find(text);
      doc.addComment({ from, to: from + text.length, body, author: "user" }, { kind: "client", clientID: browser.clientID });
    }
    claude.script(async (turn) => {
      const list = await turn.tool("mcp__inline__list_comments", {});
      const comments = [...list.text.matchAll(/\[(\S+)\] User on "([^"]+)": (.+)/g)].map((match) => ({ id: match[1]!, anchor: match[2]!, body: match[3]! }));
      const answers: Record<string, string> = { "a lot": "by 24%", "some people": "nine engineers" };
      for (const comment of comments) {
        await turn.tool("mcp__inline__edit_document", { old_string: comment.anchor, new_string: answers[comment.anchor]! });
        await turn.tool("mcp__inline__reply_to_comment", { comment_id: comment.id, reply: `Changed to "${answers[comment.anchor]}".`, resolve: true });
      }
      turn.say("Both comments are addressed.");
    });
    const message = await prompt(chat, "Address the comments");
    assert.deepEqual(toolNames(message), ["list_comments", "edit_document", "reply_to_comment", "edit_document", "reply_to_comment"]);
    assert.equal(toMarkdown(doc), "Sales went up by 24%.\n\nWe hired nine engineers.");
    assert.ok(doc.comments.every((comment) => comment.resolved && comment.replies[0]?.author === "claude"));
  });

  test("a follow-up prompt builds on the previous turn's writing", async () => {
    const { doc, chat } = await workspace("");
    claude.script(
      async (turn) => {
        await turn.tool("mcp__inline__write_document", { content: "## Agenda\n\n- Budget\n- Hiring" });
      },
      async (turn) => {
        const read = await turn.tool("mcp__inline__read_document", {});
        const last = lines(read.text).filter((line) => line.startsWith("- ")).at(-1)!;
        await turn.tool("mcp__inline__edit_document", { old_string: last, new_string: `${last}\n- Roadmap` });
      },
    );
    await prompt(chat, "Start an agenda with budget and hiring");
    await prompt(chat, "Add roadmap to it");
    assert.equal(toMarkdown(doc), "## Agenda\n\n- Budget\n- Hiring\n- Roadmap");
    assert.equal(chat.state.messages.length, 4);
    assert.equal(claude.lastCall.inputs.length, 2, "both prompts went to the same Claude Code session");
    // Undo restores the empty document: the second edit merged into the first pending change.
    await review(doc, "reject", "all");
    assert.equal(toMarkdown(doc), "&nbsp;");
  });

  test("the user keeps typing while Claude writes, and neither loses words", async () => {
    const { doc, browser, chat } = await workspace("Notes from Monday.\n\nAction items follow.");
    claude.script(async (turn) => {
      await turn.tool("mcp__inline__read_document", {});
      // The user types in the first paragraph while Claude is mid-turn.
      browser.pause();
      browser.type(browser.state.doc.firstChild!.nodeSize - 1, " Attendees: Ana, Bo.");
      await turn.tool("mcp__inline__insert_content", { content: "1. Ship the beta\n2. Hire a designer", position: "end" });
      browser.flush();
      turn.say("Added the action items.");
    });
    await prompt(chat, "Add the action items: ship the beta, hire a designer");
    assert.equal(toMarkdown(doc), "Notes from Monday. Attendees: Ana, Bo.\n\nAction items follow.\n\n1. Ship the beta\n2. Hire a designer");
    assert.equal(browser.markdown, toMarkdown(doc));
    await review(doc, "reject", "all");
    assert.equal(toMarkdown(doc), "Notes from Monday. Attendees: Ana, Bo.\n\nAction items follow.", "undoing Claude keeps the user's typing");
  });

  test("in Ask mode a prompt to write gets an answer, not an edit", async () => {
    const { doc, chat } = await workspace("Budget: 40000.", { mode: "ask" });
    claude.script(async (turn) => {
      const attempt = await turn.tool("mcp__inline__edit_document", { old_string: "40000", new_string: "45000" });
      assert.equal(attempt.isError, true);
      turn.say("I'm in Ask mode, so I can't edit. Switch to Agent mode and I'll change it to 45000.");
    });
    const message = await prompt(chat, "Change the budget to 45000");
    assert.equal(toMarkdown(doc), "Budget: 40000.");
    assert.equal(doc.hunks.length, 0);
    assert.equal(message.changes, undefined);
  });

  test("a prompt that creates a new document opens it in the editor", async () => {
    const { doc, chat } = await workspace("Meeting notes.");
    const commands: unknown[] = [];
    doc.subscribe((event) => event.type === "command" && commands.push(event.command));
    let createdId = "";
    claude.script(async (turn) => {
      const created = await turn.tool("mcp__inline__create_document", { title: "Follow-up email", content: "Hi team,\n\nThanks for today." });
      createdId = created.text.match(/\(id (\S+)\)/)![1]!;
    });
    const message = await prompt(chat, "Draft a follow-up email in a new document");
    assert.deepEqual(commands, [{ kind: "open_document", documentId: createdId }]);
    const created = await hub.require(createdId);
    assert.equal(toMarkdown(created), "Hi team,\n\nThanks for today.");
    assert.deepEqual(message.changes?.map((change) => change.tool), ["create_document"]);
  });
});
