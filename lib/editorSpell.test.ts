import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { createEditor, destroyEditor, installDom } from "./agent/eval/harness";
import { ignoreSpellingRange, muteSpellcheck, spellingTargetAtPoint } from "./editorSpell";

before(() => {
  installDom();
});

describe("editor spelling", () => {
  it("wraps a word so native spellcheck can ignore it", () => {
    const editor = createEditor("<div>Instructor Name wrote this.</div>");
    const text = editor.querySelector("div")?.firstChild;
    assert.ok(text);
    const range = document.createRange();
    range.setStart(text, 0);
    range.collapse(true);
    const proto = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    proto.caretRangeFromPoint = () => range;
    const target = spellingTargetAtPoint(editor, 0, 0);
    assert.equal(target?.hit.word, "Instructor");
    assert.equal(target?.hit.ignored, false);
    assert.equal(ignoreSpellingRange(editor, target!.range), true);
    const mark = editor.querySelector("[data-spell-ignore]");
    assert.ok(mark);
    assert.equal(mark?.spellcheck, false);
    assert.equal(mark?.textContent, "Instructor");
    destroyEditor(editor);
  });

  it("does not wrap words inside a pending suggestion", () => {
    const editor = createEditor(
      `<div><span class="agent-edit" spellcheck="false"><span class="suggestion-del">Instructor Name</span><span class="suggestion-add">Instructor Name</span></span></div>`,
    );
    const text = editor.querySelector(".suggestion-add")?.firstChild;
    assert.ok(text);
    const range = document.createRange();
    range.setStart(text, 0);
    range.collapse(true);
    const proto = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    proto.caretRangeFromPoint = () => range;
    const target = spellingTargetAtPoint(editor, 0, 0);
    assert.equal(target?.hit.inSuggestion, true);
    assert.equal(ignoreSpellingRange(editor, target!.range), false);
    assert.equal(editor.querySelector("[data-spell-ignore]"), null);
    destroyEditor(editor);
  });

  it("marks suggestion chrome as not spellchecked", () => {
    const wrap = document.createElement("span");
    wrap.className = "agent-edit";
    muteSpellcheck(wrap);
    assert.equal(wrap.spellcheck, false);
  });
});
