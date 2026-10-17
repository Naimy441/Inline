"use client";

import { Copy, ExternalLink, Pencil, Sparkles, Unlink } from "lucide-react";
import type { EditorState } from "prosemirror-state";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { isTouch } from "@/lib/client/viewport";
import { followLink, linkAt, linkEditTarget, setLink } from "@/lib/editor/commands";
import { toast } from "@/components/ui/Toast";

/**
 * Floating editor for the inline prompt and for links under the cursor.
 * Selecting text does not open an action bar. A link opens one compact row.
 */
export function SelectionBubble({
  session,
  state,
  linkEditing,
  linkSession = 0,
  linkPrefill = null,
  onLinkEditing,
  prompting = false,
  onPrompting,
  onInlineAsk,
  hideAi = false,
}: {
  session: DocumentSession;
  state: EditorState | null;
  linkEditing: boolean;
  /** Bumps each time the link editor opens, so a second ⌘K anchors again. */
  linkSession?: number;
  /** A URL already on the clipboard when ⌘K opened the editor, if there was one. */
  linkPrefill?: string | null;
  onLinkEditing: (open: boolean) => void;
  /** The inline ⌘⇧K prompt is open. */
  prompting?: boolean;
  onPrompting?: (open: boolean) => void;
  /** Send the inline prompt to Claude about the selection (or the cursor). */
  onInlineAsk?: (text: string) => void;
  /** Focus mode: no Ask Claude button, inline prompt, or edit-with-Claude action. */
  hideAi?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [href, setHref] = useState("");
  const [text, setText] = useState("");
  const [instruction, setInstruction] = useState("");
  const [scrollTick, setScrollTick] = useState(0);
  const [suppressBar, setSuppressBar] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLInputElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const hrefDirty = useRef(false);
  const anchor = useRef<{ session: number; from: number; to: number; href: string } | null>(null);

  const view = session.view;

  // Keep the whole bubble on screen: it's centred on its anchor, so nudge it in from either edge.
  useLayoutEffect(() => {
    const element = bubble.current;
    if (!element) return;
    element.style.marginLeft = "";
    const box = element.getBoundingClientRect();
    const edge = 8;
    const shift = box.left < edge ? edge - box.left : box.right > window.innerWidth - edge ? window.innerWidth - edge - box.right : 0;
    if (shift) element.style.marginLeft = `${shift}px`;
  });

  useEffect(() => {
    const dom = view?.dom;
    if (!dom) return;
    const down = (event: MouseEvent) => {
      // A right-click is the context menu. Hide the link bar before mouseup paints it.
      if (event.button === 2) {
        setSuppressBar(true);
        onLinkEditing(false);
      } else if (event.button === 0) setSuppressBar(false);
      setDragging(true);
    };
    const up = () => setDragging(false);
    const focusIn = () => setFocused(true);
    const focusOut = (event: FocusEvent) => {
      if ((event.relatedTarget as HTMLElement | null)?.closest?.(".bubble")) return;
      setFocused(false);
    };
    // Right-click opens the context menu only. Capture runs before that menu moves the caret.
    const onContext = () => {
      setSuppressBar(true);
      onLinkEditing(false);
    };
    dom.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    dom.addEventListener("focusin", focusIn);
    dom.addEventListener("focusout", focusOut);
    dom.addEventListener("contextmenu", onContext, true);
    if (document.activeElement === dom) setFocused(true);
    return () => {
      dom.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
      dom.removeEventListener("focusin", focusIn);
      dom.removeEventListener("focusout", focusOut);
      dom.removeEventListener("contextmenu", onContext, true);
    };
  }, [view, onLinkEditing]);

  useEffect(() => {
    const scroller = view?.dom.closest(".canvas");
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setScrollTick((n) => n + 1));
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [view]);

  if (!linkEditing) anchor.current = null;
  else if (state && (!anchor.current || anchor.current.session !== linkSession)) anchor.current = { session: linkSession, ...linkEditTarget(state) };

  useLayoutEffect(() => {
    if (!linkEditing) return;
    hrefDirty.current = false;
    setHref(linkPrefill || anchor.current?.href || "");
    setText("");
    input.current?.focus();
  }, [linkEditing, linkSession]);

  useEffect(() => {
    if (!linkEditing || hrefDirty.current || !linkPrefill) return;
    setHref(linkPrefill);
  }, [linkEditing, linkPrefill]);

  useLayoutEffect(() => {
    if (!prompting) return;
    setInstruction("");
    // Focus before paint. A key pressed as soon as the field is visible (Escape
    // to dismiss it) otherwise lands in the document and leaves the prompt open.
    promptInput.current?.focus();
  }, [prompting]);

  useEffect(() => {
    if (!linkEditing) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && bubble.current?.contains(target)) return;
      onLinkEditing(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onLinkEditing(false);
      view?.focus();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [linkEditing, onLinkEditing, view]);

  if (!state || !view) return null;
  const barLink = linkForBar(state);
  const showLink = Boolean(barLink) && focused && !dragging && !suppressBar && !linkEditing && !prompting;
  // A text selection stays a selection. It does not open Ask Claude, comment, or formatting buttons.
  if (!prompting && !linkEditing && !showLink) return null;

  const saved = linkEditing ? anchor.current : null;
  const place = saved ?? (showLink && barLink ? barLink : null) ?? { from: state.selection.from, to: state.selection.to };
  let coords: { left: number; top: number; bottom: number };
  try {
    const start = view.coordsAtPos(clampPos(state, place.from));
    const end = view.coordsAtPos(clampPos(state, place.to));
    coords = { left: (start.left + end.left) / 2, top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom) };
    if (start.top !== end.top) coords.left = start.left + 60;
  } catch {
    return null;
  }
  void scrollTick;
  // On touch screens the system's copy/paste callout sits above the selection, so go below it.
  const above = coords.top > 120 && !isTouch();
  // The bubble is centred on `left`; the layout effect above keeps all of it on screen.
  const style = { left: coords.left, top: above ? coords.top - 8 : coords.bottom + 10 };

  const closeEditor = () => {
    onLinkEditing(false);
    view.focus();
  };

  const applyLink = () => {
    if (!saved) return;
    const trimmed = href.trim();
    if (!trimmed) {
      if (saved.from !== saved.to) session.run(setLink(null, undefined, saved));
      closeEditor();
      return;
    }
    // A selection, or an existing link, already has its text. Only a caret inserts any.
    const inserted = saved.from === saved.to ? text.trim() || trimmed : undefined;
    if (session.run(setLink(trimmed, inserted, saved))) closeEditor();
  };

  const onFieldKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      applyLink();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeEditor();
    }
  };

  if (prompting && !hideAi) {
    const close = () => {
      onPrompting?.(false);
      view.focus();
    };
    const sendPrompt = () => {
      const value = instruction.trim();
      if (!value) return;
      onInlineAsk?.(value);
      onPrompting?.(false);
      view.focus();
    };
    return (
      <div className={`bubble bubble-link bubble-prompt${above ? " is-above" : ""}`} ref={bubble} style={style} onMouseDown={(event) => event.stopPropagation()}>
        <Sparkles size={14} className="bubble-prompt-icon" />
        <input
          ref={promptInput}
          className="input input-sm"
          aria-label="Ask Claude to edit"
          placeholder={state.selection.empty ? "Ask Claude to write here…" : "Ask Claude to change the selection…"}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onBlur={(event) => {
            if (!(event.relatedTarget as HTMLElement | null)?.closest?.(".bubble")) onPrompting?.(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              sendPrompt();
            } else if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        />
        <button type="button" className="btn btn-primary btn-sm" disabled={!instruction.trim()} onClick={sendPrompt}>
          <span className="btn-label">Send</span>
        </button>
      </div>
    );
  }

  if (linkEditing && saved) {
    const inserting = saved.from === saved.to;
    return (
      <div className={`bubble bubble-link${above ? " is-above" : ""}`} ref={bubble} style={style} onMouseDown={(event) => event.stopPropagation()}>
        {inserting && (
          <input className="input input-sm" placeholder="Text" aria-label="Link text" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onFieldKey} />
        )}
        <input
          ref={input}
          className="input input-sm"
          aria-label="Link URL"
          placeholder="Paste or type a link"
          autoComplete="off"
          spellCheck={false}
          value={href}
          onChange={(event) => {
            hrefDirty.current = true;
            setHref(event.target.value);
          }}
          onBlur={(event) => {
            if ((event.relatedTarget as HTMLElement | null)?.closest?.(".bubble")) return;
            onLinkEditing(false);
          }}
          onKeyDown={onFieldKey}
        />
        <button type="button" className="btn btn-primary btn-sm" onClick={applyLink}>
          <span className="btn-label">Apply</span>
        </button>
      </div>
    );
  }

  if (showLink && barLink) {
    const copy = () => {
      void navigator.clipboard.writeText(barLink.href).then(
        () => toast("Link copied"),
        () => toast("Couldn't copy the link", { tone: "error" }),
      );
    };
    return (
      <div className={`bubble link-bar${above ? " is-above" : ""}`} ref={bubble} style={style} role="toolbar" aria-label="Link" onMouseDown={(event) => event.preventDefault()}>
        <button type="button" className="bubble-url" title={barLink.href} onClick={() => session.run(followLink(barLink.href))}>
          {barLink.href}
        </button>
        <span className="bubble-sep" />
        <button type="button" className="bubble-btn" aria-label="Open link" onClick={() => session.run(followLink(barLink.href))}>
          <ExternalLink size={14} />
        </button>
        <button type="button" className="bubble-btn" aria-label="Copy link" onClick={copy}>
          <Copy size={14} />
        </button>
        <button type="button" className="bubble-btn" aria-label="Edit link" onClick={() => onLinkEditing(true)}>
          <Pencil size={14} />
        </button>
        <button type="button" className="bubble-btn" aria-label="Remove link" onClick={() => session.run(setLink(null))}>
          <Unlink size={14} />
        </button>
      </div>
    );
  }

  return null;
}

function clampPos(state: EditorState, pos: number) {
  return Math.max(1, Math.min(pos, state.doc.content.size));
}

/** The link under a caret, or a selection that is exactly one link. A wider selection stays a selection. */
function linkForBar(state: EditorState): { from: number; to: number; href: string } | null {
  const link = linkAt(state);
  if (!link) return null;
  const { from, to, empty } = state.selection;
  if (empty) return from >= link.from && to <= link.to ? link : null;
  if (from === link.from && to === link.to) return link;
  return null;
}
