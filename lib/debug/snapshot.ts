import type { AgentChat, AgentTimelineItem, AgentTurn } from "@/lib/agent/types";

export type DebugDocumentChrome = {
  fontFamily: string;
  fontSize: string;
  lineSpacing: string;
  columns: number;
  pageLayout: {
    paperSize: string;
    width: number;
    height: number;
    marginTop: number;
    marginRight: number;
    marginBottom: number;
    marginLeft: number;
  };
  header: { show: boolean; text: string; align: string; firstPageText: string };
  footer: { show: boolean; text: string; align: string; firstPageText: string };
  pageNumbers: { show: boolean; location: string };
  differentFirstPage: boolean;
};

export type DebugSnapshotInput = {
  capturedAt: string;
  url: string;
  documentId: string;
  title: string;
  pages: number;
  words: number;
  chars: number;
  chrome: DebugDocumentChrome;
  comments: Array<{ id: string; quote: string; body: string }>;
  text: string;
  html: string;
  chats: AgentChat[];
  activeChatId: string;
  composerDraft: string;
  attachments: Array<{ name: string; chars: number }>;
  live?: {
    busy: boolean;
    phase: string | null;
    prompt: string;
    thinking: string;
    message: string;
    tools: string[];
    error: string | null;
    timeline?: AgentTimelineItem[];
  };
};

export function redactEmbeddedData(html: string) {
  return html.replace(/data:(image\/[a-z0-9.+-]+)?;base64,[a-z0-9+/=\s]+/gi, (match) => {
    const mime = match.match(/^data:([^;]*);/i)?.[1] || "unknown";
    return `data:${mime};base64,[redacted ${match.length} chars]`;
  });
}

