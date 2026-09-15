import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { documentFingerprint } from "../continuation";
import { requestAllowsEdits, stepTitle, systemPrompt, userPrompt } from "./prompt";
import { DocumentSession } from "./session";
import type { AgentRequest } from "../types";

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    title: "Essay",
    prompt: "Tighten the opening.",
    document: "The river was wide.\n\nThen it rained.",
    selection: null,
    mode: "agent",
    model: "gpt-5.4-nano",
    thinkingLevel: "medium",
    nameChat: false,
    history: [],
    ...overrides,
  };
}

describe("prompt contract", () => {
  it("blocks writes in plan/ask and when the user forbids editing", () => {
    assert.equal(requestAllowsEdits(request({ mode: "agent" })), true);
    assert.equal(requestAllowsEdits(request({ mode: "plan" })), false);
    assert.equal(requestAllowsEdits(request({ mode: "ask" })), false);
    assert.equal(requestAllowsEdits(request({ prompt: "Do not edit the draft. Summarize it." })), false);
  });

  it("tells the agent to use formatting tools and tidy deletes", () => {
    const text = systemPrompt(request({ mode: "agent" }));
    assert.match(text, /highlight_text/);
    assert.match(text, /add_footer/);
    assert.match(text, /insert_table/);
    assert.match(text, /blank pages/);
    assert.match(text, /web_search/);
    assert.match(text, /web_fetch/);
    assert.match(text, /apply_paper_style/);
    assert.match(text, /set_paragraph_indent/);
    assert.doesNotMatch(text, /mla-indent|mla-title|mla-hanging|mla-works/);
    assert.doesNotMatch(systemPrompt(request({ mode: "ask" })), /highlight_text/);
    assert.match(systemPrompt(request({ mode: "ask" })), /web_search/);
    assert.match(systemPrompt(request({ prompt: "Write an MLA8 persuasive essay." })), /apply_paper_style/);
    assert.match(systemPrompt(request({ prompt: "Write an MLA8 persuasive essay." })), /before the first insert_text/);
    assert.match(systemPrompt(request({ prompt: "Write an MLA8 persuasive essay." })), /set_alignment/);
    assert.match(systemPrompt(request({ prompt: "Write an MLA8 persuasive essay." })), /set_paragraph_indent/);
    assert.match(systemPrompt(request({ prompt: "Write an MLA8 persuasive essay with a BME." })), /beginning, middle, and end/);
    assert.match(systemPrompt(request({ mode: "agent" })), /same P1, P2 ids/);
    assert.match(systemPrompt(request({ mode: "agent" })), /hard-wrap body paragraphs/);
    assert.match(systemPrompt(request({ prompt: "Write an MLA8 persuasive essay." })), /HTML landing page/);
    assert.match(systemPrompt(request({ mode: "agent" })), /following true/);
    assert.match(systemPrompt(request({ mode: "agent" })), /kind first-line and no find/);
    assert.match(systemPrompt(request({ mode: "agent" })), /Never insert tab characters/);
    assert.match(systemPrompt(request({ mode: "agent" })), /plain sentences/);
    assert.match(systemPrompt(request({ mode: "agent" })), /cells grid/);
    assert.doesNotMatch(systemPrompt(request({ mode: "agent" })), /\*\*/);
  });

  it("names read_document steps after the document title", () => {
    assert.equal(stepTitle("read_document", { scope: "document" }, "Research"), "Reading Research");
    assert.equal(stepTitle("read_document", { page: 2 }, "Research"), "Reading Research · page 2");
    assert.doesNotMatch(stepTitle("read_document", {}, "Research"), /the document/i);
  });

  it("includes prior edits and skip-repeat instructions", () => {
    const session = new DocumentSession({ title: "Essay", text: "The river was wide." });
    const text = userPrompt(
      request({
        previousEdits: [{ find: "wide", replace: "broad", status: "accepted", operation: "replace" }],
        recentTools: ["replace_text"],
        history: [{ role: "user", content: "before" }, { role: "assistant", content: "ok" }],
        continuation: { provider: "openai", model: "gpt-5.4-nano", mode: "agent", openaiResponseId: "resp_1" },
      }),
      session,
    );
    assert.match(text, /Edits already on the page/);
    assert.match(text, /accepted replace/);
    assert.match(text, /Tools used last turn: replace_text/);
    assert.match(text, /follow-up/i);
  });

  it("does not re-inline an unchanged short draft on follow-up", () => {
    const session = new DocumentSession({ title: "Essay", text: "Short draft." });
    const text = userPrompt(
      request({
        document: "Short draft.",
        history: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }],
        continuation: {
          provider: "openai",
          model: "gpt-5.4-nano",
          mode: "agent",
          openaiResponseId: "resp_1",
          documentFingerprint: documentFingerprint("Short draft."),
        },
      }),
      session,
    );
    assert.match(text, /unchanged since your last turn/);
    assert.doesNotMatch(text, /<<<DOCUMENT>>>/);
  });
});
