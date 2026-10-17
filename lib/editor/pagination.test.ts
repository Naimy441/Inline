import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preferredBreak } from "./pagination";

describe("line breaks", () => {
  it("splits where the line overflows when widow control is off", () => {
    assert.equal(preferredBreak(3, 6, true, false, false), 3);
  });

  it("keeps a paragraph together when a split would leave one line", () => {
    assert.equal(preferredBreak(1, 4, true, true, false), 0);
    assert.equal(preferredBreak(3, 4, true, true, false), 0);
  });

  it("moves the last two lines when the paragraph is taller than a page", () => {
    assert.equal(preferredBreak(5, 6, false, true, false), 4);
  });

  it("keeps every line of a paragraph that fits on the next page", () => {
    assert.equal(preferredBreak(2, 4, true, false, true), 0);
  });

  it("leaves a split that already has two lines on each side", () => {
    assert.equal(preferredBreak(2, 6, true, true, false), 2);
  });
});
