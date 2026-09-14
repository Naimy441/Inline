"use client";

import { useEffect, useRef, useState } from "react";

export const DOCUMENT_FONTS = [
  "Arial",
  "Times New Roman",
  "Georgia",
  "Calibri",
  "Cambria",
  "Courier New",
  "Verdana",
  "Garamond",
];

export const DOCUMENT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];

const MIN_SIZE = 6;
const MAX_SIZE = 400;

type FontFamilyProps = {
  value: string;
  onPick: (family: string) => void;
};

export function resolveDocumentFont(family: string) {
  const lower = family.toLowerCase();
  return DOCUMENT_FONTS.find((name) => name.toLowerCase() === lower) ?? family;
}

export function FontFamilyPicker({ value, onPick }: FontFamilyProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const frozenRange = useRef<Range | null>(null);
  const current = resolveDocumentFont(value);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="font-tool font-family-tool"
      onMouseDown={(event) => {
        freezeRange(frozenRange);
        event.preventDefault();
      }}
    >
      <button
        type="button"
        className="font-family-btn"
        aria-label="Font"
        aria-expanded={open}
        title="Font"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="font-family-label" style={{ fontFamily: current }}>
          {current}
        </span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="font-popover font-family-popover" role="listbox" aria-label="Font">
          {DOCUMENT_FONTS.map((name) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={current === name}
              className="font-option"
              data-active={current === name}
              style={{ fontFamily: name }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                restoreRange(frozenRange.current);
                onPick(name);
                setOpen(false);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type FontSizeProps = {
  value: number;
  onPick: (size: number) => void;
};

export function FontSizePicker({ value, onPick }: FontSizeProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const frozenRange = useRef<Range | null>(null);

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const commitDraft = () => {
    const next = clampSize(Number.parseInt(draft, 10));
    setDraft(String(next));
    setEditing(false);
    if (next !== value) {
      restoreRange(frozenRange.current);
      onPick(next);
    }
  };

  const applySize = (next: number) => {
    const size = clampSize(next);
    restoreRange(frozenRange.current);
    onPick(size);
    setDraft(String(size));
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className="font-tool font-size-tool"
      onMouseDown={(event) => {
        freezeRange(frozenRange);
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
      }}
    >
      <button
        type="button"
        className="tool font-step"
        title="Decrease font size"
        aria-label="Decrease font size"
        onClick={() => applySize(value - 1)}
      >
        <MinusIcon />
      </button>
      <div className="font-size-field">
        <input
          className="font-size-input"
          aria-label="Font size"
          inputMode="numeric"
          value={draft}
          onFocus={() => setEditing(true)}
          onChange={(event) => {
            setDraft(event.target.value.replace(/[^\d]/g, "").slice(0, 3));
            setEditing(true);
          }}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitDraft();
              (event.target as HTMLInputElement).blur();
            }
            if (event.key === "Escape") {
              setDraft(String(value));
              setEditing(false);
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
        <button
          type="button"
          className="font-size-chevron"
          aria-label="Font size options"
          aria-expanded={open}
          title="Font size"
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronIcon />
        </button>
        {open && (
          <div className="font-popover font-size-popover" role="listbox" aria-label="Font size">
            {DOCUMENT_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                role="option"
                aria-selected={value === size}
                className="font-option font-size-option"
                data-active={value === size}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applySize(size)}
              >
                {size}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className="tool font-step"
        title="Increase font size"
        aria-label="Increase font size"
        onClick={() => applySize(value + 1)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

function clampSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 11;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(value)));
}

function freezeRange(ref: { current: Range | null }) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    ref.current = null;
    return;
  }
  if (selection.isCollapsed) {
    const node = selection.anchorNode;
    const inSizeField =
      (node instanceof Element && node.closest(".font-size-field")) ||
      (node instanceof Node && node.parentElement?.closest(".font-size-field"));
    if (!inSizeField) ref.current = null;
    return;
  }
  ref.current = selection.getRangeAt(0).cloneRange();
}

function restoreRange(range: Range | null) {
  if (!range) return;
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="font-chevron">
      <path
        fill="currentColor"
        d="M4.3 6.2a.8.8 0 0 1 1.1 0L8 8.8l2.6-2.6a.8.8 0 1 1 1.1 1.1l-3.1 3.2a.8.8 0 0 1-1.2 0L4.3 7.3a.8.8 0 0 1 0-1.1Z"
      />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M3.5 7.2h9v1.6h-9z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M7.2 3.5h1.6v9H7.2zM3.5 7.2h9v1.6h-9z" />
    </svg>
  );
}

export const BLOCK_STYLES = [
  { value: "normal", label: "Normal text" },
  { value: "title", label: "Title" },
  { value: "subtitle", label: "Subtitle" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "h3", label: "Heading 3" },
] as const;

export type BlockStyleValue = (typeof BLOCK_STYLES)[number]["value"];

export const ZOOM_OPTIONS = [
  { value: "fit", label: "Fit" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
] as const;

export type ZoomValue = (typeof ZOOM_OPTIONS)[number]["value"];

type ToolbarSelectProps<T extends string> = {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onPick: (value: T) => void;
  ariaLabel: string;
  variant?: "style" | "zoom";
};

export function ToolbarSelect<T extends string>({
  value,
  options,
  onPick,
  ariaLabel,
  variant = "style",
}: ToolbarSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const frozenRange = useRef<Range | null>(null);
  const current = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`toolbar-menu toolbar-menu-${variant}`}
      onMouseDown={(event) => {
        freezeRange(frozenRange);
        event.preventDefault();
      }}
    >
      <button
        type="button"
        className={`toolbar-menu-btn is-${variant}`}
        aria-label={ariaLabel}
        aria-expanded={open}
        title={ariaLabel}
        onClick={() => setOpen((next) => !next)}
      >
        <span className="toolbar-menu-label">{current.label}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className={`font-popover toolbar-menu-popover is-${variant}`} role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={value === option.value}
              className="font-option toolbar-menu-option"
              data-active={value === option.value}
              data-style={variant === "style" ? option.value : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                restoreRange(frozenRange.current);
                onPick(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const LINE_SPACINGS = [
  { value: "1", label: "Single" },
  { value: "1.15", label: "1.15" },
  { value: "1.5", label: "1.5" },
  { value: "2", label: "Double" },
];

type SpacingProps = {
  value: string;
  onPick: (value: string) => void;
};

export function LineSpacingPicker({ value, onPick }: SpacingProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const frozenRange = useRef<Range | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="font-tool"
      onMouseDown={(event) => {
        freezeRange(frozenRange);
        event.preventDefault();
      }}
    >
      <button
        type="button"
        className="tool"
        title="Line spacing"
        aria-label="Line spacing"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <LineSpacingIcon />
      </button>
      {open && (
        <div className="font-popover spacing-popover" role="listbox" aria-label="Line spacing">
          {LINE_SPACINGS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={value === option.value}
              className="font-option"
              data-active={value === option.value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                restoreRange(frozenRange.current);
                onPick(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LineSpacingIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M7.2 5.2 4.8 7.6H6.4v8.8H4.8l2.4 2.4 2.4-2.4H8.1V7.6h1.5L7.2 5.2ZM12 6.2h8v1.8h-8V6.2Zm0 4.9h8v1.8h-8v-1.8Zm0 4.9h8v1.8h-8v-1.8Z"
      />
    </svg>
  );
}
