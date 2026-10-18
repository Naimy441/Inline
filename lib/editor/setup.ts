import { canvasDesignPlugin } from "@/lib/canvas/editor";
import { canvasBlockHandlesPlugin } from "@/lib/canvas/handles";
import { collab } from "prosemirror-collab";
import { baseKeymap, chainCommands, exitCode, joinDown, joinUp, selectParentNode } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { ellipsis, emDash, InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { Fragment, Slice, type MarkType } from "prosemirror-model";
import { findWrapping } from "prosemirror-transform";
import { splitListItem } from "prosemirror-schema-list";
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { columnResizing, goToNextCell, tableEditing } from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";
import { blockIdFixes } from "@/lib/doc/ids";
import { parseMarkdown } from "@/lib/doc/markdown";
import { schema } from "@/lib/doc/schema";
import { BUILTIN_STYLES, type ParagraphStyle } from "@/lib/doc/styles";
import { DEFAULT_TAB_STOP } from "@/lib/doc/settings";
import {
  clearFormatting,
  followLink,
  indent,
  insertTab,
  goToDocumentEdge,
  insertPageBreak,
  outdent,
  setAlign,
  setBlock,
  splitWithNextStyle,
  toggle,
  toggleBlockquote,
  toggleList,
  toggleTask,
} from "@/lib/editor/commands";
import { commentsPlugin } from "@/lib/editor/comments";
import { imageSelectionPlugin } from "@/lib/editor/imageView";
import { deleteSelectedPicture } from "@/lib/editor/pictureEdit";
import { findPlugin } from "@/lib/editor/find";
import { spellingPlugin } from "@/lib/editor/spelling";
import { invisiblesPlugin } from "@/lib/editor/invisibles";
import { autolinkPlugin } from "@/lib/editor/autolink";
import { inMath, mathInputRules, mathPlugin } from "@/lib/editor/math";
import { paginationPlugin, type PageGeometry, type PageLayout } from "@/lib/editor/pagination";
import { tocSyncPlugin } from "@/lib/editor/tocView";
import { InlineTableView, tableBorderPlugin, tableFormulaPlugin } from "@/lib/editor/tables";
import { bordersPlugin } from "@/lib/editor/borders";
import { lineFitPlugin } from "@/lib/editor/lineFit";
import { tabsPlugin } from "@/lib/editor/tabs";
import { endWithTextblock, pasteIntoEmptyTextblock, transformPastedHtml } from "@/lib/editor/paste";
import { syncDomSelection } from "@/lib/editor/domSync";
import { formatSelectionPlugin } from "@/lib/editor/formatSelection";
import { imageClipboardPlugin } from "@/lib/editor/imageClipboard";
import { justifyPlugin } from "@/lib/editor/justify";
import { placeholderPlugin } from "@/lib/editor/placeholder";
import { presencePlugin } from "@/lib/editor/presence";
import { reviewPlugin, type ReviewHandlers } from "@/lib/editor/review";
import { isApple } from "@/lib/client/platform";

const nodes = schema.nodes;

/** Give blocks created by splitting or pasting their own ids, as the server would. */
function blockIdPlugin() {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const fixes = blockIdFixes(state.doc);
      if (!fixes) return null;
      const tr = state.tr;
      for (const step of fixes.steps) tr.step(step);
      return tr.setMeta("addToHistory", false);
    },
  });
}

/** Enter in a footnote copies its label onto the new paragraph; keep the label on the first one only. */
function footnoteLabelPlugin() {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const seen = new Set<string>();
      const clear: number[] = [];
      state.doc.descendants((node, pos) => {
        if (!node.isBlock) return;
        const label = node.attrs.footnote as string | null;
        if (!label) return;
        if (seen.has(label)) clear.push(pos);
        else seen.add(label);
      });
      if (!clear.length) return null;
      const tr = state.tr;
      for (let i = clear.length - 1; i >= 0; i -= 1) {
        const pos = clear[i]!;
        const node = tr.doc.nodeAt(pos);
        if (node?.attrs.footnote) tr.setNodeMarkup(pos, undefined, { ...node.attrs, footnote: null });
      }
      return tr;
    },
  });
}

