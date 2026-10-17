import { ReplaceStep } from "prosemirror-transform";
import { Plugin, type EditorState, type Transaction } from "prosemirror-state";
import { schema } from "@/lib/doc/schema";
import { linkHrefFromInput } from "@/lib/editor/commands";

/**
 * Typing `https://…`, `http://…`, or `www.…` and then Space or Enter makes
 * that URL a link. Ordinary words, including bare hosts like `example.com`,
 * are left alone. The mark is added in the same history step as the space or
 * the line break.
 */

const URL_AT_END = /(^|[\s\u00A0\uFFFC])((?:https?:\/\/|www\.)\S+)$/i;

export type AutolinkMatch = { text: string; href: string; start: number };

/** A finished http(s) or www link at the end of `before`, or null. `start` is an index into `before`. */
export function autolinkAtEnd(before: string): AutolinkMatch | null {
  const found = URL_AT_END.exec(before);
  if (!found) return null;
  const raw = found[2]!;
  const text = stripTrailingPunctuation(raw);
  if (!text || text === raw.slice(0, "https://".length) || /^https?:\/\/$/i.test(text) || /^www\.?$/i.test(text)) return null;
  if (/^www\./i.test(text)) {
    if (!/^www\.[^/\s]+\.[a-z]{2,}([/?#]\S*)?$/i.test(text)) return null;
  } else if (!/^https?:\/\/[^\s/]+/i.test(text)) {
    return null;
  }
  const href = linkHrefFromInput(text);
  if (!href) return null;
  return { text, href, start: found.index + found[1]!.length };
}

function stripTrailingPunctuation(url: string) {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (".,;:!?".includes(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ")") {
      const head = url.slice(0, end);
      const opens = countChar(head, "(");
      const closes = countChar(head, ")");
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

function countChar(value: string, ch: string) {
  let count = 0;
  for (const item of value) if (item === ch) count += 1;
  return count;
}

function skipsAutolink(state: EditorState, pos: number) {
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return true;
  const marks = state.storedMarks ?? $pos.marks();
  return marks.some((mark) => mark.type.spec.code || mark.type.name === "code" || mark.type.name === "math");
}

function rangeSkips(state: EditorState, from: number, to: number) {
  let skip = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    if (node.marks.some((mark) => mark.type.spec.code || mark.type.name === "code" || mark.type.name === "math")) skip = true;
  });
  return skip;
}

function boundaryAtCaret(transactions: readonly Transaction[], pos: number) {
  for (const tr of transactions) {
    if (!tr.docChanged || tr.getMeta("addToHistory") === false) continue;
    for (const step of tr.steps) {
      if (!(step instanceof ReplaceStep) || step.from !== pos || step.to !== pos) continue;
      const { slice } = step;
      const only = slice.content.childCount === 1 ? slice.content.firstChild : null;
      const space = slice.openStart === 0 && slice.openEnd === 0 && only?.isText && only.text === " ";
      const split = slice.openStart > 0 && slice.openEnd > 0;
      if (space || split) return true;
    }
  }
  return false;
}

function mapPos(transactions: readonly Transaction[], pos: number, bias: -1 | 1) {
  let next = pos;
  for (const tr of transactions) next = tr.mapping.map(next, bias);
  return next;
}

function alreadyLinked(state: EditorState, from: number, to: number, href: string) {
  const type = schema.marks.link!;
  if (from >= to || !state.doc.rangeHasMark(from, to, type)) return false;
  let ok = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    const mark = type.isInSet(node.marks);
    if (!mark || mark.attrs.href !== href) ok = false;
  });
  return ok;
}

/** The link mark to add after Space or Enter, folded into that keystroke. */
export function autolinkTransaction(transactions: readonly Transaction[], oldState: EditorState, newState: EditorState): Transaction | null {
  if (!transactions.some((tr) => tr.docChanged && tr.getMeta("addToHistory") !== false)) return null;
  if (transactions.some((tr) => tr.getMeta("autolink") || tr.getMeta("rebased") !== undefined || tr.getMeta("paste") || tr.getMeta("uiEvent") === "paste")) return null;
  if (!oldState.selection.empty) return null;
  const $from = oldState.selection.$from;
  if (!boundaryAtCaret(transactions, $from.pos)) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
  const match = autolinkAtEnd(before);
  if (!match || before.length !== $from.parentOffset) return null;
  const rawFrom = $from.pos - (before.length - match.start);
  const rawTo = rawFrom + match.text.length;
  // The caret sits after the URL, where an inclusive:false equation mark no longer applies.
  if (skipsAutolink(oldState, rawFrom) || rangeSkips(oldState, rawFrom, rawTo)) return null;
  const from = mapPos(transactions, rawFrom, 1);
  const to = mapPos(transactions, rawTo, -1);
  if (from < 0 || to > newState.doc.content.size || from >= to) return null;
  if (newState.doc.textBetween(from, to, "\n", "\ufffc") !== match.text) return null;
  if (alreadyLinked(newState, from, to, match.href)) return null;
  return newState.tr.addMark(from, to, schema.marks.link!.create({ href: match.href })).setMeta("autolink", true);
}

export function autolinkPlugin() {
  return new Plugin({
    appendTransaction(transactions, oldState, newState) {
      return autolinkTransaction(transactions, oldState, newState);
    },
  });
}
