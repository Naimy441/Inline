import { leftoverWhitespaceIssues, blankPageIssues, messyFormattingIssues, markdownListIssues, markdownTableIssues, gradeLength, gradePromptLength, PAGE_WORDS } from "@/lib/writing/documentQuality";
import type { AgentEditDraft, DocumentPageSlice } from "@/lib/agent/types";

export const MESSY_MULTI_PAGE = [
  "   HELLO AND WELCOME TO THIS VERY LOUD DRAFT THAT NEVER CALMS DOWN",
  "",
  "",
  "",
  "this   paragraph    has    wild     spacing and",
  "broken",
  "lines",
  "everywhere.",
  "",
  "",
  "Page two starts here with another   mess.",
  "",
  "",
  "",
  "AND THEN THIS SHOUTS AGAIN FOR NO REASON AT ALL WHILE RUNNING ON AND ON",
  "",
  "   trailing junk   ",
].join("\n");

export const CLEAN_MULTI_PAGE = [
  "Hello and welcome to this draft that has been brought back to a readable volume.",
  "",
  "This paragraph has normal spacing and the broken lines have been joined into prose.",
  "",
  "Page two starts here with another cleaned paragraph.",
  "",
  "Then this section continues in sentence case instead of shouting.",
].join("\n");

export const LIST_SOURCE = ["Milk", "Eggs", "Sourdough", "Olive oil"].join("\n\n");
export const NUMBERED_SOURCE = ["Preheat the oven.", "Mix the batter.", "Bake for twelve minutes.", "Cool on a rack."].join("\n\n");
export const TABLE_SOURCE = "Name, Role, Team\nAda, Engineer, Atlas\nLin, Editor, North";
export const FORMAT_SOURCE = "The river was wide and slow.\n\nA second paragraph waits for a heading.";

export type LiveGradeCtx = {
  prompt: string;
  text: string;
  pages: DocumentPageSlice[];
  editor: HTMLElement;
  io: {
    header: string;
    footer: string;
    showHeader: boolean;
    showFooter: boolean;
    showPageNumbers: boolean;
    pageNumberLocation: "header" | "footer";
    printed: boolean;
  };
  tools: string[];
  edits: AgentEditDraft[];
};

export type LiveCase = {
  id: string;
  prompt: string;
  document: string;
  pages?: DocumentPageSlice[];
  grade: (ctx: LiveGradeCtx) => string[];
};