function markInputRule(pattern: RegExp, type: MarkType) {
  return new InputRule(pattern, (state, match, start, end) => {
    const text = match[2];
    if (!text || inMath(state, start) || inMath(state, end)) return null;
    const tr = state.tr;
    const textStart = start + match[0].indexOf(match[1]!);
    tr.replaceWith(textStart, end, schema.text(text, [...state.doc.resolve(start).marks(), type.create()]));
    tr.removeStoredMark(type);
    return tr;
  });
}

/** Inline code keeps the typed quote. Code blocks never reach these rules. */
function inInlineCode(state: EditorState, pos: number) {
  const marks = state.storedMarks ?? state.doc.resolve(pos).marks();
  return marks.some((mark) => mark.type === schema.marks.code);
}

/**
 * A straight quote opens at the start of a word and closes at the end.
 * Whitespace, a line break (U+FFFC in the text the input rules see), an
 * opening bracket, or an opening quote starts a word. A quote after a
 * sentence end still closes when it finishes one that is already open, so
 * `" a. "` becomes `“ a. ”`. Quotes that are already curly are never rewritten.
 */
function opensQuote(before: string, open: string, close: string) {
  if (!before) return true;
  const prev = before[before.length - 1]!;
  if (!/[\s\uFFFC{\[(<'"\u2018\u201C]/.test(prev)) return false;
  if (/[.!?][ \t\u00A0]+$/.test(before)) {
    let openQuotes = 0;
    for (const ch of before) {
      if (ch === open) openQuotes += 1;
      else if (ch === close && openQuotes > 0) openQuotes -= 1;
    }
    if (openQuotes > 0) return false;
  }
  return true;
}

function smartQuoteRule(straight: '"' | "'", open: string, close: string) {
  return new InputRule(straight === '"' ? /"$/ : /'$/, (state, _match, start, end) => {
    if (inInlineCode(state, end)) return null;
    const $pos = state.doc.resolve(end);
    const before = $pos.parent.textBetween(0, $pos.parentOffset, "\n", "\ufffc");
    return state.tr.insertText(opensQuote(before, open, close) ? open : close, start, end);
  });
}

const smartQuoteRules = [smartQuoteRule('"', "“", "”"), smartQuoteRule("'", "‘", "’")];

/**
 * Tools > Automatic substitutions, as you type. Each rule checks the
 * preference when it fires, so turning it off takes effect immediately.
 */
const SUBSTITUTIONS: InputRule[] = [
  ...smartQuoteRules,
  ellipsis,
  emDash,
  new InputRule(/\((?:c|C)\)$/, "©"),
  new InputRule(/\((?:r|R)\)$/, "®"),
  new InputRule(/\((?:tm|TM)\)$/, "™"),
  new InputRule(/->$/, "→"),
  new InputRule(/<-$/, "←"),
  new InputRule(/=>$/, "⇒"),
  new InputRule(/!=$/, "≠"),
  new InputRule(/>=$/, "≥"),
  new InputRule(/<=$/, "≤"),
  new InputRule(/\+\/-$/, "±"),
];

function whenEnabled(rule: InputRule, enabled: () => boolean) {
  const handler = (rule as unknown as { handler: (state: EditorState, match: RegExpMatchArray, start: number, end: number) => Transaction | null }).handler;
  // Never inside an equation's LaTeX, where "->" or "<=" mean what they say.
  return new InputRule((rule as unknown as { match: RegExp }).match, (state, match, start, end) => (enabled() && !inMath(state, start) ? handler(state, match, start, end) : null));
}

function buildInputRules(substitutions: () => boolean) {
  return inputRules({
    rules: [
      ...SUBSTITUTIONS.map((rule) => whenEnabled(rule, substitutions)),
      ...mathInputRules,
      textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading!, (match) => ({ level: match[1]!.length })),
      textblockTypeInputRule(/^```$/, nodes.code_block!),
      wrappingInputRule(/^\s*>\s$/, nodes.blockquote!),
      wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list!),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        nodes.ordered_list!,
        (match) => ({ order: Number(match[1]) }),
        (match, node) => node.childCount + (node.attrs.order as number) === Number(match[1]),
      ),
      new InputRule(/^\[( |x)?\]\s$/, (state, match, start, end) => {
        const tr = state.tr.delete(start, end);
        const range = tr.doc.resolve(start).blockRange();
        const wrapping = range && findWrapping(range, nodes.bullet_list!);
        if (!range || !wrapping) return null;
        tr.wrap(range, wrapping);
        const item = tr.doc.nodeAt(range.start + 1);
        if (item?.type === nodes.list_item) tr.setNodeMarkup(range.start + 1, undefined, { ...item.attrs, checked: match[1] === "x" });
        return tr;
      }),
      new InputRule(/^(?:---|\*\*\*|___)$/, (state, _match, start, end) => {
        const $start = state.doc.resolve(start);
        if ($start.parent.type !== nodes.paragraph || $start.depth !== 1) return null;
        const blockStart = $start.before(1);
        const tr = state.tr.replaceWith(blockStart, $start.after(1), [nodes.horizontal_rule!.create(), nodes.paragraph!.create()]);
        tr.setSelection(TextSelection.near(tr.doc.resolve(blockStart + 2)));
        void end;
        return tr;
      }),
      markInputRule(/(?:^|[^*])(\*\*([^*\s][^*]*[^*\s]|[^*\s])\*\*)$/, schema.marks.bold!),
      markInputRule(/(?:^|[^*])(\*([^*\s][^*]*[^*\s]|[^*\s])\*)$/, schema.marks.italic!),
      markInputRule(/(?:^|[^`])(`([^`]+)`)$/, schema.marks.code!),
      markInputRule(/(?:^|[^~])(~~([^~]+)~~)$/, schema.marks.strike!),
      markInputRule(/(?:^|[^=])(==([^=]+)==)$/, schema.marks.highlight!),
    ],
  });
}

const insertHardBreak: Command = chainCommands(exitCode, (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break!.create()).scrollIntoView());
  return true;
});

/** Leave an empty list item / quote on Enter, like every word processor. */
const liftEmptyBlock: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.content.size) return false;
  for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
    if ($from.node(depth).type === nodes.blockquote) {
      return toggleBlockquote(state, dispatch);
    }
  }
  return false;
};

function buildKeymap(extra: Record<string, Command>, styles: () => readonly ParagraphStyle[]) {
  const mac = isApple();
  const bindings: Record<string, Command> = {
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    ...(mac ? {} : { "Mod-y": redo }),
    "Mod-b": toggle("bold"),
    "Mod-i": toggle("italic"),
    "Mod-u": toggle("underline"),
    "Mod-Shift-x": toggle("strike"),
    "Alt-Shift-5": toggle("strike"),
    "Mod-e": toggle("code"),
    "Mod-.": toggle("superscript"),
    "Mod-,": toggle("subscript"),
    "Mod-\\": clearFormatting,
    "Mod-Alt-0": setBlock("paragraph"),
    "Mod-Alt-1": setBlock("h1"),
    "Mod-Alt-2": setBlock("h2"),
    "Mod-Alt-3": setBlock("h3"),
    "Mod-Alt-4": setBlock("h4"),
    "Mod-Shift-l": setAlign("left"),
    "Mod-Shift-e": setAlign("center"),
    "Mod-Shift-r": setAlign("right"),
    "Mod-Shift-j": setAlign("justify"),
    "Mod-Shift-7": toggleList("ordered"),
    "Mod-Shift-8": toggleList("bullet"),
    "Mod-Shift-9": toggleList("task"),
    "Mod-Shift-.": toggleBlockquote,
    "Mod-Enter": insertPageBreak,
    // Ctrl/⌘+End (and ⌘+Down on a Mac) move the caret in the editor state itself.
    // The browser's own move can land after Enter has already split at the old caret.
    "Mod-End": goToDocumentEdge("end"),
    "Mod-Home": goToDocumentEdge("start"),
    ...(mac ? { "Mod-ArrowDown": goToDocumentEdge("end"), "Mod-ArrowUp": goToDocumentEdge("start") } : {}),
    "Shift-Enter": insertHardBreak,
    Enter: chainCommands(splitListItem(nodes.list_item!), liftEmptyBlock, splitWithNextStyle(styles)),
    // Tab and Shift-Tab never fall through to the browser, which would move focus out of the document.
    Tab: chainCommands(goToNextCell(1), insertTab, indent, () => true),
    "Shift-Tab": chainCommands(goToNextCell(-1), outdent, () => true),
    "Mod-]": indent,
    "Mod-[": outdent,
    "Alt-ArrowUp": joinUp,
    "Alt-ArrowDown": joinDown,
    Escape: selectParentNode,
    // Before the base map, so a selected picture is removed instead of the browser walking into it.
    Backspace: deleteSelectedPicture,
    Delete: deleteSelectedPicture,
    ...extra,
  };
  return keymap(bindings);
}

/** Read the browser caret into the editor state before key commands, so Enter follows Ctrl/⌘+End. */
function readSelectionPlugin() {
  return new Plugin({
    props: {
      handleKeyDown(view) {
        syncDomSelection(view);
        return false;
      },
    },
  });
}

/** Views whose paste in progress starts with a whole Google Docs paragraph (lib/editor/paste.ts). */
const wholeParagraphs = new WeakMap<EditorView, boolean>();

/** Paste plain text that looks like Markdown as rich content, and Google Docs' HTML as Google shows it. */
function markdownPastePlugin(onGooglePaste?: () => void) {
  const looksLikeMarkdown = (text: string) => /(^|\n)(#{1,6} |[-*+] |\d+\. |> |```|\|.+\|)|\[\^[A-Za-z0-9]|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|<cite>/.test(text);
  return new Plugin({
    props: {
      transformPastedHTML(html, view) {
        const result = transformPastedHtml(html);
        wholeParagraphs.set(view, result.paragraphs);
        // Google's clipboard multiple is generic. The page is spaced from the font's own line height.
        if (html.includes("docs-internal-guid")) onGooglePaste?.();
        return result.html;
      },
      transformPasted(slice, view) {
        const whole = wholeParagraphs.get(view);
        wholeParagraphs.delete(view);
        return whole ? pasteIntoEmptyTextblock(slice, view.state) : slice;
      },
      handlePaste(view, _event, slice) {
        // Not on drop: a picture dragged elsewhere moves without a line of its own.
        const ended = endWithTextblock(slice, view.state);
        if (!ended) return false;
        view.dispatch(view.state.tr.replaceSelection(ended).scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"));
        return true;
      },
      clipboardTextParser(text, $context, plain) {
        if (plain || $context.parent.type.spec.code || !looksLikeMarkdown(text)) return null as unknown as Slice;
        try {
          const blocks = parseMarkdown(text);
          if (!blocks.length) return null as unknown as Slice;
          return new Slice(Fragment.from(blocks), 1, 1);
        } catch {
          return null as unknown as Slice;
        }
      },
      handleClick(view, pos, event) {
        // Ctrl/⌘-click follows links, as in other editors.
        if (!(event.metaKey || event.ctrlKey)) return false;
        const link = schema.marks.link!.isInSet(view.state.doc.resolve(pos).marks());
        if (!link) return false;
        event.preventDefault();
        return followLink(link.attrs.href as string)(view.state, view.dispatch);
      },
      handleClickOn(view, _pos, node, nodePos, event) {
        if (node.type === nodes.footnote_ref) {
          const label = node.attrs.label;
          let target = -1;
          view.state.doc.descendants((child, pos) => {
            if (target < 0 && child.attrs.footnote === label) target = pos + 1;
            return target < 0;
          });
          if (target < 0) return false;
          event.preventDefault();
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(target))).scrollIntoView());
          return true;
        }
        // Task checkboxes are drawn with CSS in the left gutter of the item.
        if (node.type !== nodes.list_item || node.attrs.checked == null) return false;
        const target = event.target as HTMLElement;
        const li = target.closest("li.task-item");
        if (!li) return false;
        const rect = li.getBoundingClientRect();
        if (event.clientX > rect.left + 4) return false;
        return toggleTask(nodePos)(view.state, view.dispatch);
      },
    },
  });
}

export type EditorPluginOptions = {
  version: number;
  clientID: string;
  review: ReviewHandlers;
  onActivateComment: (id: string | null) => void;
  geometry: () => PageGeometry;
  /** Points between the default tab stops. */
  tabStop?: () => number;
  /** Laid out as Google Docs lays documents out (settings lineModel "font"): justified text is spaced as Google spaces it. */
  fontLines?: () => boolean;
  /** HTML from Google Docs was pasted. The document should use the font line model. */
  onGooglePaste?: () => void;
  onPages?: (layout: PageLayout) => void;
  keys?: Record<string, Command>;
  /** Named styles, read when Enter splits a paragraph, so the new one can take the style's next style. */
  styles?: () => readonly ParagraphStyle[];
  placeholder?: string;
  /** Viewing mode: local edits are refused (changes from the server still apply). */
  readOnly?: () => boolean;
  substitutions?: () => boolean;
  showInvisibles?: boolean;
  /** Words the user added so they are never underlined as misspelled. */
  dictionary?: string[];
  /** Red spelling underlines. Off when the user hides them. */
  spellcheck?: boolean;
};

function readOnlyPlugin(readOnly: () => boolean) {
  return new Plugin({
    filterTransaction: (tr) => !tr.docChanged || tr.getMeta("rebased") !== undefined || !readOnly(),
  });
}

export function editorPlugins(options: EditorPluginOptions) {
  return [
    readOnlyPlugin(options.readOnly ?? (() => false)),
    buildInputRules(options.substitutions ?? (() => true)),
    autolinkPlugin(),
    // Before the keymaps: the browser caret is in state before Enter or an arrow command reads it.
    readSelectionPlugin(),
    // Before the keymaps: Enter and the arrows mean something else around an equation.
    mathPlugin(),
    buildKeymap(options.keys ?? {}, options.styles ?? (() => BUILTIN_STYLES)),
    keymap(baseKeymap),
    history(),
    dropCursor({ color: "#1a73e8", width: 3 }),
    // Before the gap cursor: a click under a picture is a text caret, which the gap cursor would claim first.
    imageSelectionPlugin(),
    gapCursor(),
    columnResizing({ View: InlineTableView }),
    tableEditing(),
    tableBorderPlugin(),
    tableFormulaPlugin(),
    collab({ version: options.version, clientID: options.clientID }),
    blockIdPlugin(),
    footnoteLabelPlugin(),
    markdownPastePlugin(options.onGooglePaste),
    imageClipboardPlugin(),
    reviewPlugin(options.review),
    presencePlugin(),
    commentsPlugin(options.onActivateComment),
    // Paints a phrase while the font menu or the size field has focus (lib/editor/formatSelection.ts).
    formatSelectionPlugin(),
    findPlugin(),
    invisiblesPlugin(options.showInvisibles ?? false),
    spellingPlugin(options.dictionary ?? [], { enabled: options.spellcheck ?? true }),
    placeholderPlugin(options.placeholder ?? "Start writing, or ask Claude to draft something…"),
    bordersPlugin(),
    // Tabs are sized before pages are broken, since their widths can rewrap lines.
    tabsPlugin(options.tabStop ?? (() => DEFAULT_TAB_STOP)),
    justifyPlugin(options.fontLines ?? (() => false)),
    // Lines kept from a PDF are spaced once tabs are sized, and before pages are broken.
    lineFitPlugin(),
    tocSyncPlugin(),
    canvasDesignPlugin(),
    canvasBlockHandlesPlugin(),
    paginationPlugin(options.geometry, options.onPages),
  ];
}
