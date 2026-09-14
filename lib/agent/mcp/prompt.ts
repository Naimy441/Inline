import { SHORT_DOC_CHARS, type DocumentSession } from "@/lib/agent/mcp/session";
import type { AgentRequest } from "@/lib/agent/types";

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
    "The working draft lives on the document session. Do not assume you have already read the full paper.",
    "If the task needs prose you have not been given, call read_document or search_document first. Do not invent find-text.",
    "read_document({ page }) returns one visual letter page. read_document({ scope: \"document\" }) returns the whole draft, or page 1 plus paging fields when it is long.",
    canEdit
      ? "Apply edits with replace_text, insert_text, or delete_text. Each successful write becomes a keep/undo suggestion in the page. Do not paste the new prose in your chat message."
      : "Do not call write tools. Answer or plan only.",
    "LOCKED passages must not be edited.",
    "Comments are instructions about specific quotes. Address every provided comment.",
    "Style attachments are samples to mimic, not text to copy wholesale.",
    "Do not invent citations. Use search_citations only.",
    "Call lint_writing or count_words only when the user asked for a length or a diagnosis.",
    "The latest user instruction is the active task. Earlier turns are background.",
    "When you are done, write a short message about what you did. Never quote the replacement prose.",
  ];
  if (request.nameChat) {
    lines.push("Call set_chat_title with a 3–6 word name once you understand the request.");
  }
  return lines.join("\n");
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
  const short = session.text.length > 0 && session.text.length <= SHORT_DOC_CHARS;

  const lines = [
    `Document title: ${session.title || "Untitled document"}`,
    `Pages: ${session.pageCount()}. Characters: ${session.text.length}.`,
    request.preserveTone ? "Tone lock: preserve existing voice." : "Tone lock: off.",
    "",
    "Instruction:",
    request.prompt.trim(),
    "",
    "Outline:",
    preview || "(empty document)",
    "",
  ];

  if (short) {
    lines.push("The draft is short, so the full text is included once:", "<<<DOCUMENT>>>", session.text || "(empty)", "<<<END_DOCUMENT>>>", "");
  } else if (!session.text.trim()) {
    lines.push("The working draft is empty.", "");
  } else {
    lines.push("The full draft is on the session. Call read_document when you need prose.", "");
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

export function stepTitle(name: string, args: Record<string, unknown>) {
  if (name === "read_document") {
    if (args.scope === "document") return "Reading the document";
    if (typeof args.page === "number") return `Reading page ${args.page}`;
    if (Array.isArray(args.pages)) return `Reading pages ${args.pages.join(", ")}`;
    if (typeof args.paragraphId === "string") return `Reading ${args.paragraphId}`;
    return "Reading the document";
  }
  if (name === "search_document") return `Searched “${String(args.query ?? "").slice(0, 40)}”`;
  if (name === "get_outline") return "Read the outline";
  if (name === "replace_text") return "Replaced text";
  if (name === "insert_text") return "Inserted text";
  if (name === "delete_text") return "Deleted text";
  if (name === "search_citations") return `Searched sources “${String(args.query ?? "").slice(0, 40)}”`;
  return name.replace(/_/g, " ");
}

export function stepHits(name: string, raw: unknown) {
  if (name !== "search_document" && name !== "search_citations") return undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as { hits?: Array<{ snippet?: string }>; works?: Array<{ title?: string }> };
  if (Array.isArray(row.hits)) return row.hits.map((hit) => hit.snippet ?? "").filter(Boolean).slice(0, 4);
  if (Array.isArray(row.works)) return row.works.map((work) => work.title ?? "").filter(Boolean).slice(0, 4);
  return undefined;
}

export function mockTitle(prompt: string) {
  const words = prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" ");
  return words ? words.replace(/[.?!,:;]+$/, "") : "New chat";
}
