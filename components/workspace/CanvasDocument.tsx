"use client";

import { ChevronRight, Play } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import {
  canvasStyle,
  parseCanvas,
  sanitizeLayoutHtml,
  setCellLanguage,
  setRegionMode,
  setRegionText,
  setSectionOpen,
  visibleText,
  type CanvasBlock,
  type CanvasOutput,
  type CellLanguage,
  type RegionMode,
} from "@/lib/doc/canvas";

const MODES: Array<{ mode: RegionMode; label: string }> = [
  { mode: "text", label: "Text" },
  { mode: "structure", label: "Layout" },
  { mode: "code", label: "Code" },
];

/**
 * The canvas the user sees. PageCanvas stays mounted behind it so the live
 * session keeps running; this view edits the HTML, not the page projection.
 */
export function CanvasDocument({
  session,
  html,
  outputs,
  readOnly,
}: {
  session: DocumentSession;
  html: string;
  outputs: Record<string, CanvasOutput>;
  readOnly: boolean;
}) {
  const [local, setLocal] = useState(html);
  const latest = useRef(html);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [runError, setRunError] = useState<Record<string, string>>({});

  useEffect(() => {
    if (dirty.current || html === latest.current) return;
    latest.current = html;
    setLocal(html);
  }, [html]);

  useEffect(() => {
    session.canvasFlusher = async () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (dirty.current) await flush();
    };
    return () => {
      if (session.canvasFlusher) session.canvasFlusher = null;
      if (timer.current) clearTimeout(timer.current);
      if (dirty.current) void session.saveCanvas(latest.current).catch(() => undefined);
    };
    // flush closes over session, which is stable for this document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const update = (next: string) => {
    latest.current = next;
    dirty.current = true;
    setLocal(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 400);
  };

  const flush = async () => {
    timer.current = null;
    const sending = latest.current;
    try {
      const saved = await session.saveCanvas(sending);
      if (latest.current !== sending) return;
      dirty.current = false;
      if (saved && saved !== sending) {
        latest.current = saved;
        setLocal(saved);
      }
    } catch {
      // The session already shows the save as failed.
    }
  };

  const run = async (cellId: string) => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (dirty.current) await flush();
    setRunning(cellId);
    setRunError((current) => ({ ...current, [cellId]: "" }));
    try {
      await session.runCell(cellId);
    } catch (error) {
      setRunError((current) => ({ ...current, [cellId]: error instanceof Error ? error.message : "The cell failed." }));
    } finally {
      setRunning((current) => (current === cellId ? null : current));
    }
  };

  const model = useMemo(() => parseCanvas(local), [local]);
  const style = canvasStyle(model.style);

  return (
    <article className="canvas-doc">
      {style ? <style>{style}</style> : null}
      {model.sections.map((section) => (
        <section key={section.id} className={`canvas-section${section.open ? "" : " is-closed"}`} id={section.id}>
          <header className="canvas-section-head">
            <button
              type="button"
              className="canvas-section-toggle"
              aria-expanded={section.open}
              aria-label={section.open ? "Collapse section" : "Expand section"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => update(setSectionOpen(latest.current, section.id, !section.open))}
            >
              <ChevronRight size={16} />
            </button>
            {section.headingId ? (
              <PlainField
                className="canvas-heading"
                label="Section title"
                value={section.title}
                readOnly={readOnly}
                region={section.headingId}
                onChange={(text) => update(setRegionText(latest.current, section.headingId, text))}
              />
            ) : (
              <h2 className="canvas-heading">{section.title}</h2>
            )}
          </header>
          {section.open && (
            <div className="canvas-section-body">
              {section.blocks.map((block) => (
                <Region
                  key={block.id || block.kind}
                  block={block}
                  output={block.kind === "cell" ? outputs[block.id] : undefined}
                  runError={block.kind === "cell" ? runError[block.id] : undefined}
                  running={running === block.id}
                  readOnly={readOnly}
                  onText={(text, asHtml) => update(setRegionText(latest.current, block.id, text, asHtml))}
                  onMode={(mode) => update(setRegionMode(latest.current, block.id, mode))}
                  onLanguage={(language) => update(setCellLanguage(latest.current, block.id, language))}
                  onRun={() => void run(block.id)}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </article>
  );
}

function Region({
  block,
  output,
  runError,
  running,
  readOnly,
  onText,
  onMode,
  onLanguage,
  onRun,
}: {
  block: CanvasBlock;
  output?: CanvasOutput;
  runError?: string;
  running: boolean;
  readOnly: boolean;
  onText: (text: string, asHtml: boolean) => void;
  onMode: (mode: RegionMode) => void;
  onLanguage: (language: CellLanguage) => void;
  onRun: () => void;
}) {
  const source = block.kind === "layout" ? block.html : block.kind === "heading" || block.kind === "text" ? block.text : block.source;
  const asHtml = block.kind === "layout";
  return (
    <div className={`canvas-region is-${block.kind} is-${block.mode}`} data-canvas-region={block.id}>
      <div className="canvas-region-tools">
        <div className="canvas-mode" role="group" aria-label="How this part is edited">
          {MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              className={block.mode === item.mode ? "is-on" : ""}
              aria-pressed={block.mode === item.mode}
              disabled={readOnly}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onMode(item.mode)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {block.kind === "cell" && (
          <>
            <label className="canvas-lang">
              <span className="sr-only">Language</span>
              <select value={block.language} disabled={readOnly} onChange={(event) => onLanguage(event.target.value as CellLanguage)}>
                <option value="javascript">JavaScript</option>
                <option value="python">Python</option>
              </select>
            </label>
            <button type="button" className="canvas-run" onClick={onRun} disabled={running || readOnly}>
              <Play size={13} />
              {running ? "Running" : "Run"}
            </button>
          </>
        )}
      </div>
      {block.mode === "structure" ? (
        <div className="canvas-layout" dangerouslySetInnerHTML={{ __html: sanitizeLayoutHtml(block.kind === "layout" ? block.html : `<p>${escapeForLayout(source)}</p>`) }} />
      ) : block.mode === "code" ? (
        <textarea className="canvas-code" aria-label={block.kind === "cell" ? "Cell source" : "Source"} spellCheck={false} readOnly={readOnly} value={source} onChange={(event) => onText(event.target.value, asHtml)} />
      ) : (
        <PlainField className="canvas-text" label={block.kind === "cell" ? "Cell source" : "Editable text"} region={block.id} value={block.kind === "layout" ? visibleText(block.html) : source} readOnly={readOnly} onChange={(text) => onText(text, false)} />
      )}
      {block.kind === "cell" && (output || runError) && (
        <pre className={`canvas-output${output?.error || runError ? " is-error" : ""}`}>{runError || output?.error || output?.stdout || output?.stderr || "(no output)"}</pre>
      )}
    </div>
  );
}

function escapeForLayout(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function PlainField({
  value,
  className,
  label,
  readOnly,
  region,
  onChange,
}: {
  value: string;
  className: string;
  label: string;
  readOnly: boolean;
  region?: string;
  onChange: (text: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || document.activeElement === node) return;
    if ((node.textContent ?? "") !== value) node.textContent = value;
  }, [value]);
  return (
    <div
      ref={ref}
      className={className}
      role="textbox"
      aria-label={label}
      aria-multiline="true"
      data-canvas-field={region}
      contentEditable={readOnly ? "false" : "plaintext-only"}
      suppressContentEditableWarning
      onInput={(event) => onChange(event.currentTarget.textContent ?? "")}
    />
  );
}
