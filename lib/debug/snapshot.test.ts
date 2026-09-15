import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countHtmlClasses, formatInlineDebugSnapshot, redactEmbeddedData } from "./snapshot";
import type { AgentChat } from "@/lib/agent/types";

describe("debug snapshot", () => {
  it("redacts embedded images without dropping the rest of the html", () => {
    const html = `<div class="indent-first">Hello</div><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA">`;
    const redacted = redactEmbeddedData(html);
    assert.match(redacted, /indent-first/);
    assert.match(redacted, /\[redacted \d+ chars\]/);
    assert.equal(redacted.includes("iVBORw0KGgo"), false);
  });

  it("counts block classes and keeps chat tools, errors, and thinking", () => {
    const chat: AgentChat = {
      id: "chat-1",
      title: "MLA essay",
      titled: true,
      createdAt: 1,
      updatedAt: 2,
      mode: "agent",
      model: "gpt-5.4-nano",
      thinkingLevel: "medium",
      tasks: [],
      turns: [
        {
          id: "turn-1",
          prompt: "Write an mla8 persuasive essay",
          selection: null,
          message: "Drafted the essay.",
          thinking: "I should search, then apply_paper_style.",
          durationMs: 12000,
          mock: false,
          mode: "agent",
          model: "gpt-5.4-nano",
          error: "The model hit a rate limit (tokens per minute).",
          tools: [{ name: "web_search" }, { name: "insert_text" }],
          timeline: [
            { id: "t1", kind: "thinking", text: "plan" },
            { id: "s1", kind: "step", step: { id: "s1", title: "Web search", status: "complete" } },
          ],
          edits: [
            { id: "e1", find: "", replace: "Student Name\nInstructor", operation: "insert", status: "pending" },
          ],
        },
      ],
    };
    const text = formatInlineDebugSnapshot({
      capturedAt: "2026-09-14T23:16:00-04:00",
      url: "http://localhost:3000/?doc=abc",
      documentId: "abc",
      title: "Untitled document",
      pages: 3,
      words: 900,
      chars: 5200,
      chrome: {
        fontFamily: "Times New Roman, serif",
        fontSize: "12pt",
        lineSpacing: "2",
        columns: 1,
        pageLayout: {
          paperSize: "letter",
          width: 816,
          height: 1056,
          marginTop: 96,
          marginRight: 96,
          marginBottom: 96,
          marginLeft: 96,
        },
        header: { show: true, text: "Lopez", align: "right", firstPageText: "" },
        footer: { show: false, text: "", align: "center", firstPageText: "" },
        pageNumbers: { show: true, location: "header" },
        differentFirstPage: false,
      },
      comments: [],
      text: "Student Name\nInstructor Name",
      html: `<div class="indent-first">Hello</div><div class="indent-hanging">UNESCO.</div>`,
      chats: [chat],
      activeChatId: "chat-1",
      composerDraft: "",
      attachments: [],
    });
    assert.match(text, /INLINE_DEBUG_SNAPSHOT v1/);
    assert.match(text, /indent-first×1/);
    assert.match(text, /web_search/);
    assert.match(text, /rate limit/);
    assert.match(text, /thinking → Web search/);
    assert.match(text, /apply_paper_style/);
    assert.deepEqual(countHtmlClasses(`<div class="indent-first">A</div><div class="indent-first">B</div>`), {
      "indent-first": 2,
    });
  });
});
