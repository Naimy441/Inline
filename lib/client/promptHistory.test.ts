import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { promptTexts, recallPrompt } from "@/lib/client/promptHistory";

const history = ["one", "two", "three"];

describe("recallPrompt", () => {
  test("ArrowUp and ArrowDown in an empty draft load the previous prompt", () => {
    assert.deepEqual(recallPrompt(history, null, "ArrowUp", ""), { handled: true, text: "three", cursor: 2 });
    assert.deepEqual(recallPrompt(history, null, "ArrowDown", ""), { handled: true, text: "three", cursor: 2 });
  });

  test("a non-empty draft keeps its arrow keys", () => {
    assert.deepEqual(recallPrompt(history, null, "ArrowUp", "draft"), { handled: false });
    assert.deepEqual(recallPrompt(history, null, "ArrowDown", "line one\nline two"), { handled: false });
    assert.deepEqual(recallPrompt(history, 2, "ArrowUp", "three"), { handled: false });
    assert.deepEqual(recallPrompt(history, 2, "ArrowDown", " "), { handled: false });
  });

  test("clearing a recalled prompt walks older, then back toward empty", () => {
    assert.deepEqual(recallPrompt(history, 2, "ArrowUp", ""), { handled: true, text: "two", cursor: 1 });
    assert.deepEqual(recallPrompt(history, 1, "ArrowDown", ""), { handled: true, text: "three", cursor: 2 });
    assert.deepEqual(recallPrompt(history, 2, "ArrowDown", ""), { handled: true, text: "", cursor: null });
    assert.deepEqual(recallPrompt(history, 0, "ArrowUp", ""), { handled: true, text: "one", cursor: 0 });
  });

  test("an empty history does nothing", () => {
    assert.deepEqual(recallPrompt([], null, "ArrowUp", ""), { handled: false });
    assert.deepEqual(recallPrompt([], null, "ArrowDown", ""), { handled: false });
  });
});

describe("promptTexts", () => {
  test("keeps user prompts and queued follow-ups, oldest first", () => {
    assert.deepEqual(
      promptTexts(
        [
          { role: "user", text: "First" },
          { role: "assistant" },
          { role: "user", text: "Second" },
          { role: "user", text: "" },
        ],
        [{ text: "Queued" }],
      ),
      ["First", "Second", "Queued"],
    );
  });
});
