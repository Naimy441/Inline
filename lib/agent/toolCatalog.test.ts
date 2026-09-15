import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isToolName, DOCUMENT_TOOLS, SERVER_TOOLS, CLIENT_TOOLS } from "./toolCatalog";

describe("tool catalog", () => {
  it("recognizes document, server, and client tools", () => {
    assert.equal(isToolName("get_outline"), true);
    assert.equal(isToolName("replace_text"), true);
    assert.equal(isToolName("lint_writing"), true);
    assert.equal(isToolName("export_pdf"), true);
    assert.equal(isToolName("set_text_color"), true);
    assert.equal(isToolName("add_footer"), true);
    assert.equal(isToolName("insert_table"), true);
    assert.equal(isToolName("web_search"), true);
    assert.equal(isToolName("apply_paper_style"), true);
    assert.equal(isToolName("not_a_tool"), false);
    assert.equal(new Set([...DOCUMENT_TOOLS, ...SERVER_TOOLS, ...CLIENT_TOOLS]).size, DOCUMENT_TOOLS.length + SERVER_TOOLS.length + CLIENT_TOOLS.length);
  });
});
