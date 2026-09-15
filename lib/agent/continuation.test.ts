import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  continuationFits,
  documentFingerprint,
  forgetThread,
  parseChatId,
  parseContinuation,
  recallThread,
  rememberThread,
} from "./continuation";

describe("continuation", () => {
  it("fingerprints the same draft stably", () => {
    const a = documentFingerprint("Hello  world");
    const b = documentFingerprint("Hello  world");
    assert.equal(a, b);
    assert.notEqual(a, documentFingerprint("Hello world"));
  });

  it("only continues when provider, model, and mode match", () => {
    const stored = { provider: "openai" as const, model: "gpt-5.4-nano", mode: "agent" as const };
    assert.equal(continuationFits(stored, { model: "gpt-5.4-nano", mode: "agent" }, "openai"), true);
    assert.equal(continuationFits(stored, { model: "gpt-5.4-nano", mode: "ask" }, "openai"), false);
    assert.equal(continuationFits(stored, { model: "gpt-5.4", mode: "agent" }, "openai"), false);
    assert.equal(continuationFits(stored, { model: "gpt-5.4-nano", mode: "agent" }, "anthropic"), false);
  });

  it("parses continuation payloads and rejects junk", () => {
    assert.equal(parseContinuation(null), undefined);
    const parsed = parseContinuation({
      provider: "openai",
      model: "gpt-5.4-nano",
      mode: "agent",
      openaiResponseId: "resp_123",
      documentFingerprint: "12:abcd",
    });
    assert.equal(parsed?.openaiResponseId, "resp_123");
    assert.equal(parseChatId("chat-1"), "chat-1");
    assert.equal(parseChatId("bad id"), undefined);
  });

  it("stores threads with TTL bookkeeping", () => {
    rememberThread({
      chatId: "c1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      mode: "agent",
      anthropicMessages: [{ role: "user", content: "hi" }],
      updatedAt: Date.now(),
    });
    assert.equal(recallThread("c1")?.provider, "anthropic");
    forgetThread("c1");
    assert.equal(recallThread("c1"), undefined);
  });
});
