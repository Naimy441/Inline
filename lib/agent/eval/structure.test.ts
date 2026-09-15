import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { applyClientTools } from "../clientTools";
import { DocumentSession } from "../mcp/session";
import { leftoverWhitespaceIssues, markdownListIssues, markdownTableIssues } from "../../writing/documentQuality";
import { createEditor, destroyEditor, htmlFromPlain, installDom, mockClientIo, selectAll, tool } from "./harness";

before(() => {
  installDom();
});

describe("lists, tables, and headings from tools", () => {
  it("builds bullets from a messy unformatted list", () => {
    const editor = createEditor(htmlFromPlain("Milk\n\nEggs\n\nBread"));
    selectAll(editor);
    const { io } = mockClientIo();
    applyClientTools(editor, [tool("toggle_list", { type: "ul" })], io);
    assert.equal(editor.querySelectorAll("li").length, 3);
    assert.match(editor.textContent ?? "", /Milk/);
    destroyEditor(editor);
  });

  it("builds numbered lists from steps that had extra blank lines", () => {
    const session = new DocumentSession({ title: "Doc", text: "Preheat.\n\n\n\nMix.\n\n\nBake." });
    session.replaceText(session.text, "Preheat.\n\nMix.\n\nBake.");
    assert.deepEqual(leftoverWhitespaceIssues(session.text), []);
    const editor = createEditor(htmlFromPlain(session.text));
    selectAll(editor);
    const { io } = mockClientIo();
    applyClientTools(editor, [tool("toggle_list", { type: "ol" })], io);
    assert.equal(editor.querySelectorAll("ol li").length, 3);
    destroyEditor(editor);
  });

  it("inserts a table into poorly spaced CSV-like text", () => {
    const editor = createEditor("<div>Name, Role, Team</div>");
    const { io } = mockClientIo();
    applyClientTools(editor, [tool("insert_table", { rows: 3, cols: 3, find: "Name, Role, Team" })], io);
    const table = editor.querySelector("table");
    assert.ok(table);
    assert.equal(table?.querySelectorAll("tr").length, 3);
    assert.equal(table?.querySelectorAll("td").length, 9);
    destroyEditor(editor);
  });

  it("promotes a shouty line into a heading and centers it", () => {
    const editor = createEditor("<div>A LOUD TITLE</div><div>Body copy.</div>");
    const { io } = mockClientIo();
    applyClientTools(
      editor,
      [
        tool("set_block_style", { find: "A LOUD TITLE", style: "h1" }),
        tool("set_alignment", { find: "A LOUD TITLE", align: "center" }),
      ],
      io,
    );
    const heading = editor.querySelector("h1");
    assert.ok(heading);
    assert.equal(heading?.style.textAlign, "center");
    destroyEditor(editor);
  });
});

describe("plain-text list and table construction", () => {
  it("can write markdown bullets with insert_text", () => {
    const session = new DocumentSession({ title: "Doc", text: "" });
    session.insertText("- Milk\n- Eggs\n- Bread");
    assert.deepEqual(markdownListIssues(session.text, "ul", 3), []);
    assert.deepEqual(leftoverWhitespaceIssues(session.text), []);
  });

  it("can write numbered steps with insert_text", () => {
    const session = new DocumentSession({ title: "Doc", text: "" });
    session.insertText("1. Preheat\n2. Mix\n3. Bake\n4. Cool");
    assert.deepEqual(markdownListIssues(session.text, "ol", 4), []);
  });

  it("can write a markdown table with insert_text", () => {
    const session = new DocumentSession({ title: "Doc", text: "" });
    session.insertText("| Name | Role | Team |\n| --- | --- | --- |\n| Ada | Engineer | Atlas |\n| Lin | Editor | North |");
    assert.deepEqual(markdownTableIssues(session.text, 3, 3), []);
  });
});
