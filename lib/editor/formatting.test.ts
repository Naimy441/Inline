import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { ensureBlockIds } from "../doc/ids";
import { docToMarkdown, markdownToDoc } from "../doc/markdown";
import { schema } from "../doc/schema";
import {
  blockKind,
  clearFormatting,
  currentAlign,
  currentLineHeight,
  indent,
  insertHorizontalRule,
  insertPageBreak,
  insertTable,
  insertText,
  linkAt,
  listKind,
  markActive,
  normalizeHref,
  outdent,
  setAlign,
  setBlock,
  setLineHeight,
  setLink,
  setMark,
  toggle,
  toggleBlockquote,
  toggleList,
  toggleTask,
} from "./commands";

function stateFor(markdown: string, from = 1, to = from) {
  const doc = ensureBlockIds(markdownToDoc(markdown));
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

function select(state: EditorState, text: string) {
  let from = -1;
  state.doc.descendants((node, pos) => {
    if (from < 0 && node.isText && node.text!.includes(text)) from = pos + node.text!.indexOf(text);
    return from < 0;
  });
  assert.ok(from >= 0, `"${text}" found`);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + text.length)));
}

function run(state: EditorState, command: Command) {
  let next = state;
  const ok = command(state, (tr) => (next = state.apply(tr)));
  return { ok, state: next, md: docToMarkdown(next.doc).trim() };
}

describe("inline formatting", () => {
  it("toggles bold on and off", () => {
    const on = run(select(stateFor("Make this bold"), "bold"), toggle("bold"));
    assert.equal(on.md, "Make this **bold**");
    assert.equal(markActive(on.state, schema.marks.bold!), true);
    assert.equal(run(on.state, toggle("bold")).md, "Make this bold");
  });

  it("sets and clears a valued mark", () => {
    const colored = run(select(stateFor("Red word"), "Red"), setMark(schema.marks.text_color!, { color: "#ff0000" }));
    let color: unknown = null;
    colored.state.doc.descendants((node) => {
      if (node.isText && node.text === "Red") color = node.marks.find((mark) => mark.type.name === "text_color")?.attrs.color;
      return true;
    });
    assert.equal(color, "#ff0000");
    const cleared = run(colored.state, setMark(schema.marks.text_color!, null));
    assert.equal(cleared.state.doc.textContent, "Red word");
    assert.equal(markActive(cleared.state, schema.marks.text_color!), false);
  });

  it("clear formatting removes marks but keeps links", () => {
    const base = stateFor("**bold** *it* [link](https://a.example)");
    const all = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1, base.doc.content.size - 1)));
    const { md } = run(all, clearFormatting);
    assert.equal(md, "bold it [link](https://a.example)");
  });

  it("inserts text at the cursor", () => {
    assert.equal(run(stateFor("ac", 2), insertText("b")).md, "abc");
  });
});

describe("links", () => {
  it("normalizes bare hosts and leaves real URLs alone", () => {
    assert.equal(normalizeHref("example.com"), "https://example.com");
    assert.equal(normalizeHref("https://example.com/x"), "https://example.com/x");
    assert.equal(normalizeHref("mailto:a@b.co"), "mailto:a@b.co");
    assert.equal(normalizeHref("#section"), "#section");
  });

  it("adds, finds and removes a link", () => {
    const linked = run(select(stateFor("Visit the site"), "site"), setLink("https://example.com"));
    assert.equal(linked.md, "Visit the [site](https://example.com)");
    const at = linkAt(linked.state);
    assert.equal(at?.href, "https://example.com");
    assert.equal(run(linked.state, setLink(null)).md, "Visit the site");
  });

  it("inserts linked text when nothing is selected", () => {
    const { md } = run(stateFor("Go", 3), setLink("example.com", "here"));
    assert.equal(md, "Go[here](https://example.com)");
  });
});

describe("blocks", () => {
  it("switches paragraph styles", () => {
    const heading = run(stateFor("Words", 2), setBlock("h2"));
    assert.equal(heading.md, "## Words");
    assert.equal(blockKind(heading.state), "h2");
    assert.equal(run(heading.state, setBlock("paragraph")).md, "Words");
    assert.equal(run(stateFor("Words", 2), setBlock("title")).md, "# Words {.title}");
  });

  it("aligns, spaces and indents paragraphs", () => {
    const centered = run(stateFor("Words", 2), setAlign("center"));
    assert.equal(currentAlign(centered.state), "center");
    const spaced = run(centered.state, setLineHeight("2"));
    assert.equal(currentLineHeight(spaced.state), "2");
    const indented = run(stateFor("Words", 2), indent);
    assert.match(indented.md, /indent=1/);
    assert.equal(run(indented.state, outdent).md, "Words");
  });

  it("toggles bulleted, numbered and task lists", () => {
    const bullets = run(stateFor("One", 2), toggleList("bullet"));
    assert.equal(bullets.md, "- One");
    assert.equal(listKind(bullets.state), "bullet");
    const numbered = run(bullets.state, toggleList("ordered"));
    assert.equal(numbered.md, "1. One");
    const tasks = run(stateFor("One", 2), toggleList("task"));
    assert.equal(tasks.md, "- [ ] One");
    assert.equal(run(bullets.state, toggleList("bullet")).md, "One", "toggling the same list unwraps it");
  });

  it("checks and unchecks a task", () => {
    const tasks = run(stateFor("One", 2), toggleList("task")).state;
    let itemPos = -1;
    tasks.doc.descendants((node, pos) => {
      if (itemPos < 0 && node.type.name === "list_item") itemPos = pos;
      return itemPos < 0;
    });
    const checked = run(tasks, toggleTask(itemPos));
    assert.equal(checked.md, "- [x] One");
  });

  it("wraps and unwraps a quote", () => {
    const quoted = run(stateFor("Said", 2), toggleBlockquote);
    assert.equal(quoted.md, "> Said");
    assert.equal(run(quoted.state, toggleBlockquote).md, "Said");
  });

  it("inserts rules, page breaks and tables", () => {
    assert.match(run(stateFor("Text", 5), insertHorizontalRule).md, /---/);
    assert.match(run(stateFor("Text", 5), insertPageBreak).md, /\\pagebreak/);
    const table = run(stateFor("Text", 5), insertTable(2, 3));
    let rows = 0;
    let cells = 0;
    table.state.doc.descendants((node) => {
      if (node.type.name === "table_row") rows += 1;
      if (node.type.name === "table_cell" || node.type.name === "table_header") cells += 1;
      return true;
    });
    assert.equal(rows, 2);
    assert.equal(cells, 6);
    assert.equal(table.state.selection.$from.parent.type.name, "paragraph");
    assert.equal(table.state.selection.$from.node(-1).type.name, "table_header", "the cursor lands in the first cell");
  });
});
