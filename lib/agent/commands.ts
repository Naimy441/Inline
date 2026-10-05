/**
 * Slash commands for the Claude panel: "/proofread" sends a saved prompt.
 * Built-in commands ship with Inline; the user can add their own (stored on
 * the server next to their documents). Shared by the panel and the server.
 */

export type SlashCommand = { name: string; description: string; prompt: string; builtin?: boolean };

export const COMMAND_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "proofread", description: "Fix spelling, grammar and punctuation", prompt: "Proofread the document and fix spelling, grammar and punctuation. Don't change the meaning or voice." },
  { name: "tighten", description: "Cut filler and repetition", prompt: "Tighten the writing: cut filler and repetition, and make sentences clearer without losing anything important." },
  { name: "feedback", description: "Three most important suggestions", prompt: "Read the document and give me your three most important suggestions to improve it. Don't edit yet." },
  { name: "outline", description: "Draft an outline from what's here", prompt: "Draft an outline for this document based on what's here so far." },
  { name: "continue", description: "Keep writing in the same style", prompt: "Continue writing from where the document leaves off, matching its style." },
  { name: "format", description: "Clean up headings, lists and spacing", prompt: "Improve the formatting: consistent headings, lists where they help, and clean spacing. Don't change the wording." },
  { name: "summarize", description: "Summarize the document in the chat", prompt: "Summarize the document in a few bullet points in the chat. Don't edit it." },
  {
    name: "comments",
    description: "Address every open comment",
    prompt:
      "Work through every open comment in the document (list_comments). For each one: make the change it asks for if it's clear, reply briefly with what you changed and resolve it; if it's a question or you're unsure, reply with your answer or question and leave it open. Finish with a short summary.",
  },
  {
    name: "cite",
    description: "Find sources and add citations",
    prompt:
      "Find reliable sources for the document's factual claims with web search. Add inline citations in the document's existing style (or (Author, Year) if it has none) and a References section at the end with full entries. Don't change the claims themselves; comment on any you couldn't support.",
  },
  { name: "deslop", description: "Remove AI-sounding phrasing", prompt: "Run analyze_writing and rewrite any passages that sound generic or AI-written, keeping the meaning and the author's voice." },
];

/** All commands, the user's first so they can override a built-in by name. */
export function mergeCommands(custom: readonly SlashCommand[]): SlashCommand[] {
  const names = new Set(custom.map((command) => command.name));
  return [...custom.map((command) => ({ ...command, builtin: false })), ...BUILTIN_COMMANDS.filter((command) => !names.has(command.name)).map((command) => ({ ...command, builtin: true }))];
}

/** "/proofread only the intro" → the proofread prompt plus "only the intro". Unknown commands are sent as typed. */
export function expandSlashCommand(text: string, commands: readonly SlashCommand[]): string {
  const match = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return text;
  const command = commands.find((item) => item.name === match[1]!.toLowerCase());
  if (!command) return text;
  const extra = match[2]?.trim();
  return extra ? `${command.prompt}\n\n${extra}` : command.prompt;
}

/** Commands matching what's been typed after "/" (prefix matches first). */
export function matchCommands(query: string, commands: readonly SlashCommand[]) {
  const q = query.toLowerCase();
  const prefix = commands.filter((command) => command.name.startsWith(q));
  const rest = commands.filter((command) => !command.name.startsWith(q) && (command.name.includes(q) || command.description.toLowerCase().includes(q)));
  return [...prefix, ...rest];
}

/** Documents matching what's been typed after "@": title prefix first, then word starts, then anywhere. */
export function matchDocuments<T extends { id: string; title: string }>(query: string, documents: readonly T[]): T[] {
  const q = query.toLowerCase();
  const rank = (title: string) => {
    const t = title.toLowerCase();
    if (t.startsWith(q)) return 0;
    if (t.split(/\s+/).some((word) => word.startsWith(q))) return 1;
    return t.includes(q) ? 2 : -1;
  };
  return documents
    .map((doc) => ({ doc, rank: rank(doc.title) }))
    .filter((item) => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((item) => item.doc);
}
