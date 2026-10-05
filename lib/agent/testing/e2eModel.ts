import { fakeClaude, type FakeModel } from "@/lib/agent/testing/fakeClaude";

/**
 * The scripted Claude used by the browser tests (INLINE_FAKE_CLAUDE=1), so the
 * Claude panel can be exercised end to end without a login. It understands a
 * few fixed phrasings and uses Inline's real MCP tools to act on them.
 */

const failedOnce = new Set<string>();

const model: FakeModel = async (turn, claude) => {
  const text = turn.text;
  const documentId = turn.context.match(/\(id ([^)]+)\)/)?.[1];

  const replace = text.match(/^replace "(.+)" with "(.+)"$/i);
  if (replace) {
    claude.think("I'll read the document, then make the edit.");
    claude.builtin("TodoWrite", {
      todos: [
        { content: "Read the document", activeForm: "Reading the document", status: "completed" },
        { content: "Make the edit", activeForm: "Making the edit", status: "in_progress" },
      ],
    });
    await claude.call("read_document", { document_id: documentId });
    const result = await claude.call("edit_document", { document_id: documentId, old_string: replace[1], new_string: replace[2] });
    claude.say(result.isError ? `I could not make that edit. ${result.text}` : `Replaced ${replace[1]} with ${replace[2]}.`);
    return;
  }

  const comment = text.match(/^comment on "(.+)": (.+)$/i);
  if (comment) {
    await claude.call("add_comment", { document_id: documentId, text: comment[1], comment: comment[2] });
    claude.say("I left a comment.");
    return;
  }

  if (/take your time/i.test(text)) {
    claude.say("Starting a long review.");
    await claude.untilInterrupted();
    return;
  }

  if (/fail once/i.test(text) && !failedOnce.has(text)) {
    failedOnce.add(text);
    claude.crash("Error: Not logged in. Please run /login");
    return;
  }

  claude.say(`You said: ${text}`);
};

export function e2eClaude() {
  return fakeClaude(model);
}
