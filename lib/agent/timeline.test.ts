import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatThoughtLabel, pushThinking, sealOpenThinking, upsertStep } from "./timeline";

describe("agent timeline", () => {
  it("keeps thinking and tools in the order they arrived", () => {
    let items = pushThinking([], "First thought. ");
    items = upsertStep(items, { id: "s1", title: "Web search", status: "complete" });
    items = pushThinking(items, "First thought. Then more after the search.");
    items = upsertStep(items, { id: "s2", title: "Read page", status: "active" });
    assert.deepEqual(
      items.map((item) => (item.kind === "thinking" ? item.text : item.step.title)),
      ["First thought. ", "Web search", "Then more after the search.", "Read page"],
    );
  });

  it("updates a step in place instead of duplicating it", () => {
    let items = upsertStep([], { id: "s1", title: "Web search", status: "active" });
    items = upsertStep(items, { id: "s1", title: "Searched the web", status: "complete" });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "step");
    if (items[0]?.kind === "step") assert.equal(items[0].step.status, "complete");
  });

  it("seals thinking duration when a tool starts", () => {
    let items = pushThinking([], "Considering the title. ", 1_000);
    assert.equal(items[0]?.kind, "thinking");
    if (items[0]?.kind === "thinking") {
      assert.equal(items[0].startedAt, 1_000);
      assert.equal(items[0].durationSec, undefined);
    }
    items = upsertStep(items, { id: "s1", title: "set_alignment", status: "active" }, 7_400);
    assert.equal(items[0]?.kind, "thinking");
    if (items[0]?.kind === "thinking") {
      assert.equal(items[0].durationSec, 6);
    }
    assert.equal(items.at(-1)?.kind, "step");
  });

  it("does not reseal thinking that already has a duration", () => {
    const sealed = sealOpenThinking(
      [{ id: "thinking-0", kind: "thinking", text: "done", startedAt: 1_000, durationSec: 4 }],
      20_000,
    );
    assert.equal(sealed[0]?.kind, "thinking");
    if (sealed[0]?.kind === "thinking") assert.equal(sealed[0].durationSec, 4);
  });

  it("formats thought labels like Cursor", () => {
    assert.equal(formatThoughtLabel({ streaming: true }), "Thinking");
    assert.equal(formatThoughtLabel({ durationSec: 0 }), "Thought briefly");
    assert.equal(formatThoughtLabel({ durationSec: 1 }), "Thought briefly");
    assert.equal(formatThoughtLabel({}), "Thought briefly");
    assert.equal(formatThoughtLabel({ durationSec: 2 }), "Thought 2s");
    assert.equal(formatThoughtLabel({ durationSec: 14 }), "Thought 14s");
  });
});
