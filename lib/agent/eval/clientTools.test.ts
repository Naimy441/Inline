import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { applyClientTools } from "../clientTools";
import { createEditor, destroyEditor, installDom, mockClientIo, selectAll, tool } from "./harness";

before(() => {
  installDom();
});

const SAMPLE = "<div>The river was wide and slow.</div><div>A second paragraph waits for a heading.</div>";

describe("client formatting tools", () => {
  it("highlights a passage", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    const applied = applyClientTools(editor, [tool("highlight_text", { find: "river", color: "#fff3b0" })], io);
    assert.equal(applied[0]?.ok, true, applied[0]?.detail ?? "");
    assert.match(editor.innerHTML, /background-color|#fff3b0|rgb\(255,\s*243,\s*176\)/i);
    destroyEditor(editor);
  });

  it("colors a passage", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    const applied = applyClientTools(editor, [tool("set_text_color", { find: "second paragraph", color: "#cc0000" })], io);
    assert.equal(applied[0]?.ok, true, applied[0]?.detail ?? "");
    assert.match(editor.innerHTML, /#cc0000|rgb\(204,\s*0,\s*0\)|color:/i);
    destroyEditor(editor);
  });

  it("sets font family and size", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    const applied = applyClientTools(
      editor,
      [
        tool("set_font_family", { find: "The river was wide and slow.", family: "Georgia" }),
        tool("set_font_size", { find: "The river was wide and slow.", size: "18pt" }),
      ],
      io,
    );
    assert.ok(applied.every((item) => item.ok), applied.map((item) => item.detail).join("; "));
    assert.match(editor.innerHTML, /georgia/i);
    assert.match(editor.innerHTML, /18pt/);
    destroyEditor(editor);
  });

  it("applies bold, italic, and underline", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    const applied = applyClientTools(
      editor,
      [
        tool("toggle_bold", { find: "river" }),
        tool("toggle_italic", { find: "wide" }),
        tool("toggle_underline", { find: "slow" }),
      ],
      io,
    );
    assert.ok(applied.every((item) => item.ok), applied.map((item) => item.detail).join("; "));
    assert.match(editor.innerHTML, /<(strong|b)\b/i);
    assert.match(editor.innerHTML, /<(em|i)\b/i);
    assert.match(editor.innerHTML, /<u\b|underline/i);
    destroyEditor(editor);
  });

  it("sets header, footer, and page numbers", () => {
    const editor = createEditor(SAMPLE);
    const { io, state } = mockClientIo();
    const applied = applyClientTools(
      editor,
      [
        tool("add_header", { text: "Quarterly Review" }),
        tool("add_footer", { text: "Confidential" }),
        tool("add_page_numbers", { location: "footer" }),
      ],
      io,
    );
    assert.ok(applied.every((item) => item.ok));
    assert.equal(state.header, "Quarterly Review");
    assert.equal(state.footer, "Confidential");
    assert.equal(state.showHeader, true);
    assert.equal(state.showFooter, true);
    assert.equal(state.showPageNumbers, true);
    assert.equal(state.pageNumberLocation, "footer");
    destroyEditor(editor);
  });

  it("puts page numbers in the header when asked", () => {
    const editor = createEditor(SAMPLE);
    const { io, state } = mockClientIo();
    applyClientTools(editor, [tool("add_page_numbers", { location: "header" })], io);
    assert.equal(state.pageNumberLocation, "header");
    destroyEditor(editor);
  });

  for (const align of ["left", "center", "right", "justify"] as const) {
    it(`aligns ${align}`, () => {
      const editor = createEditor(SAMPLE);
      const { io } = mockClientIo();
      const applied = applyClientTools(editor, [tool("set_alignment", { find: "second paragraph", align })], io);
      assert.equal(applied[0]?.ok, true, applied[0]?.detail ?? "");
      const match = [...editor.querySelectorAll<HTMLElement>("div, p, h1")].some((el) => el.style.textAlign === align);
      assert.equal(match, true);
      destroyEditor(editor);
    });
  }

  it("sets line spacing", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    const applied = applyClientTools(editor, [tool("set_line_spacing", { value: "1.5" })], io);
    assert.equal(applied[0]?.ok, true);
    assert.equal(editor.style.lineHeight, "1.5");
    destroyEditor(editor);
  });

  it("applies first-line and hanging indent styles", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    applyClientTools(editor, [tool("set_paragraph_indent", { find: "The river was wide and slow.", kind: "first-line" })], io);
    applyClientTools(editor, [tool("set_paragraph_indent", { find: "A second paragraph waits for a heading.", kind: "hanging" })], io);
    const first = editor.querySelector(".indent-first");
    const hanging = editor.querySelector(".indent-hanging");
    assert.ok(first);
    assert.equal((first as HTMLElement).style.textIndent, "0.5in");
    assert.ok(hanging);
    assert.equal((hanging as HTMLElement).style.textIndent, "-0.5in");
    destroyEditor(editor);
  });

  it("indents every body paragraph without find", () => {
    const editor = createEditor(
      "<div>Paper Title</div><div>Body one is a longer sentence.</div><div>Body two is another longer sentence.</div><div>Works Cited</div><div>“Source one.”</div>",
    );
    const { io } = mockClientIo();
    const applied = applyClientTools(editor, [tool("set_paragraph_indent", { kind: "first-line" })], io);
    assert.equal(applied[0]?.ok, true);
    assert.deepEqual(
      [...editor.querySelectorAll(".indent-first")].map((node) => node.textContent),
      ["Body one is a longer sentence.", "Body two is another longer sentence."],
    );
    assert.equal(editor.querySelector(".indent-hanging"), null);
    destroyEditor(editor);
  });

  it("rejoins hard-wrapped leftovers before indenting the body", () => {
    const editor = createEditor(
      "<div>Paper Title</div><div>With human-centred guidance (UNESCO), AI can </div><div>support the </div><div>education system rather than weaken it.</div><div>Works Cited</div><div>“Source one.”</div>",
    );
    const { io } = mockClientIo();
    applyClientTools(editor, [tool("set_paragraph_indent", { kind: "first-line" })], io);
    const bodies = [...editor.querySelectorAll(".indent-first")].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim());
    assert.deepEqual(bodies, ["With human-centred guidance (UNESCO), AI can support the education system rather than weaken it."]);
    destroyEditor(editor);
  });

  it("hanging-indents the bibliography without find", () => {
    const editor = createEditor(
      "<div>Paper Title</div><div>Body one is a longer sentence.</div><div>Works Cited</div><div>“Source one.”</div><div>“Source two.”</div>",
    );
    const { io } = mockClientIo();
    applyClientTools(editor, [tool("set_paragraph_indent", { kind: "hanging" })], io);
    assert.deepEqual(
      [...editor.querySelectorAll(".indent-hanging")].map((node) => node.textContent),
      ["“Source one.”", "“Source two.”"],
    );
    assert.equal(editor.querySelector(".indent-first"), null);
    destroyEditor(editor);
  });

  it("applies indent through the next heading", () => {
    const editor = createEditor(
      "<div>Paper Title</div><div>Body one is a longer sentence.</div><div>Body two is another longer sentence.</div><div>Works Cited</div><div>“Source one.”</div><div>“Source two.”</div>",
    );
    const { io } = mockClientIo();
    applyClientTools(editor, [tool("set_paragraph_indent", { find: "Paper Title", kind: "first-line", following: true })], io);
    applyClientTools(editor, [tool("set_paragraph_indent", { find: "Works Cited", kind: "hanging", following: true })], io);
    const first = [...editor.querySelectorAll(".indent-first")].map((node) => node.textContent);
    const hanging = [...editor.querySelectorAll(".indent-hanging")].map((node) => node.textContent);
    assert.deepEqual(first, ["Body one is a longer sentence.", "Body two is another longer sentence."]);
    assert.deepEqual(hanging, ["“Source one.”", "“Source two.”"]);
    destroyEditor(editor);
  });

  it("applies MLA paper chrome in one tool", () => {
    const editor = createEditor(SAMPLE);
    const { io, state } = mockClientIo();
    const applied = applyClientTools(editor, [tool("apply_paper_style", { preset: "mla", lastName: "Lopez" })], io);
    assert.equal(applied[0]?.ok, true, applied[0]?.detail ?? "");
    assert.equal(state.header, "Lopez");
    assert.equal(state.showHeader, true);
    assert.equal(state.showPageNumbers, true);
    assert.equal(state.pageNumberLocation, "header");
    assert.equal(state.headerAlign, "right");
    assert.match(editor.style.fontFamily, /Times/);
    assert.equal(editor.style.lineHeight, "2");
    assert.equal(state.fontSize, "12pt");
    assert.equal(state.lineSpacing, "2");
    assert.match(state.fontFamily, /Times/);
    destroyEditor(editor);
  });

  it("applies heading styles", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    const applied = applyClientTools(editor, [tool("set_block_style", { find: "The river was wide and slow.", style: "h1" })], io);
    assert.equal(applied[0]?.ok, true, applied[0]?.detail ?? "");
    const heading = editor.querySelector("h1");
    assert.ok(heading);
    assert.ok(heading?.classList.contains("style-h1"));
    destroyEditor(editor);
  });

  it("applies title and subtitle styles", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    applyClientTools(editor, [tool("set_block_style", { find: "The river was wide and slow.", style: "title" })], io);
    assert.ok(editor.querySelector(".style-title"));
    applyClientTools(editor, [tool("set_block_style", { find: "A second paragraph waits for a heading.", style: "subtitle" })], io);
    assert.ok(editor.querySelector(".style-subtitle"));
    destroyEditor(editor);
  });

  it("inserts a 2x3 table", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    const applied = applyClientTools(editor, [tool("insert_table", { rows: 2, cols: 3, find: "wide and slow" })], io);
    assert.equal(applied[0]?.ok, true, applied[0]?.detail ?? "");
    assert.ok(editor.querySelector("table.doc-table"));
    assert.equal(editor.querySelectorAll("tr").length, 2);
    assert.equal(editor.querySelectorAll("td").length, 6);
    destroyEditor(editor);
  });

  it("inserts a 3x4 table", () => {
    const editor = createEditor("<div>Anchor here.</div>");
    const { io } = mockClientIo();
    applyClientTools(editor, [tool("insert_table", { rows: 3, cols: 4, find: "Anchor here." })], io);
    assert.equal(editor.querySelectorAll("tr").length, 3);
    assert.equal(editor.querySelectorAll("td").length, 12);
    destroyEditor(editor);
  });

  it("fills table cells in the same insert_table call", () => {
    const editor = createEditor("<div>Anchor here.</div>");
    const { io } = mockClientIo();
    applyClientTools(
      editor,
      [
        tool("insert_table", {
          find: "Anchor here.",
          cells: [
            ["Name", "Role"],
            ["Ada", "Engineer"],
          ],
        }),
      ],
      io,
    );
    const cells = [...editor.querySelectorAll("td")].map((cell) => (cell.textContent ?? "").trim());
    assert.deepEqual(cells, ["Name", "Role", "Ada", "Engineer"]);
    destroyEditor(editor);
  });

  it("fills an empty table instead of stacking a second one", () => {
    const editor = createEditor("<div>Anchor here.</div>");
    const { io } = mockClientIo();
    applyClientTools(
      editor,
      [
        tool("insert_table", { rows: 2, cols: 2, find: "Anchor here." }),
        tool("insert_table", {
          cells: [
            ["A", "B"],
            ["C", "D"],
          ],
        }),
      ],
      io,
    );
    assert.equal(editor.querySelectorAll("table").length, 1);
    const cells = [...editor.querySelectorAll("td")].map((cell) => (cell.textContent ?? "").trim());
    assert.deepEqual(cells, ["A", "B", "C", "D"]);
    destroyEditor(editor);
  });

  it("keeps a page break outside the table", () => {
    const editor = createEditor("<div>Before the grid.</div>");
    const { io } = mockClientIo();
    applyClientTools(
      editor,
      [
        tool("insert_table", {
          find: "Before the grid.",
          cells: [["Alpha", "Beta"]],
        }),
        tool("insert_page_break", { find: "Alpha" }),
      ],
      io,
    );
    const table = editor.querySelector("table");
    assert.ok(table);
    assert.equal(table?.querySelector("[data-manual-break]"), null);
    assert.ok(editor.querySelector("[data-manual-break]"));
    assert.equal(table?.nextElementSibling?.getAttribute("data-manual-break"), "true");
    destroyEditor(editor);
  });

  it("inserts a page break and a horizontal rule", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    const applied = applyClientTools(
      editor,
      [tool("insert_page_break", { find: "wide and slow" }), tool("insert_horizontal_line", {})],
      io,
    );
    assert.ok(applied.every((item) => item.ok), applied.map((item) => item.detail).join("; "));
    assert.ok(editor.querySelector("[data-manual-break]"));
    assert.ok(editor.querySelector("hr"));
    destroyEditor(editor);
  });

  it("indents a paragraph", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    const applied = applyClientTools(editor, [tool("indent_blocks", { find: "second paragraph", direction: "in" })], io);
    assert.equal(applied[0]?.ok, true, applied[0]?.detail ?? "");
    const indented = [...editor.querySelectorAll<HTMLElement>("div")].some((el) => el.style.marginLeft);
    assert.equal(indented, true);
    destroyEditor(editor);
  });

  it("inserts a link and an image", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    const applied = applyClientTools(
      editor,
      [
        tool("insert_link", { find: "river", url: "https://example.com", text: "river" }),
        tool("insert_image", { url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" }),
      ],
      io,
    );
    assert.ok(applied.every((item) => item.ok), applied.map((item) => item.detail).join("; "));
    const anchor = editor.querySelector("a");
    assert.equal(anchor?.getAttribute("href"), "https://example.com");
    assert.ok(editor.querySelector("img"));
    destroyEditor(editor);
  });

  it("exports a pdf by opening print", () => {
    const editor = createEditor(SAMPLE);
    const { io, state } = mockClientIo();
    applyClientTools(editor, [tool("export_pdf")], io);
    assert.equal(state.printed, true);
    destroyEditor(editor);
  });

  it("undo and redo do not throw", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    const applied = applyClientTools(editor, [tool("undo"), tool("redo")], io);
    assert.equal(applied.length, 2);
    destroyEditor(editor);
  });

  it("returns not found when the passage is missing", () => {
    const editor = createEditor(SAMPLE);
    const { io } = mockClientIo();
    const applied = applyClientTools(editor, [tool("highlight_text", { find: "not in the draft" })], io);
    assert.equal(applied[0]?.ok, false);
    destroyEditor(editor);
  });
});

