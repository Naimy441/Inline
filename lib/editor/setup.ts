import { collab } from "prosemirror-collab";
import { baseKeymap, chainCommands, exitCode, joinDown, joinUp, selectParentNode } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { ellipsis, emDash, InputRule, inputRules, smartQuotes, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { Fragment, Slice, type MarkType } from "prosemirror-model";
import { findWrapping } from "prosemirror-transform";
import { splitListItem } from "prosemirror-schema-list";
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { columnResizing, goToNextCell, tableEditing } from "prosemirror-tables";
import { blockIdFixes } from "@/lib/doc/ids";
import { parseMarkdown } from "@/lib/doc/markdown";
import { schema } from "@/lib/doc/schema";
import {
  clearFormatting,
  followLink,
  indent,
  insertPageBreak,
  outdent,
  setAlign,
  setBlock,
  toggle,
  toggleBlockquote,
  toggleList,
  toggleTask,
} from "@/lib/editor/commands";
import { commentsPlugin } from "@/lib/editor/comments";
import { findPlugin } from "@/lib/editor/find";
import { spellingPlugin } from "@/lib/editor/spelling";
import { invisiblesPlugin } from "@/lib/editor/invisibles";
import { paginationPlugin, type PageGeometry, type PageLayout } from "@/lib/editor/pagination";
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

function markInputRule(pattern: RegExp, type: MarkType) {
  return new InputRule(pattern, (state, match, start, end) => {
    const text = match[2];
    if (!text) return null;
    const tr = state.tr;
    const textStart = start + match[0].indexOf(match[1]!);
    tr.replaceWith(textStart, end, schema.text(text, [...state.doc.resolve(start).marks(), type.create()]));
    tr.removeStoredMark(type);
    return tr;
  });
}

/**
 * Tools > Automatic substitutions: typographic quotes, dashes, symbols and
 * fractions as you type. Each rule checks the preference when it fires, so
 * turning it off takes effect immediately.
 */
const SUBSTITUTIONS: InputRule[] = [
  ...smartQuotes,
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
  new InputRule(/(?:^|[\s(])(1\/2)\s$/, "½"),
  new InputRule(/(?:^|[\s(])(1\/4)\s$/, "¼"),
  new InputRule(/(?:^|[\s(])(3\/4)\s$/, "¾"),
];

function whenEnabled(rule: InputRule, enabled: () => boolean) {
  const handler = (rule as unknown as { handler: (state: EditorState, match: RegExpMatchArray, start: number, end: number) => Transaction | null }).handler;
  return new InputRule((rule as unknown as { match: RegExp }).match, (state, match, start, end) => (enabled() ? handler(state, match, start, end) : null));
}

function buildInputRules(substitutions: () => boolean) {
  return inputRules({
    rules: [
      ...SUBSTITUTIONS.map((rule) => whenEnabled(rule, substitutions)),
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

function buildKeymap(extra: Record<string, Command>) {
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
    "Shift-Enter": insertHardBreak,
    Enter: chainCommands(splitListItem(nodes.list_item!), liftEmptyBlock),
    Tab: chainCommands(goToNextCell(1), indent),
    "Shift-Tab": chainCommands(goToNextCell(-1), outdent),
    "Mod-]": indent,
    "Mod-[": outdent,
    "Alt-ArrowUp": joinUp,
    "Alt-ArrowDown": joinDown,
    Escape: selectParentNode,
    ...extra,
  };
  return keymap(bindings);
}

/** Paste plain text that looks like Markdown as rich content. */
function markdownPastePlugin() {
  const looksLikeMarkdown = (text: string) => /(^|\n)(#{1,6} |[-*+] |\d+\. |> |```|\|.+\|)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/.test(text);
  return new Plugin({
    props: {
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
  onPages?: (layout: PageLayout) => void;
  keys?: Record<string, Command>;
  placeholder?: string;
  /** Viewing mode: local edits are refused (changes from the server still apply). */
  readOnly?: () => boolean;
  substitutions?: () => boolean;
  showInvisibles?: boolean;
  /** Words the browser shouldn't underline as misspelled. */
  dictionary?: string[];
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
    buildKeymap(options.keys ?? {}),
    keymap(baseKeymap),
    history(),
    dropCursor({ color: "var(--accent)", width: 2 }),
    gapCursor(),
    columnResizing(),
    tableEditing(),
    collab({ version: options.version, clientID: options.clientID }),
    blockIdPlugin(),
    markdownPastePlugin(),
    reviewPlugin(options.review),
    presencePlugin(),
    commentsPlugin(options.onActivateComment),
    findPlugin(),
    invisiblesPlugin(options.showInvisibles ?? false),
    spellingPlugin(options.dictionary ?? []),
    placeholderPlugin(options.placeholder ?? "Start writing, or ask Claude to draft something…"),
    paginationPlugin(options.geometry, options.onPages),
  ];
}
