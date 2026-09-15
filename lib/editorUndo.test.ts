import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUndoStack } from "./editorUndo";

describe("createUndoStack", () => {
  it("undoes then redoes in order", () => {
    const stack = createUndoStack<string>();
    stack.push("a");
    stack.push("b");
    assert.equal(stack.undo("c"), "b");
    assert.equal(stack.undo("b"), "a");
    assert.equal(stack.undo("a"), undefined);
    assert.equal(stack.redo("a"), "b");
    assert.equal(stack.redo("b"), "c");
    assert.equal(stack.redo("c"), undefined);
  });

  it("clears redo after a new push", () => {
    const stack = createUndoStack<string>();
    stack.push("a");
    stack.undo("b");
    stack.push("a");
    assert.equal(stack.redo("a"), undefined);
    assert.equal(stack.undo("c"), "a");
  });
});
