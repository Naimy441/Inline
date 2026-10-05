"use client";

import { Bold, ExternalLink, Italic, Link2, MessageSquarePlus, Pencil, Sparkles, Unlink } from "lucide-react";
import { NodeSelection, type EditorState } from "prosemirror-state";
import { useEffect, useRef, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { schema } from "@/lib/doc/schema";
import { followLink, linkAt, markActive, setLink, toggle } from "@/lib/editor/commands";
import { isTouch } from "@/lib/client/viewport";

const mod = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "⌘" : "Ctrl+";

/**
 * Floating actions for the current selection (Ask Claude, comment, quick
 * formatting) and for links under the cursor. Also hosts the link editor.
 */
export function SelectionBubble({
  session,
  state,
  linkEditing,
  onLinkEditing,
  onAsk,
  onComment,
}: {
  session: DocumentSession;
  state: EditorState | null;
  linkEditing: boolean;
  onLinkEditing: (open: boolean) => void;
  onAsk: () => void;
  onComment: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [href, setHref] = useState("");
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const view = session.view;

  useEffect(() => {
    const dom = view?.dom;
    if (!dom) return;
    const down = () => setDragging(true);
    const up = () => setDragging(false);
    const focusIn = () => setFocused(true);
    const focusOut = (event: FocusEvent) => {
      if ((event.relatedTarget as HTMLElement | null)?.closest?.(".bubble")) return;
      setFocused(false);
    };
    dom.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    dom.addEventListener("focusin", focusIn);
    dom.addEventListener("focusout", focusOut);
    if (document.activeElement === dom) setFocused(true);
    return () => {
      dom.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
      dom.removeEventListener("focusin", focusIn);
      dom.removeEventListener("focusout", focusOut);
    };
  }, [view]);

  const link = state ? linkAt(state) : null;

  useEffect(() => {
    if (!linkEditing) return;
    setHref(link?.href ?? "");
    setText("");
    requestAnimationFrame(() => input.current?.focus());
    // Only when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkEditing]);

  if (!state || !view) return null;
  const { from, to, empty } = state.selection;
  const isNode = state.selection instanceof NodeSelection;
  const showSelection = !empty && !isNode && focused && !dragging;
  const showLink = Boolean(link) && empty && focused && !dragging;
  if (!linkEditing && !showSelection && !showLink) return null;

  let coords: { left: number; top: number; bottom: number };
  try {
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    coords = { left: (start.left + end.left) / 2, top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom) };
    if (start.top !== end.top) coords.left = start.left + 60;
  } catch {
    return null;
  }
  // On touch screens the system's copy/paste callout sits above the selection, so go below it.
  const above = coords.top > 120 && !isTouch();
  // The bubble is centred on `left`; keep all of it on narrow screens.
  const inset = window.innerWidth < 640 ? 156 : 12;
  const style = { left: Math.max(inset, Math.min(coords.left, window.innerWidth - inset)), top: above ? coords.top - 8 : coords.bottom + 10 };

  const applyLink = () => {
    if (!href.trim()) {
      session.run(setLink(null));
    } else {
      session.run(setLink(href, empty && !link ? text || href : undefined));
    }
    onLinkEditing(false);
  };

  if (linkEditing) {
    return (
      <div className={`bubble bubble-link${above ? " is-above" : ""}`} style={style} onMouseDown={(event) => event.stopPropagation()}>
        {empty && !link && (
          <input className="input input-sm" placeholder="Text" value={text} onChange={(event) => setText(event.target.value)} />
        )}
        <input
          ref={input}
          className="input input-sm"
          placeholder="Paste or type a link"
          value={href}
          onChange={(event) => setHref(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              applyLink();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onLinkEditing(false);
              view.focus();
            }
          }}
        />
        <button type="button" className="btn btn-primary btn-sm" onClick={applyLink}>
          <span className="btn-label">Apply</span>
        </button>
      </div>
    );
  }

  if (showLink && link) {
    return (
      <div className={`bubble${above ? " is-above" : ""}`} style={style} onMouseDown={(event) => event.preventDefault()}>
        <a
          className="bubble-url"
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (!link.href.startsWith("#")) return;
            event.preventDefault();
            session.run(followLink(link.href));
          }}
        >
          <ExternalLink size={13} /> {link.href.replace(/^https?:\/\//, "").slice(0, 48)}
        </a>
        <span className="bubble-sep" />
        <button type="button" className="bubble-btn" aria-label="Edit link" onClick={() => onLinkEditing(true)}>
          <Pencil size={14} />
        </button>
        <button type="button" className="bubble-btn" aria-label="Remove link" onClick={() => session.run(setLink(null))}>
          <Unlink size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className={`bubble${above ? " is-above" : ""}`} style={style} onMouseDown={(event) => event.preventDefault()}>
      <button type="button" className="bubble-btn bubble-ask" onClick={onAsk}>
        <Sparkles size={14} /> Ask Claude <kbd>{mod}L</kbd>
      </button>
      <span className="bubble-sep" />
      <button type="button" className="bubble-btn" aria-label="Comment" data-tip="Comment" onClick={onComment}>
        <MessageSquarePlus size={14} />
      </button>
      <button type="button" className={`bubble-btn bubble-edit${markActive(state, schema.marks.bold!) ? " is-active" : ""}`} aria-label="Bold" onClick={() => session.run(toggle("bold"))}>
        <Bold size={14} />
      </button>
      <button type="button" className={`bubble-btn bubble-edit${markActive(state, schema.marks.italic!) ? " is-active" : ""}`} aria-label="Italic" onClick={() => session.run(toggle("italic"))}>
        <Italic size={14} />
      </button>
      <button type="button" className="bubble-btn bubble-edit" aria-label="Link" onClick={() => onLinkEditing(true)}>
        <Link2 size={14} />
      </button>
    </div>
  );
}
