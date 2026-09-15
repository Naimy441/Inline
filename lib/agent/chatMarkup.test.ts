import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChatMarkup } from "./chatMarkup";

describe("chat markup", () => {
  it("renders bold and italic instead of leaving asterisks", () => {
    assert.deepEqual(parseChatMarkup("Hello **world** and *now*."), [
      { type: "text", value: "Hello " },
      { type: "strong", value: "world" },
      { type: "text", value: " and " },
      { type: "em", value: "now" },
      { type: "text", value: "." },
    ]);
  });

  it("renders inline code and strips leftover asterisks", () => {
    assert.deepEqual(parseChatMarkup("Call `insert_table` next **"), [
      { type: "text", value: "Call " },
      { type: "code", value: "insert_table" },
      { type: "text", value: " next " },
    ]);
  });

  it("leaves plain speech alone", () => {
    assert.deepEqual(parseChatMarkup("I inserted the table before the page break."), [
      { type: "text", value: "I inserted the table before the page break." },
    ]);
  });
});