describe("list construction via tools", () => {
  it("turns selected paragraphs into bullets", () => {
    const editor = createEditor("<div>Milk</div><div>Eggs</div><div>Sourdough</div><div>Olive oil</div>");
    selectAll(editor);
    const { io } = mockClientIo();
    const applied = applyClientTools(editor, [tool("toggle_list", { type: "ul" })], io);
    assert.equal(applied[0]?.ok, true, applied[0]?.detail ?? "");
    assert.ok(editor.querySelector("ul"));
    assert.equal(editor.querySelectorAll("ul li").length, 4);
    destroyEditor(editor);
  });

  it("turns selected paragraphs into a numbered list", () => {
    const editor = createEditor("<div>Preheat the oven.</div><div>Mix the batter.</div><div>Bake for twelve minutes.</div><div>Cool on a rack.</div>");
    selectAll(editor);
    const { io } = mockClientIo();
    applyClientTools(editor, [tool("toggle_list", { type: "ol" })], io);
    assert.ok(editor.querySelector("ol"));
    assert.equal(editor.querySelectorAll("ol li").length, 4);
    destroyEditor(editor);
  });

  it("can build a dash list", () => {
    const editor = createEditor("<div>First</div><div>Second</div>");
    selectAll(editor);
    const { io } = mockClientIo();
    applyClientTools(editor, [tool("toggle_list", { type: "ul", variant: "dash" })], io);
    assert.ok(editor.querySelector("ul.dash-list"));
    destroyEditor(editor);
  });

  it("can target a single line with find", () => {
    const editor = createEditor("<div>Milk</div><div>Eggs</div>");
    const { io } = mockClientIo();
    applyClientTools(editor, [tool("toggle_list", { type: "ul", find: "Milk" })], io);
    assert.ok(editor.querySelector("ul"));
    assert.ok(editor.querySelector("li")?.textContent?.includes("Milk"));
    destroyEditor(editor);
  });
});
