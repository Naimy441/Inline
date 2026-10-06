"use client";

import type { EditorState } from "prosemirror-state";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import type { DocComment } from "@/lib/doc/settings";
import { commentDraft, commentRanges } from "@/lib/editor/comments";
import { CommentCard, NewComment } from "@/components/workspace/CommentsPanel";

const CARD_WIDTH = 272;
const GAP = 24;
const SPACING = 8;

/** Whether the canvas has room for comments beside the page (the page moves left to make room; see .with-comments). */
export function marginFits(canvas: HTMLElement | null) {
  const page = canvas?.querySelector(".page-stack");
  if (!canvas || !page) return false;
  return canvas.clientWidth - page.getBoundingClientRect().width >= CARD_WIDTH + GAP + 2 * 40;
}

type Item = { id: string; anchor: number };

/**
 * Comments floating beside the page next to the text they're about, as in
 * Google Docs, while no side panel is open. The active one lines up with its
 * text; the others stack around it without overlapping.
 */
export function CommentMargin({
  session,
  state,
  canvas,
  comments,
  active,
  draft,
  onDraftDone,
  onAskClaude,
}: {
  session: DocumentSession;
  state: EditorState | null;
  canvas: RefObject<HTMLElement | null>;
  comments: DocComment[];
  active: string | null;
  draft: { from: number; to: number } | null;
  onDraftDone: () => void;
  onAskClaude: (comment: DocComment) => void;
}) {
  const [layout, setLayout] = useState<{ left: number; tops: Record<string, number> } | null>(null);
  const cards = useRef(new Map<string, HTMLDivElement>());
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvas]);

  const open = comments.filter((comment) => !comment.resolved);

  useLayoutEffect(() => {
    const element = canvas.current;
    const view = session.view;
    const page = element?.querySelector(".page-stack");
    if (!element || !view || !state || !page || !marginFits(element)) {
      setLayout(null);
      return;
    }
    const box = element.getBoundingClientRect();
    const top = (pos: number) => {
      try {
        return view.coordsAtPos(Math.min(pos, view.state.doc.content.size)).top - box.top + element.scrollTop;
      } catch {
        return null;
      }
    };
    const ranges = commentRanges(state);
    const items: Item[] = [];
    if (draft) {
      const anchor = top((commentDraft(state) ?? draft).from);
      if (anchor !== null) items.push({ id: "draft", anchor });
    }
    for (const comment of open) {
      const range = ranges.get(comment.id) ?? comment.pending;
      const anchor = range ? top(range.from) : null;
      if (anchor !== null) items.push({ id: comment.id, anchor });
    }
    items.sort((a, b) => a.anchor - b.anchor);
    const height = (id: string) => cards.current.get(id)?.offsetHeight ?? 96;
    const tops: Record<string, number> = {};
    // The card being written or the active one sits at its text; the rest make room around it.
    const pinned = Math.max(
      0,
      items.findIndex((item) => item.id === (draft ? "draft" : active)),
    );
    if (items.length) {
      tops[items[pinned]!.id] = items[pinned]!.anchor;
      for (let index = pinned + 1; index < items.length; index += 1) {
        const previous = items[index - 1]!;
        tops[items[index]!.id] = Math.max(items[index]!.anchor, tops[previous.id]! + height(previous.id) + SPACING);
      }
      for (let index = pinned - 1; index >= 0; index -= 1) {
        const next = items[index + 1]!;
        tops[items[index]!.id] = Math.min(items[index]!.anchor, tops[next.id]! - height(items[index]!.id) - SPACING);
      }
    }
    const left = page.getBoundingClientRect().right - box.left + element.scrollLeft + GAP;
    setLayout((current) => {
      if (current && current.left === left && JSON.stringify(current.tops) === JSON.stringify(tops)) return current;
      return { left, tops };
    });
  });

  if (!open.length && !draft) return null;
  const hidden = !layout;
  const place = (id: string) => (layout && layout.tops[id] !== undefined ? { top: layout.tops[id], left: layout.left } : { visibility: "hidden" as const });
  void width;
  return (
    <div className={`comment-margin${hidden ? " is-hidden" : ""}`} aria-label="Comments">
      {draft && (
        <div ref={(node) => void (node ? cards.current.set("draft", node) : cards.current.delete("draft"))} className="comment-float is-active" style={place("draft")}>
          <NewComment session={session} range={draft} onDone={onDraftDone} />
        </div>
      )}
      {open.map((comment) => (
        <div
          key={comment.id}
          ref={(node) => void (node ? cards.current.set(comment.id, node) : cards.current.delete(comment.id))}
          className={`comment-float${active === comment.id ? " is-active" : ""}`}
          style={place(comment.id)}
        >
          <CommentCard
            session={session}
            comment={comment}
            active={active === comment.id}
            onActivate={() => session.setActiveComment(comment.id)}
            onAskClaude={() => onAskClaude(comment)}
          />
        </div>
      ))}
    </div>
  );
}
