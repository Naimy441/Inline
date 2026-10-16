"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode } from "react";
import type { EditorView } from "prosemirror-view";
import type { DocumentSession } from "@/lib/client/documentSession";
import type { TabStop } from "@/lib/doc/schema";
import { edgesToAttrs, indentEdges, paragraphAtSelection, setParagraphIndents, type IndentEdges } from "@/lib/editor/indents";

const PX_PER_IN = 96;
const PX_PER_PT = 96 / 72;

type DragKind = "first" | "body" | "both" | "end";

type Markers = { first: number; body: number; end: number };

/**
 * The horizontal ruler above the page (View → Show ruler). Margin bands mark
 * the page margins. The markers are the current paragraph's first-line, left
 * and right indents; dragging one writes that paragraph's existing indent
 * attributes. Tab stops already on the paragraph are drawn, not edited.
 */
export function Ruler({
  session,
  zoom,
  pageWidth,
  marginLeft,
  marginRight,
  tabStop,
}: {
  session: DocumentSession;
  zoom: number;
  /** Page size and margins in CSS px at 100% zoom. */
  pageWidth: number;
  marginLeft: number;
  marginRight: number;
  tabStop: number;
}) {
  const state = useSyncExternalStore(session.editor.subscribe, session.editor.get, session.editor.get);
  const block = state ? paragraphAtSelection(state) : null;
  const rtl = block?.node.attrs.dir === "rtl";
  const edges = indentEdges(Number(block?.node.attrs.indent) || 0, (block?.node.attrs.textIndent as number | null) ?? null, Number(block?.node.attrs.rightIndent) || 0);
  const contentInches = Math.max(0.5, (pageWidth - marginLeft - marginRight) / PX_PER_IN);
  const width = pageWidth * zoom;
  const [measured, setMeasured] = useState<Markers | null>(null);
  const [dragging, setDragging] = useState<DragKind | null>(null);
  const drag = useRef<{ kind: DragKind; startX: number; start: IndentEdges; rtl: boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const view = session.view;
    if (!view || !block) {
      setMeasured(null);
      return;
    }
    const next = measureMarkers(view, block.pos);
    setMeasured((prev) => (prev && next && near(prev, next) ? prev : next));
  }, [session, block, state, zoom, pageWidth, marginLeft, marginRight]);

  const fallback = modelMarkers(edges, pageWidth, marginLeft, marginRight, zoom, rtl);
  const markers = measured ?? fallback;
  const editable = Boolean(session.view?.editable && block);
  const tabs = tabMarks(block?.node.attrs.tabs as TabStop[] | null, tabStop, pageWidth, marginLeft, marginRight, zoom);

  const move = (kind: DragKind, clientX: number) => {
    const current = drag.current;
    const view = session.view;
    if (!current || current.kind !== kind || !view) return;
    const delta = (clientX - current.startX) / (PX_PER_IN * zoom);
    const startSign = current.rtl ? -1 : 1;
    const next: IndentEdges = {
      body: current.start.body + (kind === "body" || kind === "both" ? startSign * delta : 0),
      first: current.start.first + (kind === "first" || kind === "both" ? startSign * delta : 0),
      right: current.start.right + (kind === "end" ? (current.rtl ? 1 : -1) * delta : 0),
    };
    const attrs = edgesToAttrs(next.body, next.first, next.right, contentInches);
    setParagraphIndents(attrs)(view.state, (tr) => session.dispatch(tr));
  };

  const begin = (kind: DragKind, event: PointerEvent<HTMLButtonElement>) => {
    if (!editable || !block) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind, startX: event.clientX, start: edges, rtl: Boolean(rtl) };
    setDragging(kind);
  };

  const end = () => {
    drag.current = null;
    setDragging(null);
  };

  return (
    <div className="ruler-row">
      <div ref={root} className="ruler" style={{ width }} role="group" aria-label="Ruler">
        <svg className="ruler-scale" width={width} height={24} aria-hidden>
          <rect className="ruler-margin" x={0} y={0} width={Math.max(0, marginLeft * zoom)} height={24} />
          <rect className="ruler-margin" x={(pageWidth - marginRight) * zoom} y={0} width={Math.max(0, marginRight * zoom)} height={24} />
          {ticks(pageWidth, marginLeft, marginRight, zoom).map((tick) => (
            <g key={tick.x}>
              {tick.label != null ? (
                <text className="ruler-label" x={tick.x} y={12} textAnchor="middle">
                  {tick.label}
                </text>
              ) : (
                <line className="ruler-tick" x1={tick.x} x2={tick.x} y1={0} y2={tick.size} />
              )}
            </g>
          ))}
          {tabs.map((tab) => (
            <TabMark key={`${tab.custom ? "c" : "d"}-${tab.x}-${tab.align}`} x={tab.x} align={tab.align} custom={tab.custom} />
          ))}
        </svg>
        <Marker kind="first" label="First line indent" x={markers.first} disabled={!editable} dragging={dragging === "first"} onBegin={begin} onMove={move} onEnd={end}>
          <path d="M1 1h10L6 8z" />
        </Marker>
        <Marker kind="body" label="Hanging indent" x={markers.body} disabled={!editable} dragging={dragging === "body"} onBegin={begin} onMove={move} onEnd={end}>
          <path d="M6 1L11 8H1z" />
        </Marker>
        <Marker kind="both" label="Left indent" x={markers.body} disabled={!editable} dragging={dragging === "both"} onBegin={begin} onMove={move} onEnd={end}>
          <rect x="1" y="1" width="10" height="4" />
        </Marker>
        <Marker kind="end" label="Right indent" x={markers.end} disabled={!editable} dragging={dragging === "end"} onBegin={begin} onMove={move} onEnd={end}>
          <path d="M6 1L11 8H1z" />
        </Marker>
      </div>
    </div>
  );
}

