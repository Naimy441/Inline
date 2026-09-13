"use client";

import { useEffect, useRef, useState } from "react";
import { documentEditIds, highlightAgentEdit, jumpToAgentEdit } from "@/lib/agent/edits";

type Props = {
  getEditor: () => HTMLElement | null;
  pendingIds: string[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
};

type Box = { top: number; bottom: number; left: number; right: number };

export function DiffReviewBar({ getEditor, pendingIds, onAccept, onReject }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const overBarRef = useRef(false);
  const hoverIdRef = useRef<string | null>(null);
  const pendingKey = pendingIds.join("|");
  const ordered = visiblePending(getEditor(), pendingIds);
  const active = activeId && ordered.includes(activeId) ? activeId : null;
  const index = active ? ordered.indexOf(active) : -1;

  useEffect(() => {
    if (!pendingIds.length) {
      hoverIdRef.current = null;
      setActiveId(null);
      setBox(null);
      const editor = getEditor();
      if (editor) highlightAgentEdit(editor, null);
    }
  }, [pendingKey, getEditor, pendingIds.length]);

  useEffect(() => {
    let hideTimer = 0;
    let switchTimer = 0;
    const show = (id: string, node: HTMLElement) => {
      window.clearTimeout(hideTimer);
      const editor = getEditor();
      if (!editor) return;
      hoverIdRef.current = id;
      setActiveId(id);
      highlightAgentEdit(editor, id);
      setBox(sameBox(fragmentBox(node)));
    };
    const hide = () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(switchTimer);
      hideTimer = window.setTimeout(() => {
        if (overBarRef.current) return;
        hoverIdRef.current = null;
        setActiveId(null);
        setBox(null);
        const editor = getEditor();
        if (editor) highlightAgentEdit(editor, null);
      }, 180);
    };

    const onMove = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".diff-review")) {
        window.clearTimeout(hideTimer);
        return;
      }
      const wrap = target.closest(".agent-edit");
      const id = wrap instanceof HTMLElement ? wrap.dataset.editId ?? "" : "";
      if (id && pendingIds.includes(id) && wrap instanceof HTMLElement) {
        window.clearTimeout(hideTimer);
        if (id === hoverIdRef.current) {
          window.clearTimeout(switchTimer);
          setBox(sameBox(fragmentBox(wrap)));
          return;
        }
        window.clearTimeout(switchTimer);
        if (!hoverIdRef.current) {
          show(id, wrap);
          return;
        }
        switchTimer = window.setTimeout(() => show(id, wrap), 90);
        return;
      }
      hide();
    };

    const onScroll = () => {
      if (!hoverIdRef.current) return;
      const editor = getEditor();
      if (!editor) return;
      const node = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      const wrap =
        node instanceof Element
          ? node.closest<HTMLElement>(`.agent-edit[data-edit-id="${cssId(hoverIdRef.current)}"]`)
          : null;
      const fallback = editor.querySelector<HTMLElement>(`.agent-edit[data-edit-id="${cssId(hoverIdRef.current)}"]`);
      const current = wrap ?? fallback;
      if (current) setBox(sameBox(fragmentBox(current)));
    };

    document.addEventListener("mousemove", onMove);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(switchTimer);
      document.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [getEditor, pendingKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!active || !ordered.length) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "y") {
        event.preventDefault();
        onAccept(active);
        return;
      }
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        onReject(active);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, ordered.length, onAccept, onReject]);

  if (!active || !box || index < 0) return null;

  const width = 252;
  const editor = getEditor();
  const canvas = editor?.closest(".canvas-shell") ?? editor;
  const clip = canvas?.getBoundingClientRect();
  const rightEdge = clip ? Math.min(box.right, clip.right - 10) : box.right;
  const left = Math.min(
    Math.max(clip ? clip.left + 10 : 12, rightEdge - width),
    (clip ? clip.right : window.innerWidth) - width - 10,
  );
  const below = box.bottom + 8;
  const top = below + 36 < window.innerHeight ? below : Math.max(12, box.top - 40);
  const shortcut = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

  const go = (nextIndex: number) => {
    const id = ordered[(nextIndex + ordered.length) % ordered.length];
    const editor = getEditor();
    if (!editor || !id) return;
    setActiveId(id);
    jumpToAgentEdit(editor, id);
    hoverIdRef.current = id;
    const node = editor.querySelector<HTMLElement>(`.agent-edit[data-edit-id="${cssId(id)}"]`);
    if (node) setBox(fragmentBox(node));
  };

  return (
    <div
      className="diff-review"
      style={{ top, left }}
      onMouseEnter={() => {
        overBarRef.current = true;
      }}
      onMouseLeave={() => {
        overBarRef.current = false;
      }}
    >
      <button type="button" className="diff-review-nav" aria-label="Previous change" onClick={() => go(index - 1)}>
        <ChevronUpIcon />
      </button>
      <span className="diff-review-count">
        {index + 1} of {ordered.length}
      </span>
      <button type="button" className="diff-review-nav" aria-label="Next change" onClick={() => go(index + 1)}>
        <ChevronDownIcon />
      </button>
      <button type="button" className="diff-review-undo" onClick={() => onReject(active)}>
        Undo <kbd>{shortcut}N</kbd>
      </button>
      <button type="button" className="diff-review-keep" onClick={() => onAccept(active)}>
        Keep <kbd>{shortcut}Y</kbd>
      </button>
    </div>
  );
}

function visiblePending(editor: HTMLElement | null, pendingIds: string[]) {
  if (!editor) return [];
  const pending = new Set(pendingIds);
  return documentEditIds(editor).filter((id) => pending.has(id));
}

function fragmentBox(node: HTMLElement): Box {
  const rect = node.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

function sameBox(next: Box) {
  return (current: Box | null) => {
    if (
      current &&
      Math.abs(current.top - next.top) < 1 &&
      Math.abs(current.bottom - next.bottom) < 1 &&
      Math.abs(current.left - next.left) < 1 &&
      Math.abs(current.right - next.right) < 1
    ) {
      return current;
    }
    return next;
  };
}

function cssId(id: string) {
  return id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.2 9.6 8 5.8l3.8 3.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.2 6.4 8 10.2l3.8-3.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
