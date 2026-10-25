/**
 * The video's timeline and narration. scripts/voiceover.ts generates one clip per sentence and
 * lays them out; each scene lasts until its last line ends plus `tail` seconds (or `min`).
 * Scene components place their visuals on the frame each sentence starts (see useLines).
 */
export interface Scene {
  id: string;
  title: string;
  /** Narration; one ElevenLabs clip per sentence. */
  vo: string;
  /** What's on screen, for SCRIPT.md. */
  visual: string;
  /** Seconds of silence before the first line. */
  lead?: number;
  /** Seconds held after the last line. */
  tail?: number;
  /** Minimum scene length in seconds. */
  min?: number;
  /** Extra pause in seconds before a given sentence index. */
  pauses?: Record<number, number>;
}

export const FPS = 30;

export const SCENES: Scene[] = [
  {
    id: 'open',
    min: 20,
    title: 'Cold open',
    visual: 'A code editor where an agent edits a Markdown file, then a document page the agent cannot reach.',
    vo: "AI agents have become remarkable writing partners. In a code editor, they read a whole project, make precise edits, and check their own work. But most of the writing that matters doesn't live in a code editor. It lives on the page.",
    lead: 0.8,
    pauses: { 2: 0.6 },
    tail: 1.2,
  },
  {
    id: 'title',
    min: 6.5,
    title: 'Title',
    visual: 'Inline mark and wordmark. "Real documents, with Claude Code and Codex built in."',
    vo: 'This is Inline.',
    lead: 0.9,
    tail: 3.4,
  },
  {
    id: 'idea',
    min: 22,
    title: 'The idea',
    visual: 'You, the page and the agent; document tools flow between them; an edit arrives as a tracked change.',
    vo: "Inline is a paginated document editor with Claude Code and Codex built in. The agent works on the same page you do, through more than forty document tools. And every edit it makes is a suggestion you can review. It's free, and open source.",
    tail: 1.4,
  },
  {
    id: 'desktop',
    min: 12,
    title: 'Desktop app',
    visual: 'The Inline desktop app opens on macOS; Mac, Windows and Linux badges.',
    vo: "It runs as a desktop app on Mac, Windows, and Linux, with everything included. Let's open a real account.",
    lead: 0.8,
    tail: 1.6,
  },
  {
    id: 'home',
    min: 22,
    title: 'Home',
    visual: 'Home: color-coded folders with page previews, templates, folder view, search for "launch".',
    vo: 'This is home. Documents live in color-coded folders, with live previews of their pages. Templates cover essays, MLA papers, reports, résumés and more. And search finds any document in a keystroke.',
    tail: 1.6,
  },
  {
    id: 'editor',
    min: 22,
    title: 'The editor',
    visual: 'The thesis proposal scrolls: title, live table of contents, citations, equation, table, figure, headers and page numbers.',
    vo: "Open a thesis proposal and you get real pages. A live table of contents, citations, LaTeX equations, tables and figures, with headers and page numbers. Everything you'd expect from a word processor.",
    tail: 1.4,
  },
  {
    id: 'chat',
    min: 34,
    title: 'Claude in the document',
    visual: 'Command J opens Claude. "Tighten the introduction." Tracked changes appear on the page; Keep all.',
    vo: "Press Command J, and Claude joins you. Ask it to tighten the introduction. Claude reads the document and edits the page directly. Every change appears as a tracked suggestion: deletions struck through, additions highlighted. It even noticed a citation that doesn't match its source. Keep what you like and undo the rest, one change at a time, or all at once.",
    tail: 1.2,
  },
  {
    id: 'select',
    min: 22,
    title: 'Ask about a selection',
    visual: 'A paragraph is selected, Command L adds it to the chat, Claude checks the source and rewrites the sentence.',
    vo: 'Select a passage and press Command L to ask about just that part. Here, Claude checks the claim against the paper, finds the right hurricane, and rewrites the sentence, with its sources.',
    tail: 1.4,
  },
  {
    id: 'comments',
    min: 20,
    title: 'Comments',
    visual: "The advisor's three comments; Claude addresses them, replies in each thread and resolves it.",
    vo: "Comments work the way you'd expect. My advisor left three. Ask Claude to address them, and it fixes each one in the text, replies in the thread, and resolves it.",
    tail: 1.6,
  },
  {
    id: 'history',
    min: 14,
    title: 'Versions',
    visual: 'Version history: a named version is saved, then the first draft opens for comparison.',
    vo: 'Save named versions as you go, and open any earlier draft to compare it or restore it. Every reply from the agent leaves a restore checkpoint, too.',
    tail: 1.4,
  },
  {
    id: 'providers',
    min: 13,
    title: 'Claude or Codex',
    visual: 'The model menu: provider Claude or Codex, and every model; switching to Codex.',
    vo: 'Prefer Codex? Switch providers or models in the middle of a conversation. The next model picks up the same transcript, and the same document.',
    tail: 1.4,
  },
  {
    id: 'canvas',
    min: 17,
    title: 'Canvas',
    visual: 'A designed field guide Canvas: cover, three columns, an equation box and a table; a heading is edited by hand.',
    vo: 'When the layout is part of the message, use a Canvas. The agent designs editable pages with columns, color, and type, and you can still click in and change any word.',
    tail: 1.4,
  },
  {
    id: 'pdf',
    min: 23,
    title: 'PDF import',
    visual: 'A lecture PDF is imported; the conversion runs in the chat; original and rebuilt page side by side.',
    vo: 'Import a PDF, and Inline matches its page size, fonts, and margins. Then Claude rebuilds each page as editable text, with equations in LaTeX, and checks its work against the original, side by side.',
    tail: 1.6,
  },
  {
    id: 'organize',
    min: 15,
    title: 'Organize with AI',
    visual: 'Eight unfiled documents; Organize with AI files them into the four folders.',
    vo: 'Back home, Organize with AI files everything into folders in seconds. It reads only titles and first lines, so it barely touches your usage.',
    tail: 1.4,
  },
  {
    id: 'files',
    min: 18,
    title: 'Your files',
    visual: 'A Finder window of the Word copies in Documents/Inline; export formats; Google Docs import.',
    vo: 'Your documents stay yours. Inline keeps a Word copy of every one in a folder on your computer, exports to PDF, Markdown and more, and brings in your whole Google Drive from a single zip.',
    tail: 1.4,
  },
  {
    id: 'mcp',
    min: 19,
    title: 'Claude Code over MCP',
    visual: 'A terminal running Claude Code with the Inline MCP server beside the app; the edit lands live.',
    vo: 'And because Inline speaks MCP, Claude Code in your terminal can work on your documents too. Ask from the command line, and watch the edit land on the page.',
    tail: 1.8,
  },
  {
    id: 'outro',
    min: 15,
    title: 'Outro',
    visual: 'Mark, tagline, github.com/Naimy441/Inline and platform badges.',
    vo: 'Inline. Real documents, with the agent built in. Free and open source, for Mac, Windows, and Linux.',
    lead: 1.0,
    pauses: { 1: 0.4 },
    tail: 4.5,
  },
];

/** Splits narration into sentences (one clip each). */
export function sentences(vo: string): string[] {
  return vo.match(/[^.!?]+[.!?]+["”']?/g)!.map((s) => s.trim());
}
