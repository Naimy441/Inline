import { documentFingerprint } from "@/lib/agent/continuation";
import { SHORT_DOC_CHARS, type DocumentSession } from "@/lib/agent/mcp/session";
import type { AgentPriorEdit, AgentRequest } from "@/lib/agent/types";

export function requestAllowsEdits(request: AgentRequest) {
  if (request.mode !== "agent") return false;
  return !/\b(?:do\s+not|don't|dont|without|no)\s+(?:edit|editing|change|changes|rewrite|rewriting)\b/i.test(request.prompt);
}

export function systemPrompt(request: AgentRequest) {
  const canEdit = requestAllowsEdits(request);
  const lines = [
    "You are Inline, a writing agent inside a Google Docs-style paginated editor.",
    `Current mode: ${request.mode}.`,
    request.preserveTone
      ? "Preserve the author's tone, diction, and rhythm unless the user asks to change style."
      : "You may adjust tone if it helps the instruction.",
    "The working draft lives on the document session.",
    "If this is a follow-up, earlier turns and tool results are already in this thread. Use them. Do not restart from scratch unless the user asks.",
    "If the task needs prose you have not been given in this message, call read_document or search_document first. Do not invent find-text.",
    "read_document({ page }) returns one visual letter page plus a paragraphs array with the same P1, P2 ids as search_document. Raw page text does not include those ids. Prefer paragraphId when inserting. read_document({ scope: \"document\" }) returns the whole draft, or page 1 plus paging fields when it is long.",
    canEdit
      ? "Apply edits with replace_text, insert_text, or delete_text. Each successful write becomes a keep/undo suggestion in the page. Do not paste the new prose in your chat message."
      : "Do not call write tools. Answer or plan only.",
    "LOCKED passages must not be edited.",
    "Comments are instructions about specific quotes. Address every provided comment.",
    "Style attachments are samples to mimic, not text to copy wholesale.",
    "For current facts, news, or sources on the open web, call web_search, then web_fetch the best URLs before quoting. search_citations is only the local style catalog.",
    "Do not invent URLs, quotes, dates, or citations. Only cite pages you web_fetch. Search snippets are not sources.",
    "Call lint_writing or count_words only when the user asked for a length or a diagnosis.",
    "The latest user instruction is the active task. Earlier turns are background.",
    "When you are done, write a short message about what you did. Speak in plain sentences. Do not use markdown, asterisks, backticks, or code fences in the chat message. Never quote the replacement prose.",
  ];
  if (canEdit) {
    lines.push(
      "Use editor tools for formatting that is not plain text: apply_paper_style, highlight_text, set_text_color, set_font_family, set_font_size, toggle_bold, toggle_italic, toggle_underline, set_alignment, set_line_spacing, set_block_style, set_paragraph_indent, toggle_list, insert_table, insert_horizontal_line, insert_page_break, indent_blocks, insert_link, insert_image, add_header, add_footer, add_page_numbers, export_pdf.",
      "Each newline in insert_text or replace_text becomes its own editor line. Put the MLA/APA heading on four separate lines (name, instructor, course, date). A blank line starts a new paragraph. Never write those heading lines as one wrapped sentence. Do not hard-wrap body paragraphs to fit the page; the editor paginates. A lowercase leftover after a newline stays in the same paragraph.",
      "insert_table takes a cells grid of strings and fills the table in that same call. Do not insert an empty table and try to replace_text into the cells. Insert the table first, then insert_page_break after it. Never put a page break inside a table. The editor keeps tables whole and moves the whole table if it does not fit.",
      "indent_blocks changes left margin. For first-line essay indent use set_paragraph_indent kind first-line. For bibliography hanging indent use kind hanging. To indent every body paragraph, call set_paragraph_indent once with kind first-line and no find. To hanging-indent the bibliography, call it once with kind hanging and no find, or pass find Works Cited, kind hanging, and following true. Never insert tab characters or spaces to indent.",
      "After deletes and replacements, leave no extra spaces, extra blank lines, or blank pages. If the user asks for an exact length, hit it and call count_words before you finish.",
      "If the user asked for a BME, that is beginning, middle, and end (introduction, body, conclusion). Do not write worksheet labels such as Main evidence: or Explanation: into the paper.",
      ...paperFormatHints(request.prompt),
    );
  }
  if (request.nameChat) {
    lines.push("Call set_chat_title with a 3–6 word name once you understand the request.");
  }
  return lines.join("\n");
}

function paperFormatHints(prompt: string) {
  const mla = /\bmla(?:\s*-?\s*8|\s*eighth)?\b|\bmla-?style\b|\bworks cited\b/i.test(prompt);
  const apa = /\bapa(?:\s*-?\s*7)?\b/i.test(prompt);
  if (!mla && !apa) return [];
  if (mla) {
    return [
      "This is an MLA paper. Call apply_paper_style with preset mla before the first insert_text so new prose inherits Times 12, double spacing, and a last-name header. If you do not know the last name, pass Last Name.",
      "The first insert must be the four heading lines, then the paper title, then body paragraphs, then Works Cited. Each is its own newline. Center the title and Works Cited heading with set_alignment. First-line indent body paragraphs and hanging-indent bibliography entries with set_paragraph_indent as you write. Do not dump unstyled prose and format later.",
      "Two to four web_search calls, then web_fetch the best official HTML pages, then write. If a fetch says the URL is a PDF, use the HTML landing page instead. Do not keep searching for the same PDF.",
    ];
  }
  return [
    "This is an APA paper. Call apply_paper_style with preset apa before the first insert_text.",
    "Center the title with set_alignment. References start on a new page. Use set_paragraph_indent hanging for reference entries as you write them.",
  ];
}

export function userPrompt(request: AgentRequest, session: DocumentSession) {
  const outline = session.outline();
  const headings = outline.filter((item) => item.heading).slice(0, 16);
  const preview = (headings.length ? headings : outline.slice(0, 8))
    .map((item) => `${item.paragraphId} p${item.page}: ${item.text.slice(0, 140)}`)
    .join("\n");
  const selections = request.selections?.length
    ? request.selections
    : request.selection
      ? [request.selection]
      : [];
  const fingerprint = documentFingerprint(session.text);
  const continuing = Boolean(request.continuation && (request.history.length || request.continuation.openaiResponseId));
  const sameDraft = Boolean(request.continuation?.documentFingerprint && request.continuation.documentFingerprint === fingerprint);
  const short = session.text.length > 0 && session.text.length <= SHORT_DOC_CHARS;

  const lines = [
    `Document title: ${session.title || "Untitled document"}`,
    `Pages: ${session.pageCount()}. Characters: ${session.text.length}.`,
    request.preserveTone ? "Tone lock: preserve existing voice." : "Tone lock: off.",
    continuing
      ? "This is a follow-up in the same chat. Keep prior tool results; the draft below is the current page."
      : "New chat turn.",
    "",
    "Instruction:",
    request.prompt.trim(),
    "",
    "Outline:",
    preview || "(empty document)",
    "",
  ];

  if (continuing && sameDraft) {
    lines.push("The working draft is unchanged since your last turn.", "");
  } else if (short) {
    lines.push("The draft is short, so the full text is included once:", "<<<DOCUMENT>>>", session.text || "(empty)", "<<<END_DOCUMENT>>>", "");
  } else if (!session.text.trim()) {
    lines.push("The working draft is empty.", "");
  } else {
    lines.push("The full draft is on the session. Call read_document when you need prose.", "");
  }

  if (request.previousEdits?.length) {
    lines.push(
      "Edits already on the page. Do not repeat these unless the user asks:",
      request.previousEdits.map(formatPriorEdit).join("\n"),
      "",
    );
  }
  if (request.recentTools?.length) {
    lines.push(`Tools used last turn: ${request.recentTools.slice(0, 16).join(", ")}.`, "");
  }

  if (selections.length) {
    lines.push(
      `The user attached ${selections.length} highlighted passage${selections.length === 1 ? "" : "s"} as extra context:`,
      "<<<SELECTIONS>>>",
      selections
        .map(
          (selection, index) =>
            `Selection ${index + 1}:\n${selection.text}\nNearby before: ${selection.before || "(start)"}\nNearby after: ${selection.after || "(end)"}`,
        )
        .join("\n\n"),
      "<<<END_SELECTIONS>>>",
      "",
    );
  }
  if (request.comments?.length) {
    lines.push(
      "Comments to address:",
      request.comments.map((comment, index) => `${index + 1}. Quote: ${comment.quote}\n   Note: ${comment.body || "(no note)"}`).join("\n"),
      "",
    );
  }
  if (request.lockedRanges?.length) {
    lines.push("LOCKED passages. Do not edit these:", request.lockedRanges.map((range) => `- ${range.text}`).join("\n"), "");
  }
  if (request.attachments?.length) {
    lines.push(
      "Style samples to mimic:",
      request.attachments.map((file) => `## ${file.name}\n${file.text}`).join("\n\n"),
      "",
    );
  }
  return lines.join("\n");
}

export function recentHistory(request: AgentRequest) {
  return request.history.slice(-16);
}

export function defaultMessage(mode: AgentRequest["mode"]) {
  if (mode === "plan") return "Here is a plan for the document.";
  if (mode === "ask") return "Here is what the document shows.";
  return "I made a targeted change. Keep or undo it in the page.";
}

export function sanitizeAgentMessage(message: string, mode: AgentRequest["mode"], replacements: string[]) {
  const trimmed = message.trim();
  if (mode !== "agent" || !replacements.length) return trimmed || defaultMessage(mode);
  const compact = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const msg = compact(trimmed);
  if (!msg) return defaultMessage(mode);
  for (const replace of replacements) {
    const next = compact(replace);
    if (next && msg === next) return defaultMessage(mode);
    if (next.length > 40 && msg.includes(next)) return defaultMessage(mode);
  }
  return trimmed;
}

export function stepTitle(name: string, args: Record<string, unknown>, documentTitle?: string) {
  const doc = (documentTitle ?? "").replace(/\s+/g, " ").trim() || "the document";
  if (name === "read_document") {
    if (typeof args.page === "number") return `Reading ${doc} · page ${args.page}`;
    if (Array.isArray(args.pages)) return `Reading ${doc} · pages ${args.pages.join(", ")}`;
    if (typeof args.paragraphId === "string") return `Reading ${args.paragraphId}`;
    return `Reading ${doc}`;
  }
  if (name === "search_document") return `Searched “${String(args.query ?? "").slice(0, 40)}”`;
  if (name === "get_outline") return "Read the outline";
  if (name === "replace_text") return "Replaced text";
  if (name === "insert_text") return "Inserted text";
  if (name === "delete_text") return "Deleted text";
  if (name === "search_citations") return `Searched sources “${String(args.query ?? "").slice(0, 40)}”`;
  if (name === "web_search") return `Searched the web “${String(args.query ?? "").slice(0, 40)}”`;
  if (name === "set_paragraph_indent") {
    if (args.kind === "hanging") return "Set hanging indent";
    if (args.kind === "none") return "Cleared paragraph indent";
    return "Set first-line indent";
  }
  if (name === "set_chat_title") return "Named the chat";
  if (name === "web_fetch") {
    try {
      return `Read ${new URL(String(args.url ?? "")).hostname.replace(/^www\./, "")}`;
    } catch {
      return "Read a web page";
    }
  }
  return name.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function stepHits(name: string, raw: unknown) {
  if (name !== "search_document" && name !== "search_citations" && name !== "web_search" && name !== "web_fetch") {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as {
    hits?: Array<{ snippet?: string }>;
    works?: Array<{ title?: string }>;
    results?: Array<{ title?: string; snippet?: string }>;
    title?: string;
  };
  if (Array.isArray(row.hits)) return row.hits.map((hit) => hit.snippet ?? "").filter(Boolean).slice(0, 4);
  if (Array.isArray(row.works)) return row.works.map((work) => work.title ?? "").filter(Boolean).slice(0, 4);
  if (Array.isArray(row.results)) {
    return row.results.map((item) => item.title || item.snippet || "").filter(Boolean).slice(0, 4);
  }
  if (typeof row.title === "string" && row.title.trim()) return [row.title];
  return undefined;
}

export function mockTitle(prompt: string) {
  const words = prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" ");
  return words ? words.replace(/[.?!,:;]+$/, "") : "New chat";
}

function formatPriorEdit(edit: AgentPriorEdit) {
  const operation = edit.operation ?? (edit.replace === "" ? "delete" : edit.find === "" ? "insert" : "replace");
  return `- ${edit.status} ${operation}: “${clip(edit.find)}” → “${clip(edit.replace)}”`;
}

function clip(value: string, max = 80) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
