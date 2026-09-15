import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateAgentTokens, estimateContextUsage, modelContextLimit } from "./context";

describe("context estimate", () => {
  it("does not bill the full long document when not inlined", () => {
    const longDoc = estimateAgentTokens({
      prompt: "Hi",
      documentChars: 80_000,
      history: [],
      continuing: false,
    });
    const shortDoc = estimateAgentTokens({
      prompt: "Hi",
      documentChars: 100,
      history: [],
      continuing: false,
    });
    assert.ok(longDoc < 80_000 / 4);
    assert.ok(shortDoc < longDoc);
  });

  it("skips history tokens when continuing a request", () => {
    const history = [{ role: "user" as const, content: "x".repeat(4_000) }, { role: "assistant" as const, content: "y".repeat(4_000) }];
    const fresh = estimateAgentTokens({ prompt: "Hi", documentChars: 100, history, continuing: false });
    const continued = estimateAgentTokens({ prompt: "Hi", documentChars: 100, history, continuing: true, sameDraft: true });
    assert.ok(continued < fresh);
  });

  it("grows the conversation bucket as the live turn streams", () => {
    const base = estimateContextUsage({
      model: "gpt-5.4",
      prompt: "Revise this",
      documentChars: 400,
      history: [{ role: "user", content: "hello" }, { role: "assistant", content: "ok" }],
    });
    const live = estimateContextUsage({
      model: "gpt-5.4",
      prompt: "Revise this",
      documentChars: 400,
      history: [{ role: "user", content: "hello" }, { role: "assistant", content: "ok" }],
      liveThinking: "a".repeat(800),
      liveMessage: "b".repeat(400),
    });
    const conversation = (row: typeof base) => row.buckets.find((bucket) => bucket.id === "conversation")?.tokens ?? 0;
    assert.ok(conversation(live) > conversation(base));
    assert.equal(modelContextLimit("gpt-5.4"), 256_000);
  });

  it("does not treat a long draft as fully in context", () => {
    const usage = estimateContextUsage({
      model: "gpt-5.4",
      prompt: "Hi",
      documentChars: 80_000,
      history: [],
    });
    const document = usage.buckets.find((bucket) => bucket.id === "document");
    assert.equal(document?.label, "Document outline");
    assert.ok((document?.tokens ?? 0) < 80_000 / 4);
    assert.ok((document?.tokens ?? 0) <= 2_400 / 4);
  });

  it("does not recount chat history when the thread already has it", () => {
    const history = [
      { role: "user" as const, content: "x".repeat(4_000) },
      { role: "assistant" as const, content: "y".repeat(4_000) },
    ];
    const fresh = estimateContextUsage({ model: "gpt-5.4", prompt: "Hi", documentChars: 100, history });
    const continued = estimateContextUsage({
      model: "gpt-5.4",
      prompt: "Hi",
      documentChars: 100,
      history,
      continuing: true,
      sameDraft: true,
    });
    const conversation = (row: typeof fresh) => row.buckets.find((bucket) => bucket.id === "conversation")?.tokens ?? 0;
    const document = (row: typeof fresh) => row.buckets.find((bucket) => bucket.id === "document");
    assert.ok(conversation(continued) < conversation(fresh));
    assert.equal(document(continued)?.label, "Document (in thread)");
    assert.ok((document(continued)?.tokens ?? 0) < (document(fresh)?.tokens ?? 0));
  });

  it("snaps conversation size to provider usage when it arrives", () => {
    const estimated = estimateContextUsage({
      model: "gpt-5.4",
      prompt: "Hi",
      documentChars: 80,
      history: [],
    });
    const live = estimateContextUsage({
      model: "gpt-5.4",
      prompt: "Hi",
      documentChars: 80,
      history: [],
      usage: { input: 12_000, output: 800 },
    });
    assert.equal(live.source, "usage");
    assert.ok(live.used > estimated.used);
    assert.ok(live.used >= 12_800 - 50);
  });
});
