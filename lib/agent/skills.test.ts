import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { systemPrompt } from "@/lib/agent/prompt";
import { PAGE_LAYOUT_PLUGIN_DIR, PAGE_LAYOUT_SKILL } from "@/lib/agent/skills";

const skillPath = path.join(PAGE_LAYOUT_PLUGIN_DIR, "skills", PAGE_LAYOUT_SKILL, "SKILL.md");
const skill = readFileSync(skillPath, "utf8");

describe("page-layout skill", () => {
  it("is a Claude skill the agent loads when the user wants the document to look good", () => {
    const plugin = JSON.parse(readFileSync(path.join(PAGE_LAYOUT_PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")) as { name?: string };
    assert.equal(typeof plugin.name, "string");
    assert.match(skill, /^---\nname: page-layout\n/);
    assert.match(skill, /description:[\s\S]*look good/);
    assert.match(systemPrompt("Monday, January 1, 2026"), /page-layout skill/);
    assert.match(systemPrompt("Monday, January 1, 2026"), /screenshot_page/);
    assert.match(systemPrompt("Monday, January 1, 2026"), /Don't only comment/);
  });

  it("tells the agent to look, then fix, using a screenshot when that is the signal", () => {
    assert.match(skill, /Don't only comment/);
    assert.match(skill, /screenshot_page/);
    assert.match(skill, /get_page_count/);
    assert.match(skill, /last page with only a line or two/i);
    assert.match(skill, /table split across a page break/i);
    assert.match(skill, /Random font changes/);
    assert.match(skill, /Images that are too big/);
    assert.match(skill, /Inconsistent spacing/);
    assert.match(skill, /format_text/);
    assert.match(skill, /set_paragraph_style/);
    assert.match(skill, /edit_document/);
    // A picture is for what Markdown cannot show; page count covers a sparse last page on its own.
    assert.match(skill, /Skip a screenshot when get_page_count already answers/);
  });
});