export function countHtmlClasses(html: string) {
  const counts: Record<string, number> = {};
  for (const match of html.matchAll(/\bclass="([^"]*)"/gi)) {
    for (const name of match[1].split(/\s+/)) {
      if (!name) continue;
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export function formatInlineDebugSnapshot(input: DebugSnapshotInput) {
  const html = redactEmbeddedData(input.html);
  const classes = countHtmlClasses(html);
  const classLine = Object.keys(classes).length
    ? Object.entries(classes)
        .slice(0, 24)
        .map(([name, count]) => `${name}×${count}`)
        .join(", ")
    : "(none)";
  const chats = [...input.chats].sort((a, b) => {
    if (a.id === input.activeChatId) return -1;
    if (b.id === input.activeChatId) return 1;
    return b.updatedAt - a.updatedAt;
  });

  const lines = [
    "INLINE_DEBUG_SNAPSHOT v1",
    `Captured: ${input.capturedAt}`,
    `URL: ${input.url}`,
    "",
    "## Document",
    `- id: ${input.documentId}`,
    `- title: ${input.title || "Untitled document"}`,
    `- pages: ${input.pages}, words: ${input.words}, chars: ${input.chars}`,
    `- font: ${input.chrome.fontFamily} ${input.chrome.fontSize}, spacing ${input.chrome.lineSpacing}, columns ${input.chrome.columns}`,
    `- paper: ${input.chrome.pageLayout.paperSize} ${Math.round(input.chrome.pageLayout.width)}×${Math.round(input.chrome.pageLayout.height)}px, margins T${input.chrome.pageLayout.marginTop} R${input.chrome.pageLayout.marginRight} B${input.chrome.pageLayout.marginBottom} L${input.chrome.pageLayout.marginLeft}`,
    `- header: ${fmtChrome(input.chrome.header.show, input.chrome.header.text, input.chrome.header.align)}`,
    `- footer: ${fmtChrome(input.chrome.footer.show, input.chrome.footer.text, input.chrome.footer.align)}`,
    `- first page header: ${input.chrome.header.firstPageText || "(empty)"}`,
    `- first page footer: ${input.chrome.footer.firstPageText || "(empty)"}`,
    `- page numbers: ${input.chrome.pageNumbers.show ? input.chrome.pageNumbers.location : "off"}`,
    `- different first page: ${input.chrome.differentFirstPage}`,
    `- html classes: ${classLine}`,
    `- comments: ${input.comments.length}`,
    `- attachments: ${input.attachments.length ? input.attachments.map((item) => `${item.name} (${item.chars} chars)`).join(", ") : "(none)"}`,
    "",
  ];

  if (input.comments.length) {
    lines.push("### Comments");
    for (const comment of input.comments) {
      lines.push(`- ${comment.quote.slice(0, 120)} — ${comment.body}`);
    }
    lines.push("");
  }

  lines.push("### Plain text", fence("text", input.text || "(empty)"), "", "### HTML", fence("html", html || "(empty)"), "");

  if (input.live?.busy || input.live?.error) {
    lines.push("## Live turn");
    lines.push(`- busy: ${Boolean(input.live.busy)}, phase: ${input.live.phase || "(none)"}`);
    if (input.live.prompt) lines.push(`- prompt: ${oneLine(input.live.prompt)}`);
    if (input.live.tools.length) lines.push(`- tools: ${input.live.tools.join(", ")}`);
    if (input.live.error) lines.push(`- error: ${input.live.error}`);
    if (input.live.timeline?.length) lines.push(`- timeline: ${timelineLine(input.live.timeline)}`);
    if (input.live.thinking) lines.push("", "### Live thinking", fence("text", input.live.thinking));
    if (input.live.message) lines.push("", "### Live message", fence("text", input.live.message));
    lines.push("");
  }

  lines.push(`## Chats (${chats.length})`, `Active: ${input.activeChatId || "(none)"}`, `Composer draft: ${input.composerDraft ? oneLine(input.composerDraft) : "(empty)"}`, "");

  if (!chats.length) lines.push("(no chats)", "");
  for (const chat of chats) {
    const active = chat.id === input.activeChatId ? " (active)" : "";
    lines.push(
      `### Chat: ${chat.title || "New chat"}${active}`,
      `- id: ${chat.id}`,
      `- model: ${chat.model}, thinking: ${chat.thinkingLevel}, mode: ${chat.mode}`,
      `- turns: ${chat.turns.length}`,
      `- continuation: ${chat.continuation ? `${chat.continuation.provider}${chat.continuation.openaiResponseId ? " +thread" : ""}` : "none"}`,
    );
    if (chat.tasks?.length) {
      lines.push(`- tasks: ${chat.tasks.map((task) => `${task.status}:${task.title}`).join("; ")}`);
    }
    lines.push("");
    chat.turns.forEach((turn, index) => lines.push(...formatTurn(turn, index + 1), ""));
  }

  return lines.join("\n").trim() + "\n";
}

export async function copyText(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") throw new Error("Clipboard is not available.");
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("Copy failed.");
}

function formatTurn(turn: AgentTurn, index: number) {
  const lines = [
    `#### Turn ${index}`,
    `- duration: ${turn.durationMs ?? "?"}ms, model: ${turn.model}, mode: ${turn.mode}${turn.mock ? ", mock" : ""}`,
  ];
  if (turn.error) lines.push(`- error: ${turn.error}`);
  if (turn.tools?.length) lines.push(`- tools: ${turn.tools.map((tool) => tool.name).join(", ")}`);
  if (turn.timeline?.length) lines.push(`- timeline: ${timelineLine(turn.timeline)}`);
  else if (turn.thinking || turn.tools?.length) {
    lines.push(`- timeline: ${[turn.thinking ? "thinking" : "", ...(turn.tools ?? []).map((tool) => tool.name)].filter(Boolean).join(" → ")}`);
  }
  if (turn.selection) lines.push(`- selection: ${oneLine(turn.selection)}`);
  if (turn.edits.length) {
    lines.push(`- edits: ${turn.edits.length}`);
    for (const edit of turn.edits) {
      lines.push(
        `  - [${edit.status}] ${edit.operation || "replace"} find=${clip(edit.find)} replace=${clip(edit.replace)}${edit.reason ? ` (${edit.reason})` : ""}`,
      );
    }
  }
  if (turn.citations?.length) {
    lines.push(`- citations: ${turn.citations.map((item) => item.inline || item.title).join("; ")}`);
  }
  lines.push("", "User", fence("text", turn.prompt || "(empty)"));
  if (turn.thinking) lines.push("", "Thinking", fence("text", turn.thinking));
  if (turn.message) lines.push("", "Assistant", fence("text", turn.message));
  return lines;
}

function timelineLine(items: AgentTimelineItem[]) {
  return items
    .map((item) => (item.kind === "thinking" ? "thinking" : item.step.title || item.step.name || "step"))
    .join(" → ");
}

function fmtChrome(show: boolean, text: string, align: string) {
  if (!show) return "off";
  return `${align} ${text.trim() || "(empty)"}`;
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function clip(value: string, max = 160) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return JSON.stringify(clean);
  return JSON.stringify(`${clean.slice(0, max)}…`);
}

function fence(lang: string, body: string) {
  let ticks = "```";
  while (body.includes(ticks)) ticks += "`";
  return `${ticks}${lang}\n${body}\n${ticks}`;
}
