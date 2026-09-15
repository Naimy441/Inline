import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, before } from "node:test";
import { runAgent } from "../runAgent";
import { DocumentSession } from "../mcp/session";
import { applyClientTools } from "../clientTools";
import { isClientTool } from "../toolCatalog";
import { LIVE_CASES } from "./cases";
import { applyEditsToSession, createEditor, destroyEditor, htmlFromPlain, installDom, mockClientIo } from "./harness";

function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocal();
const live = Boolean(process.env.INLINE_LIVE_EVAL);
const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim());
const run = live && hasKey ? describe : describe.skip;

if (live && !hasKey) {
  describe("live agent document eval", () => {
    it("needs OPENAI_API_KEY or ANTHROPIC_API_KEY", () => {
      assert.fail("INLINE_LIVE_EVAL is set, but no model API key is available.");
    });
  });
}

run("live agent document eval", () => {
  before(() => {
    installDom();
  });
  for (const row of LIVE_CASES) {
    it(row.id, { timeout: 120_000 }, async () => {
      const result = await runAgent({
        title: "Eval",
        prompt: row.prompt,
        document: row.document,
        pages: row.pages,
        selection: null,
        mode: "agent",
        model: "gpt-5.4-nano",
        thinkingLevel: "none",
        nameChat: false,
        history: [],
      });
      const session = new DocumentSession({ title: "Eval", text: row.document, pages: row.pages });
      applyEditsToSession(session, result.edits ?? []);
      const editor = createEditor(htmlFromPlain(session.text || row.document));
      const { io, state } = mockClientIo();
      const clientCalls = (result.tools ?? []).filter((call) => isClientTool(call.name));
      applyClientTools(editor, clientCalls, io);
      const issues = row.grade({
        prompt: row.prompt,
        text: session.text,
        pages: session.pages,
        editor,
        io: state,
        tools: (result.tools ?? []).map((call) => call.name),
        edits: result.edits ?? [],
      });
      destroyEditor(editor);
      assert.deepEqual(issues, [], `${row.id} failed: ${issues.join("; ")}\nmessage: ${result.message}`);
    });
  }
});