function Marker({
  kind,
  label,
  x,
  disabled,
  dragging,
  onBegin,
  onMove,
  onEnd,
  children,
}: {
  kind: DragKind;
  label: string;
  x: number;
  disabled: boolean;
  dragging: boolean;
  onBegin: (kind: DragKind, event: PointerEvent<HTMLButtonElement>) => void;
  onMove: (kind: DragKind, clientX: number) => void;
  onEnd: () => void;
  children: ReactNode;
}) {
  const name = kind === "both" ? "left" : kind === "body" ? "hanging" : kind === "end" ? "right" : "first";
  return (
    <button
      type="button"
      className={`ruler-marker is-${name}${dragging ? " is-dragging" : ""}`}
      style={{ left: x }}
      aria-label={label}
      title={label}
      data-indent={name}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => onBegin(kind, event)}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) onMove(kind, event.clientX);
      }}
      onPointerUp={onEnd}
      onPointerCancel={onEnd}
    >
      <svg width="12" height="9" viewBox="0 0 12 9" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

function TabMark({ x, align, custom }: { x: number; align: TabStop["align"]; custom: boolean }) {
  const bar = align === "right" || align === "decimal" ? -5 : align === "center" ? -2.5 : 0;
  return (
    <g className={custom ? "ruler-tab is-custom" : "ruler-tab"} transform={`translate(${x} 16)`}>
      <line x1={0} x2={0} y1={0} y2={7} />
      <line x1={bar} x2={bar + 5} y1={0} y2={0} />
      {align === "decimal" && <circle cx={2} cy={5} r={0.9} />}
    </g>
  );
}

