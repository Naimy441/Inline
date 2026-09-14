"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffPart } from "@/lib/diff";
import { EMOJI_CATEGORIES, filterEmojis } from "@/lib/emojis";
import { PAPER_SIZES, type PageLayout, type PaperSize } from "@/lib/pagination";

type DialogProps = {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
};

export function Dialog({ title, onClose, children, wide }: DialogProps) {
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        className={`dialog ${wide ? "dialog-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function SearchReplaceDialog({
  onClose,
  onFind,
  onReplace,
  onReplaceAll,
}: {
  onClose: () => void;
  onFind: (query: string) => boolean;
  onReplace: (query: string, replacement: string) => boolean;
  onReplaceAll: (query: string, replacement: string) => number;
}) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [status, setStatus] = useState("");

  return (
    <Dialog title="Find and replace" onClose={onClose}>
      <label className="field">
        Find
        <input value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
      </label>
      <label className="field">
        Replace with
        <input value={replacement} onChange={(event) => setReplacement(event.target.value)} />
      </label>
      <p className="dialog-status">{status}</p>
      <div className="dialog-actions">
        <button
          type="button"
          onClick={() => setStatus(onFind(query) ? "Found a match." : "No more matches.")}
        >
          Next
        </button>
        <button
          type="button"
          onClick={() => setStatus(onReplace(query, replacement) ? "Replaced." : "Nothing to replace.")}
        >
          Replace
        </button>
        <button
          type="button"
          onClick={() => setStatus(`Replaced ${onReplaceAll(query, replacement)} matches.`)}
        >
          Replace all
        </button>
      </div>
    </Dialog>
  );
}

export function WordCountDialog({
  words,
  chars,
  paragraphs,
  pages,
  selectionWords,
  onClose,
}: {
  words: number;
  chars: number;
  paragraphs: number;
  pages: number;
  selectionWords: number;
  onClose: () => void;
}) {
  return (
    <Dialog title="Word count" onClose={onClose}>
      <dl className="stats">
        <div><dt>Pages</dt><dd>{pages}</dd></div>
        <div><dt>Words</dt><dd>{words}</dd></div>
        <div><dt>Characters</dt><dd>{chars}</dd></div>
        <div><dt>Paragraphs</dt><dd>{paragraphs}</dd></div>
        <div><dt>Words in selection</dt><dd>{selectionWords}</dd></div>
      </dl>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

export function PageSetupDialog({
  layout,
  onClose,
  onApply,
}: {
  layout: PageLayout;
  onClose: () => void;
  onApply: (layout: PageLayout) => void;
}) {
  const [paperSize, setPaperSize] = useState<PaperSize>(layout.paperSize);
  const [margins, setMargins] = useState({
    top: layout.marginTop / 96,
    right: layout.marginRight / 96,
    bottom: layout.marginBottom / 96,
    left: layout.marginLeft / 96,
  });
  const paper = PAPER_SIZES[paperSize];
  const updateMargin = (key: keyof typeof margins, value: string) => {
    const next = Number(value);
    setMargins((current) => ({ ...current, [key]: Number.isFinite(next) ? Math.max(0.25, Math.min(3, next)) : current[key] }));
  };

  return (
    <Dialog title="Page setup" onClose={onClose}>
      <label className="field">
        Paper size
        <select value={paperSize} onChange={(event) => setPaperSize(event.target.value as PaperSize)}>
          {(Object.keys(PAPER_SIZES) as PaperSize[]).map((size) => (
            <option key={size} value={size}>{PAPER_SIZES[size].label}</option>
          ))}
        </select>
      </label>
      <p className="dialog-help">Set margins in inches. Changes reflow the document immediately.</p>
      <div className="field-row page-margin-grid">
        {(["top", "right", "bottom", "left"] as const).map((key) => (
          <label className="field" key={key}>
            {key[0].toUpperCase() + key.slice(1)}
            <input
              type="number"
              min={0.25}
              max={3}
              step={0.05}
              value={margins[key]}
              onChange={(event) => updateMargin(key, event.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="primary"
          onClick={() => onApply({
            paperSize,
            width: paper.width,
            height: paper.height,
            marginTop: margins.top * 96,
            marginRight: margins.right * 96,
            marginBottom: margins.bottom * 96,
            marginLeft: margins.left * 96,
          })}
        >
          Apply
        </button>
      </div>
    </Dialog>
  );
}

export function LinkDialog({
  initialText,
  onClose,
  onInsert,
}: {
  initialText: string;
  onClose: () => void;
  onInsert: (url: string, text: string) => void;
}) {
  const [url, setUrl] = useState("https://");
  const [text, setText] = useState(initialText);

  return (
    <Dialog title="Insert link" onClose={onClose}>
      <label className="field">
        Text
        <input value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <label className="field">
        URL
        <input value={url} onChange={(event) => setUrl(event.target.value)} autoFocus />
      </label>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={() => onInsert(url, text)}>
          Apply
        </button>
      </div>
    </Dialog>
  );
}

export function TableDialog({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  onInsert: (rows: number, cols: number) => void;
}) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  return (
    <Dialog title="Insert table" onClose={onClose}>
      <div className="field-row">
        <label className="field">
          Rows
          <input type="number" min={1} max={12} value={rows} onChange={(event) => setRows(Number(event.target.value))} />
        </label>
        <label className="field">
          Columns
          <input type="number" min={1} max={8} value={cols} onChange={(event) => setCols(Number(event.target.value))} />
        </label>
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={() => onInsert(rows, cols)}>
          Insert
        </button>
      </div>
    </Dialog>
  );
}

export function EmojiDialog({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  onInsert: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(EMOJI_CATEGORIES[0].id);
  const emojis = useMemo(() => filterEmojis(query, category), [query, category]);

  return (
    <Dialog title="Insert emoji" onClose={onClose} wide>
      <label className="field">
        Search
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search smile, heart, fire…"
          autoFocus
        />
      </label>
      <div className="emoji-cats" role="tablist" aria-label="Emoji categories">
        {EMOJI_CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={category === item.id}
            title={item.label}
            data-active={category === item.id}
            onClick={() => {
              setCategory(item.id);
              setQuery("");
            }}
          >
            <span aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <div className="emoji-grid" role="listbox" aria-label="Emojis">
        {emojis.map((emoji, index) => (
          <button
            key={`${emoji}-${index}`}
            type="button"
            title={emoji}
            onClick={() => onInsert(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      {emojis.length === 0 && <p className="dialog-status">No matching emoji.</p>}
    </Dialog>
  );
}

const SPECIALS = [
  "©", "®", "™", "°", "±", "–", "—", "…", "“", "”", "‘", "’",
  "«", "»", "≤", "≥", "≠", "×", "÷", "√", "∞", "€", "£", "¥",
  "§", "¶", "•", "†", "‡", "←", "→", "↑", "↓", "½", "¼", "¾",
];

export function SpecialCharsDialog({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  onInsert: (value: string) => void;
}) {
  return (
    <Dialog title="Special characters" onClose={onClose}>
      <div className="char-grid">
        {SPECIALS.map((char) => (
          <button key={char} type="button" onClick={() => onInsert(char)}>
            {char}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

export function CompareDialog({
  currentText,
  onClose,
}: {
  currentText: string;
  onClose: () => void;
}) {
  const [other, setOther] = useState("");
  const [parts, setParts] = useState<DiffPart[] | null>(null);

  return (
    <Dialog title="Compare documents" onClose={onClose} wide>
      <p className="dialog-help">Paste another version to see additions and deletions.</p>
      <label className="field">
        Other document
        <textarea rows={7} value={other} onChange={(event) => setOther(event.target.value)} />
      </label>
      <div className="dialog-actions">
        <button
          type="button"
          className="primary"
          onClick={async () => {
            const { diffWords } = await import("@/lib/diff");
            setParts(diffWords(currentText, other));
          }}
        >
          Compare
        </button>
      </div>
      {parts && (
        <div className="diff-view">
          {parts.map((part, index) => (
            <span key={index} className={`diff-${part.type}`}>
              {part.text}
            </span>
          ))}
        </div>
      )}
    </Dialog>
  );
}

export function CitationDialog({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  onInsert: (citation: { author: string; title: string; year: string; url: string }) => void;
}) {
  const [author, setAuthor] = useState("");
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [url, setUrl] = useState("");

  return (
    <Dialog title="Insert citation" onClose={onClose}>
      <label className="field">Author<input value={author} onChange={(event) => setAuthor(event.target.value)} /></label>
      <label className="field">Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="field">Year<input value={year} onChange={(event) => setYear(event.target.value)} /></label>
      <label className="field">URL<input value={url} onChange={(event) => setUrl(event.target.value)} /></label>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" onClick={() => onInsert({ author, title, year, url })}>
          Insert
        </button>
      </div>
    </Dialog>
  );
}

export function SignatureDialog({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  onInsert: (dataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.strokeStyle = "#202124";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
  }, []);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  return (
    <Dialog title="eSignature" onClose={onClose}>
      <p className="dialog-help">Draw a signature, then insert it at the caret.</p>
      <canvas
        ref={canvasRef}
        className="signature-pad"
        width={420}
        height={140}
        onPointerDown={(event) => {
          drawing.current = true;
          const ctx = canvasRef.current?.getContext("2d");
          const { x, y } = point(event);
          ctx?.beginPath();
          ctx?.moveTo(x, y);
        }}
        onPointerMove={(event) => {
          if (!drawing.current) return;
          const ctx = canvasRef.current?.getContext("2d");
          const { x, y } = point(event);
          ctx?.lineTo(x, y);
          ctx?.stroke();
        }}
        onPointerUp={() => {
          drawing.current = false;
        }}
      />
      <div className="dialog-actions">
        <button
          type="button"
          onClick={() => {
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext("2d");
            if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
          }}
        >
          Clear
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            const canvas = canvasRef.current;
            if (canvas) onInsert(canvas.toDataURL("image/png"));
          }}
        >
          Insert
        </button>
      </div>
    </Dialog>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <ul className="shortcut-list">
        <li><kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd> Undo</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> Redo</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>X</kbd> / <kbd>C</kbd> / <kbd>V</kbd> Cut, copy, paste</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> Paste without formatting</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>A</kbd> Select all</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>F</kbd> Find and replace</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>K</kbd> Inline edit (selection) or insert link</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>J</kbd> Open chat</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> Command palette</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> Fix grammar</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> Version history</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> Focus mode</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>Y</kbd> Keep hovered change</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>N</kbd> Undo hovered change</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>B</kbd> / <kbd>I</kbd> / <kbd>U</kbd> Bold, italic, underline</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>8</kbd> Bullet list</li>
        <li><kbd>⌘/Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> Comment</li>
        <li><kbd>/</kbd> Templates in an empty paragraph</li>
        <li><kbd>F11</kbd> Full screen</li>
      </ul>
    </Dialog>
  );
}