export const LIVE_CASES: LiveCase[] = [
  {
    id: "highlight-yellow",
    prompt: 'Highlight the word "river" in yellow.',
    document: FORMAT_SOURCE,
    grade: ({ editor, tools }) => {
      const issues: string[] = [];
      if (!tools.includes("highlight_text")) issues.push("did not call highlight_text");
      if (!/background-color|#fff3b0|rgb\(255,\s*243,\s*176\)|#ff0|yellow/i.test(editor.innerHTML)) {
        issues.push("no highlight color in the editor");
      }
      return issues;
    },
  },
  {
    id: "text-color-red",
    prompt: 'Make the words "second paragraph" red.',
    document: FORMAT_SOURCE,
    grade: ({ editor, tools }) => {
      const issues: string[] = [];
      if (!tools.includes("set_text_color")) issues.push("did not call set_text_color");
      if (!/color:|#c00|#cc0000|#ff0000|rgb\(2?0?4,\s*0,\s*0\)|rgb\(255,\s*0,\s*0\)/i.test(editor.innerHTML)) {
        issues.push("no red text color in the editor");
      }
      return issues;
    },
  },
  {
    id: "font-georgia-18",
    prompt: 'Set the first paragraph in Georgia at 18pt.',
    document: FORMAT_SOURCE,
    grade: ({ editor, tools }) => {
      const issues: string[] = [];
      if (!tools.includes("set_font_family")) issues.push("did not call set_font_family");
      if (!tools.includes("set_font_size")) issues.push("did not call set_font_size");
      if (!/georgia/i.test(editor.innerHTML)) issues.push("Georgia not applied");
      if (!/18pt|24px/i.test(editor.innerHTML)) issues.push("18pt not applied");
      return issues;
    },
  },
  {
    id: "bold-italic-underline",
    prompt: 'Bold "river", italicize "wide", and underline "slow".',
    document: FORMAT_SOURCE,
    grade: ({ editor, tools }) => {
      const issues: string[] = [];
      if (!tools.includes("toggle_bold")) issues.push("did not call toggle_bold");
      if (!tools.includes("toggle_italic")) issues.push("did not call toggle_italic");
      if (!tools.includes("toggle_underline")) issues.push("did not call toggle_underline");
      if (!/<(strong|b)\b/i.test(editor.innerHTML) && !/font-weight:\s*(bold|700)/i.test(editor.innerHTML)) {
        issues.push("no bold markup");
      }
      if (!/<(em|i)\b/i.test(editor.innerHTML) && !/font-style:\s*italic/i.test(editor.innerHTML)) {
        issues.push("no italic markup");
      }
      if (!/<u\b/i.test(editor.innerHTML) && !/underline/i.test(editor.innerHTML)) {
        issues.push("no underline markup");
      }
      return issues;
    },
  },
  {
    id: "header-footer-page-numbers",
    prompt: "Add header text 'Quarterly Review', footer text 'Confidential', and page numbers in the footer.",
    document: FORMAT_SOURCE,
    grade: ({ io, tools }) => {
      const issues: string[] = [];
      if (!tools.includes("add_header")) issues.push("did not call add_header");
      if (!tools.includes("add_footer")) issues.push("did not call add_footer");
      if (!tools.includes("add_page_numbers")) issues.push("did not call add_page_numbers");
      if (!/quarterly review/i.test(io.header)) issues.push(`header is ${JSON.stringify(io.header)}`);
      if (!/confidential/i.test(io.footer)) issues.push(`footer is ${JSON.stringify(io.footer)}`);
      if (!io.showPageNumbers) issues.push("page numbers not shown");
      if (io.pageNumberLocation !== "footer") issues.push(`page numbers in ${io.pageNumberLocation}`);
      return issues;
    },
  },
  {
    id: "center-heading",
    prompt: 'Turn the first sentence into a centered Heading 1.',
    document: FORMAT_SOURCE,
    grade: ({ editor, tools }) => {
      const issues: string[] = [];
      if (!tools.includes("set_block_style")) issues.push("did not call set_block_style");
      if (!tools.includes("set_alignment")) issues.push("did not call set_alignment");
      if (!editor.querySelector("h1, .style-h1, .style-title")) issues.push("no heading style");
      const centered = [...editor.querySelectorAll<HTMLElement>("h1, div, p")].some((el) => el.style.textAlign === "center");
      if (!centered) issues.push("nothing centered");
      return issues;
    },
  },
  {
    id: "bullets",
    prompt: "Turn these four items into a bulleted list.",
    document: LIST_SOURCE,
    grade: ({ editor, text, tools }) => {
      const issues: string[] = [];
      if (!tools.includes("toggle_list") && markdownListIssues(text, "ul", 4).length) {
        issues.push("did not build a bulleted list");
      }
      const items = editor.querySelectorAll("ul li").length;
      if (items < 4 && markdownListIssues(text, "ul", 4).length) {
        issues.push(`only ${items} list items in the editor`);
      }
      return issues;
    },
  },
  {
    id: "numbered-list",
    prompt: "Turn these steps into a numbered list.",
    document: NUMBERED_SOURCE,
    grade: ({ editor, text, tools }) => {
      const issues: string[] = [];
      if (!tools.includes("toggle_list") && markdownListIssues(text, "ol", 4).length) {
        issues.push("did not build a numbered list");
      }
      const items = editor.querySelectorAll("ol li").length;
      if (items < 4 && markdownListIssues(text, "ol", 4).length) {
        issues.push(`only ${items} numbered items in the editor`);
      }
      return issues;
    },
  },
  {
    id: "table",
    prompt: "Turn this CSV into a 3-column table with a header row and the two people as data rows.",
    document: TABLE_SOURCE,
    grade: ({ editor, text, tools }) => {
      const issues: string[] = [];
      const table = editor.querySelector("table");
      const rows = table?.querySelectorAll("tr").length ?? 0;
      const cells = table?.querySelectorAll("td, th").length ?? 0;
      if (!tools.includes("insert_table") && markdownTableIssues(text, 3, 3).length) {
        issues.push("did not insert a table");
      }
      if (table && (rows < 2 || cells < 6)) issues.push(`table is ${rows} rows / ${cells} cells`);
      return issues;
    },
  },
  {
    id: "page-break",
    prompt: 'Insert a page break after the first paragraph.',
    document: FORMAT_SOURCE,
    grade: ({ editor, tools }) => {
      const issues: string[] = [];
      if (!tools.includes("insert_page_break")) issues.push("did not call insert_page_break");
      if (!editor.querySelector("[data-manual-break]")) issues.push("no manual page break");
      return issues;
    },
  },
  {
    id: "delete-middle-clean",
    prompt: "Delete the middle paragraph about the old warehouse. Do not leave extra blank lines or a blank page.",
    document: "Opening stays.\n\nThe old warehouse is damp and should be removed entirely from this draft.\n\nClosing stays.",
    pages: pageTriple("Opening stays.\n\n", "The old warehouse is damp and should be removed entirely from this draft.\n\n", "Closing stays."),
    grade: ({ text, pages }) => [
      ...leftoverWhitespaceIssues(text),
      ...blankPageIssues(pages),
      ...(text.includes("warehouse") ? ["warehouse paragraph still present"] : []),
      ...(!/Opening stays/.test(text) || !/Closing stays/.test(text) ? ["kept paragraphs were damaged"] : []),
    ],
  },
  {
    id: "cleanup-messy-pages",
    prompt: "Clean up this poorly formatted multi-page draft. Fix extra spaces, extra blank lines, broken short lines, and shouting caps. Keep the meaning. Do not leave blank pages.",
    document: MESSY_MULTI_PAGE,
    pages: pageTriple(
      MESSY_MULTI_PAGE.slice(0, 120),
      MESSY_MULTI_PAGE.slice(120, 260),
      MESSY_MULTI_PAGE.slice(260),
    ),
    grade: ({ text, pages }) => [...messyFormattingIssues(text), ...blankPageIssues(pages)],
  },
  {
    id: "two-paragraphs",
    prompt: "Replace the draft with exactly two paragraphs about morning coffee.",
    document: "Placeholder.",
    grade: ({ text, prompt }) => lengthIssues(prompt, text),
  },
  {
    id: "five-sentences",
    prompt: "Replace the draft with exactly five sentences about a coastal town.",
    document: "Placeholder.",
    grade: ({ text }) => {
      const grade = gradeLength(text, { kind: "sentences", value: 5 });
      return grade.ok ? leftoverWhitespaceIssues(text) : [grade.detail, ...leftoverWhitespaceIssues(text)];
    },
  },
  {
    id: "one-page-exact",
    prompt: `Write exactly one page about public libraries. Aim for about ${PAGE_WORDS} words, not two pages and not a short note.`,
    document: "",
    grade: ({ text }) => {
      const grade = gradeLength(text, { kind: "one_page_exact" });
      return grade.ok ? leftoverWhitespaceIssues(text) : [grade.detail];
    },
  },
  {
    id: "one-page-brim",
    prompt: `Fill one page to the brim about street trees. Use about ${PAGE_WORDS} words so the page is full but does not spill onto a second page.`,
    document: "",
    grade: ({ text }) => {
      const grade = gradeLength(text, { kind: "one_page_brim" });
      return grade.ok ? leftoverWhitespaceIssues(text) : [grade.detail];
    },
  },
];

function lengthIssues(prompt: string, text: string) {
  const parsed = gradePromptLength(prompt, text);
  return parsed.ok ? leftoverWhitespaceIssues(text) : [parsed.detail, ...leftoverWhitespaceIssues(text)];
}

function pageTriple(a: string, b: string, c: string): DocumentPageSlice[] {
  const text = `${a}${b}${c}`;
  return [
    { number: 1, start: 0, end: a.length, text: a },
    { number: 2, start: a.length, end: a.length + b.length, text: b },
    { number: 3, start: a.length + b.length, end: text.length, text: c },
  ];
}