function ticks(pageWidth: number, marginLeft: number, marginRight: number, zoom: number) {
  const eighth = (PX_PER_IN / 8) * zoom;
  const contentStart = marginLeft * zoom;
  const contentEnd = (pageWidth - marginRight) * zoom;
  const out: Array<{ x: number; size: number; label?: string }> = [];
  if (eighth < 1) return out;
  for (let i = 0, x = 0; x <= pageWidth * zoom + 0.5; i += 1, x = i * eighth) {
    const eighths = i % 8;
    const fromMargin = (x - contentStart) / (PX_PER_IN * zoom);
    const inContent = x >= contentStart - 0.5 && x <= contentEnd + 0.5;
    if (eighths === 0) {
      const label = inContent && fromMargin >= -0.01 ? String(Math.round(fromMargin)) : undefined;
      out.push({ x, size: label ? 0 : 8, ...(label ? { label } : {}) });
    }
    else if (eighths === 4) out.push({ x, size: 7 });
    else out.push({ x, size: 4 });
  }
  return out;
}

function tabMarks(tabs: TabStop[] | null, tabStop: number, pageWidth: number, marginLeft: number, marginRight: number, zoom: number) {
  const contentPt = ((pageWidth - marginLeft - marginRight) / PX_PER_IN) * 72;
  const step = Math.max(1, tabStop);
  const custom = (tabs ?? []).filter((tab) => tab.pos > 0 && tab.pos < contentPt + step);
  const out: Array<{ x: number; align: TabStop["align"]; custom: boolean }> = [];
  for (let pos = step; pos < contentPt - 1; pos += step) {
    if (custom.some((tab) => Math.abs(tab.pos - pos) < step / 2)) continue;
    out.push({ x: (marginLeft + pos * PX_PER_PT) * zoom, align: "left", custom: false });
  }
  for (const tab of custom) out.push({ x: (marginLeft + tab.pos * PX_PER_PT) * zoom, align: tab.align, custom: true });
  return out;
}

function modelMarkers(edges: IndentEdges, pageWidth: number, marginLeft: number, marginRight: number, zoom: number, rtl: boolean): Markers {
  const inch = PX_PER_IN * zoom;
  if (rtl) {
    const start = (pageWidth - marginRight) * zoom;
    return { first: start - edges.first * inch, body: start - edges.body * inch, end: marginLeft * zoom + edges.right * inch };
  }
  return {
    first: marginLeft * zoom + edges.first * inch,
    body: marginLeft * zoom + edges.body * inch,
    end: (pageWidth - marginRight) * zoom - edges.right * inch,
  };
}

/** Marker positions in ruler pixels, from the paragraph as laid out on the page. */
function measureMarkers(view: EditorView, pos: number): Markers | null {
  const page = view.dom.closest(".page-stack");
  if (!(page instanceof HTMLElement) || !page.offsetWidth) return null;
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  const pageBox = page.getBoundingClientRect();
  if (!pageBox.width) return null;
  const scale = pageBox.width / page.offsetWidth;
  const local = (x: number) => (x - pageBox.left) / scale;
  const box = dom.getBoundingClientRect();
  const style = getComputedStyle(dom);
  const rtl = style.direction === "rtl";
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padRight = parseFloat(style.paddingRight) || 0;
  const borderLeft = parseFloat(style.borderLeftWidth) || 0;
  const borderRight = parseFloat(style.borderRightWidth) || 0;
  const textIndent = parseFloat(style.textIndent) || 0;
  const toRuler = (localX: number) => localX * scale;
  if (!rtl) {
    const body = local(box.left) + borderLeft + padLeft;
    return { body: toRuler(body), first: toRuler(body + textIndent), end: toRuler(local(box.right) - borderRight - padRight) };
  }
  const body = local(box.right) - borderRight - padRight;
  return { body: toRuler(body), first: toRuler(body - textIndent), end: toRuler(local(box.left) + borderLeft + padLeft) };
}

function near(a: Markers, b: Markers) {
  return Math.abs(a.first - b.first) < 0.5 && Math.abs(a.body - b.body) < 0.5 && Math.abs(a.end - b.end) < 0.5;
}
