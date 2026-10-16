import { fakeClaude, type FakeModel } from "@/lib/agent/testing/fakeClaude";

/**
 * The scripted Claude used by the browser tests (INLINE_FAKE_CLAUDE=1), so the
 * Claude panel can be exercised end to end without a login. It understands a
 * few fixed phrasings and uses Inline's real MCP tools to act on them.
 */

const failedOnce = new Set<string>();
let backgroundJob: string | undefined;

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

  // Edit, then keep the turn open, so the page shows where Claude is working.
  const slowEdit = text.match(/^slowly replace "(.+)" with "(.+)"$/i);
  if (slowEdit) {
    await claude.call("edit_document", { document_id: documentId, old_string: slowEdit[1], new_string: slowEdit[2] });
    claude.say("Still working on it.");
    await claude.untilInterrupted();
    return;
  }

  // From the home page: search the library and open the match.
  const find = text.match(/^find the document about "(.+)"$/i);
  if (find) {
    const found = await claude.call("search_documents", { query: find[1] });
    const id = found.text.match(/^- (\S+) · /m)?.[1];
    if (!id || found.isError) {
      claude.say(found.isError ? found.text : `I couldn't find a document about "${find[1]}".`);
      return;
    }
    const opened = await claude.call("open_document", { document_id: id });
    claude.say(opened.isError ? opened.text : `Opened the document about ${find[1]}.`);
    return;
  }

  // From the home page: find a document in the library by title and file it.
  const file = text.match(/^file "(.+)" in "(.+)"$/i);
  if (file) {
    const listing = await claude.call("list_library", { excerpt_words: 0 });
    const id = new RegExp(`- (\\S+)(?: \\(open\\))? · "${file[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(listing.text)?.[1];
    if (!id) {
      claude.say(`I couldn't find "${file[1]}".`);
      return;
    }
    const moved = await claude.call("move_documents", { moves: [{ document_id: id, folder: file[2] }] });
    claude.say(moved.isError ? moved.text : `Filed "${file[1]}" in ${file[2]}.`);
    return;
  }

  // An imported PDF: rebuild its first page from the text lines read_pdf_page lists, then line it up and check it.
  if (/^Convert the PDF I imported/.test(text)) {
    await claude.call("get_pdf_import", { document_id: documentId });
    const page = await claude.call("read_pdf_page", { document_id: documentId, page: 1 });
    const lines = [...page.text.matchAll(/^\s*[\d.]+\s+[\d.]+\s+[\d.]+\s+[^:]+: (.+)$/gm)].map((match) => match[1]!.replace(/\*/g, ""));
    const written = await claude.call("write_pdf_page", { document_id: documentId, page: 1, content: lines.join("\n\n") });
    if (written.isError) {
      claude.say(written.text);
      return;
    }
    const aligned = await claude.call("align_pdf_page", { document_id: documentId, page: 1 });
    const compared = await claude.call("compare_pdf_page", { document_id: documentId, page: 1 });
    const finished = await claude.call("finish_pdf_import", { document_id: documentId });
    claude.say([aligned.text, compared.text.split("\n")[1] ?? "", finished.text].join("\n\n"));
    // Pages left: the notice stays up, but a finished turn clears the caret. Hold the
    // turn so the locator chip can be read next to it. A one-page import finishes here.
    if (finished.isError) await claude.untilInterrupted();
    return;
  }

  const readBoth = text.match(/^read (\S+) and (\S+) together$/);
  if (readBoth) {
    const result = await claude.call("start_jobs", {
      jobs: [
        { tool: "read_document", arguments: { document_id: readBoth[1] } },
        { tool: "read_document", arguments: { document_id: readBoth[2] } },
      ],
    });
    claude.say(result.text);
    return;
  }

  if (/^cancel a long command$/i.test(text)) {
    const started = await claude.call("start_job", { tool: "run_command", arguments: { command: "sleep 30; echo should-not-finish" }, document_id: documentId });
    const id = started.text.match(/job_[0-9a-f]+/)?.[0];
    const stopped = id ? await claude.call("stop_job", { job_id: id }) : started;
    claude.say(stopped.text);
    return;
  }

  if (/^start a background read$/i.test(text)) {
    const started = await claude.call("start_job", { tool: "read_document", arguments: { document_id: documentId } });
    backgroundJob = started.text.match(/job_[0-9a-f]+/)?.[0];
    claude.say(started.text);
    return;
  }

  if (/^pick up the background job$/i.test(text)) {
    let result = await claude.call("get_job", { job_id: backgroundJob ?? "job_missing" });
    for (let attempt = 0; attempt < 25 && /still running/.test(result.text); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      result = await claude.call("get_job", { job_id: backgroundJob ?? "job_missing" });
    }
    claude.say(result.text);
    return;
  }

  if (/what did I link/i.test(text)) {
    const samples = [...turn.context.matchAll(/<writing-sample>([\s\S]*?)<\/writing-sample>/g)].map((match) => match[1]!.trim());
    const docs = [...turn.context.matchAll(/<linked-document>([\s\S]*?)<\/linked-document>/g)].map((match) => match[1]!.trim());
    const parts = [...(samples.length ? [`Sample:\n${samples.join("\n")}`] : []), ...(docs.length ? [`Context:\n${docs.join("\n")}`] : [])];
    claude.say(parts.join("\n\n") || "Nothing linked.");
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
