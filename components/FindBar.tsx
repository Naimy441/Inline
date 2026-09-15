"use client";

import { useEffect, useRef, useState } from "react";
import {
  clearFindHighlights,
  findAllRanges,
  highlightFind,
  replaceAll,
  replaceCurrent,
  selectRange,
  selectedText,
} from "@/lib/editorApi";

type Props = {
  open: boolean;
  replaceOpen?: boolean;
  getEditor: () => HTMLElement | null;
  onClose: () => void;
  onReplaceOpenChange?: (open: boolean) => void;
  onMutate?: () => void;
};

export function FindBar({
  open,
  replaceOpen = false,
  getEditor,
  onClose,
  onReplaceOpenChange,
  onMutate,
}: Props) {
  const findRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);

  const show = (needle: string, at = 0) => {
    const editor = getEditor();
    if (!editor || !needle.trim()) {
      clearFindHighlights();
      setCount(0);
      setIndex(0);
      return 0;
    }
    const ranges = findAllRanges(editor, needle);
    const next = ranges.length ? ((at % ranges.length) + ranges.length) % ranges.length : 0;
    setCount(ranges.length);
    setIndex(next);
    if (ranges[next]) selectRange(editor, ranges[next]);
    highlightFind(ranges, next);
    return ranges.length;
  };

  useEffect(() => {
    if (!open) {
      clearFindHighlights();
      return;
    }
    const selected = selectedText().replace(/\s+/g, " ").trim();
    if (selected && selected.length <= 80) {
      setQuery(selected);
      show(selected, 0);
    } else {
      show(query, 0);
    }
    const timer = window.setTimeout(() => {
      findRef.current?.focus();
      findRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
    // Seed once when the bar opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    show(query, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "F3" || (meta && event.key.toLowerCase() === "g")) {
        event.preventDefault();
        jump(event.shiftKey ? -1 : 1);
        return;
      }
      if (meta && event.key.toLowerCase() === "f" && !event.shiftKey) {
        event.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => () => clearFindHighlights(), []);

  const jump = (delta: number) => {
    show(query, index + delta);
  };

  if (!open) return null;
  const label = count ? `${index + 1} of ${count}` : query.trim() ? "No results" : "";

  return (
    <div className="find-bar" role="search" aria-label="Find in document">
      <style>{`
        ::highlight(inline-find) { background-color: #f6e05e; color: inherit; }
        ::highlight(inline-find-current) { background-color: #ed8936; color: inherit; }
        html[data-theme="dark"] ::highlight(inline-find) { background-color: #b7791f; }
        html[data-theme="dark"] ::highlight(inline-find-current) { background-color: #dd6b20; }
      `}</style>
      <div className="find-bar-row">
        <input
          ref={findRef}
          value={query}
          placeholder="Find"
          aria-label="Find"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              jump(event.shiftKey ? -1 : 1);
            }
          }}
        />
        <span className="find-bar-count" aria-live="polite">
          {label}
        </span>
        <button type="button" className="find-bar-icon" onClick={() => jump(-1)} aria-label="Previous match">
          <ChevronUp />
        </button>
        <button type="button" className="find-bar-icon" onClick={() => jump(1)} aria-label="Next match">
          <ChevronDown />
        </button>
        <button
          type="button"
          className={`find-bar-text${replaceOpen ? " is-active" : ""}`}
          aria-expanded={replaceOpen}
          onClick={() => onReplaceOpenChange?.(!replaceOpen)}
        >
          Replace
        </button>
        <button type="button" className="find-bar-icon" onClick={onClose} aria-label="Close find">
          <CloseIcon />
        </button>
      </div>
      {replaceOpen ? (
        <div className="find-bar-row">
          <input
            value={replacement}
            placeholder="Replace with"
            aria-label="Replace with"
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                const editor = getEditor();
                if (!editor) return;
                replaceCurrent(editor, query, replacement);
                onMutate?.();
                show(query, index);
              }
            }}
          />
          <button
            type="button"
            className="find-bar-text"
            onClick={() => {
              const editor = getEditor();
              if (!editor) return;
              replaceCurrent(editor, query, replacement);
              onMutate?.();
              show(query, index);
            }}
          >
            Replace
          </button>
          <button
            type="button"
            className="find-bar-text"
            onClick={() => {
              const editor = getEditor();
              if (!editor) return;
              replaceAll(editor, query, replacement);
              onMutate?.();
              show(query, 0);
            }}
          >
            All
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ChevronUp() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 10 8 6l4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6 8 10l4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
