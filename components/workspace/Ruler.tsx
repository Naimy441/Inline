"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { DocumentSession } from "@/lib/client/documentSession";
import type { TabStop } from "@/lib/doc/schema";
import { DEFAULT_TAB_STOP } from "@/lib/doc/settings";
import {
  dragGeometry,
  indentGeometry,
  markerPositions,
  paragraphsInSelection,
  roundInches,
  setParagraphIndents,
  shiftIndent,
  snapInches,
  writeIndentPreview,
  ZERO_INDENT,
  type IndentGeometry,
  type MarkerKind,
} from "@/lib/editor/ruler";

const MARKERS: Array<{ kind: MarkerKind; label: string; className: string }> = [
  { kind: "first", label: "First-line indent", className: "is-first" },
  { kind: "left", label: "Left indent", className: "is-left" },
  { kind: "margin", label: "Left margin", className: "is-margin" },
  { kind: "right", label: "Right indent", className: "is-right" },
];

/**
 * A horizontal ruler above the page, in the document's inches. It lines up
 * with the page and grows with the zoom. The markers belong to the paragraph
 * the caret is in (or every paragraph in the selection, when one is dragged).
 */
export function Ruler({
  session,
  canvasRef,
  geometry,
  zoom,
  tabStop = DEFAULT_TAB_STOP,
}: {
  session: DocumentSession;
  canvasRef: RefObject<HTMLElement | null>;
  geometry: { pageWidth: number; marginLeft: number; marginRight: number };
  zoom: number;
  /** Default tab stop, in points, from the document's page setup. */
  tabStop?: number;
}) {
  const state = useSyncExternalStore(session.editor.subscribe, session.editor.get, () => null);
  const barRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [box, setBox] = useState({ left: 0, width: 0 });
  const [inset, setInset] = useState<IndentGeometry>(ZERO_INDENT);
  const [drag, setDrag] = useState<IndentGeometry | null>(null);
  const [active, setActive] = useState<MarkerKind | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const bar = barRef.current;
    if (!canvas || !bar) return;
    const measure = () => {
      const frame = canvas.querySelector(".page-stack-frame");
      if (!frame) return;
      const next = frame.getBoundingClientRect();
      const origin = bar.getBoundingClientRect();
      const left = next.left - origin.left;
      const width = next.width;
      setBox((current) => (Math.abs(current.left - left) < 0.5 && Math.abs(current.width - width) < 0.5 ? current : { left, width }));
    };
    measure();
    canvas.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    for (const selector of [".page-stack-wrap", ".page-stack-frame"]) {
      const node = canvas.querySelector(selector);
      if (node) observer.observe(node);
    }
    window.addEventListener("resize", measure);
    return () => {
      canvas.removeEventListener("scroll", measure);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [canvasRef, zoom, geometry.pageWidth, geometry.marginLeft, geometry.marginRight]);

  const head = state ? headBlock(state) : null;
  const model = head ? indentGeometry(head.node.attrs) : ZERO_INDENT;
  const rtl = head?.node.attrs.dir === "rtl";
  const contentWidth = Math.max(0.5, (geometry.pageWidth - geometry.marginLeft - geometry.marginRight) / 96);

  useLayoutEffect(() => {
    if (dragging.current) return;
    const view = session.view;
    if (!view || !head || rtl) {
      setInset((current) => (current === ZERO_INDENT ? current : ZERO_INDENT));
      return;
    }
    const next = measureInset(view.dom, view.nodeDOM(head.pos), model);
    setInset((current) => (sameGeometry(current, next) ? current : next));
  }, [session, head, model, rtl, zoom, box.width]);

  const shown = drag ?? model;
  const display = shiftIndent(shown, inset, 1);
  const positions = markerPositions(display, contentWidth, rtl);
  const pageInches = geometry.pageWidth / 96;
  const pxPerInch = box.width > 0 && pageInches > 0 ? box.width / pageInches : 96 * zoom;

  const onPointerDown = (kind: MarkerKind) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    const view = session.view;
    if (!view?.editable || !state || !head) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startModel = indentGeometry(head.node.attrs);
    const startRtl = head.node.attrs.dir === "rtl";
    const startInset = startRtl ? ZERO_INDENT : measureInset(view.dom, view.nodeDOM(head.pos), startModel);
    const startDisplay = shiftIndent(startModel, startInset, 1);
    const origin = markerPositions(startDisplay, contentWidth, startRtl)[kind];
    const previews = paragraphsInSelection(state).flatMap(({ pos, node }) => {
      const dom = view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return [];
      return [{ dom, style: dom.getAttribute("style"), rtl: node.attrs.dir === "rtl" }];
    });
    dragging.current = true;
    setActive(kind);
    let latest = startModel;
    let moved = false;
    const apply = (clientX: number) => {
      const pointer = pointerInches(clientX, trackRef.current, pageInches, geometry.marginLeft / 96);
      const snapped = snapInches(pointer);
      const delta = snapped === snapInches(origin) && Math.abs(pointer - origin) < 0.125 ? 0 : snapped - origin;
      const nextDisplay = dragGeometry(startDisplay, kind, delta, contentWidth, startRtl);
      latest = shiftIndent(nextDisplay, startInset, -1);
      latest = {
        first: Math.max(0, latest.first),
        left: Math.max(0, latest.left),
        right: Math.max(0, latest.right),
      };
      if (delta !== 0) moved = true;
      for (const preview of previews) writeIndentPreview(preview.dom, latest, preview.rtl);
      setDrag(latest);
    };
    const end = (endEvent: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", cancel);
      apply(endEvent.clientX);
      for (const preview of previews) {
        if (preview.style == null) preview.dom.removeAttribute("style");
        else preview.dom.setAttribute("style", preview.style);
      }
      dragging.current = false;
      setActive(null);
      setDrag(null);
      if (moved && view.editable) setParagraphIndents(latest)(view.state, (tr) => session.dispatch(tr), view);
    };
    const move = (moveEvent: PointerEvent) => apply(moveEvent.clientX);
    const cancel = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", cancel);
      for (const preview of previews) {
        if (preview.style == null) preview.dom.removeAttribute("style");
        else preview.dom.setAttribute("style", preview.style);
      }
      dragging.current = false;
      setActive(null);
      setDrag(null);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", cancel);
  };

  return (
    <div ref={barRef} className="doc-ruler-bar" role="region" aria-label="Ruler, inches" onPointerDown={(event) => event.preventDefault()}>
      {box.width > 0 && (
        <div ref={trackRef} className="doc-ruler-track" style={{ transform: `translateX(${box.left}px)`, width: box.width }} data-page-inches={pageInches}>
          <div className="doc-ruler-shade is-left" style={{ width: (geometry.marginLeft / 96) * pxPerInch }} />
          <div className="doc-ruler-shade is-right" style={{ width: (geometry.marginRight / 96) * pxPerInch }} />
          <Ticks width={box.width} pageInches={pageInches} marginLeft={geometry.marginLeft / 96} contentWidth={contentWidth} pxPerInch={pxPerInch} />
          {tabMarks(head?.node.attrs.tabs as TabStop[] | null, tabStop, contentWidth).map((tab) => (
            <span
              key={`${tab.custom ? "custom" : "default"}-${tab.align}-${tab.inches}`}
              className={`doc-ruler-tab${tab.custom ? " is-custom" : ""} is-${tab.align}`}
              style={{ left: (geometry.marginLeft / 96 + tab.inches) * pxPerInch }}
            />
          ))}
          {head &&
            MARKERS.map((marker) => (
              <button
                key={marker.kind}
                type="button"
                role="slider"
                className={`doc-ruler-marker ${marker.className}${active === marker.kind ? " is-dragging" : ""}`}
                style={{ left: (geometry.marginLeft / 96 + positions[marker.kind]) * pxPerInch }}
                aria-label={marker.label}
                aria-valuemin={0}
                aria-valuemax={Math.round(contentWidth * 8) / 8}
                aria-valuenow={roundInches(marker.kind === "right" ? shown.right : marker.kind === "first" ? shown.first : shown.left)}
                aria-valuetext={`${roundInches(marker.kind === "right" ? shown.right : marker.kind === "first" ? shown.first : shown.left)} inches`}
                title={marker.label}
                onMouseDown={(event) => event.preventDefault()}
                onPointerDown={onPointerDown(marker.kind)}
              >
                <MarkerShape kind={marker.kind} />
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** Tab stops already on the paragraph, plus the document's default stops. Drawn, not edited. */
function tabMarks(custom: TabStop[] | null, defaultPt: number, contentWidth: number) {
  const step = Math.max(1, defaultPt) / 72;
  const marks: Array<{ inches: number; align: TabStop["align"]; custom: boolean }> = [];
  for (const tab of custom ?? []) {
    const inches = tab.pos / 72;
    if (inches > 0.01 && inches < contentWidth - 0.01) marks.push({ inches, align: tab.align, custom: true });
  }
  for (let at = step; at < contentWidth - 0.05; at += step) {
    if (marks.some((mark) => Math.abs(mark.inches - at) < step / 2)) continue;
    marks.push({ inches: at, align: "left", custom: false });
  }
  return marks;
}

function Ticks({ width, pageInches, marginLeft, contentWidth, pxPerInch }: { width: number; pageInches: number; marginLeft: number; contentWidth: number; pxPerInch: number }) {
  const eighth = pxPerInch / 8 >= 5;
  const quarter = pxPerInch / 4 >= 4;
  const lines: Array<{ x: number; h: number }> = [];
  const labels: Array<{ x: number; n: number }> = [];
  const steps = Math.round(pageInches * 8);
  for (let i = 0; i <= steps; i += 1) {
    const inches = i / 8;
    const fromContent = inches - marginLeft;
    const major = i % 8 === 0;
    const half = i % 4 === 0;
    const q = i % 2 === 0;
    if (!major && !half && !q && !eighth) continue;
    if (!major && !half && !quarter) continue;
    const x = inches * pxPerInch;
    if (x < 0 || x > width + 0.5) continue;
    lines.push({ x, h: major ? 12 : half ? 8 : q ? 5 : 3 });
    if (major && fromContent >= -0.01 && fromContent <= contentWidth + 0.01 && pxPerInch >= 28) labels.push({ x, n: Math.round(fromContent) });
  }
  return (
    <svg className="doc-ruler-ticks" width={width} height={28} aria-hidden>
      {lines.map((line) => (
        <line key={`${line.x}-${line.h}`} x1={line.x} x2={line.x} y1={0} y2={line.h} />
      ))}
      {labels.map((label) => (
        <text key={label.n} x={label.x + 3} y={11}>
          {label.n}
        </text>
      ))}
    </svg>
  );
}

function MarkerShape({ kind }: { kind: MarkerKind }) {
  if (kind === "margin") return <svg viewBox="0 0 12 6" aria-hidden><rect width="12" height="6" rx="0.5" /></svg>;
  if (kind === "first") return <svg viewBox="0 0 12 8" aria-hidden><path d="M0 0h12L6 8z" /></svg>;
  return <svg viewBox="0 0 12 8" aria-hidden><path d="M0 8h12L6 0z" /></svg>;
}

function headBlock(state: EditorState): { node: PMNode; pos: number } | null {
  const $pos = state.selection.$head;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.isTextblock && "indent" in node.attrs) return { node, pos: $pos.before(depth) };
  }
  return null;
}

function pointerInches(clientX: number, track: HTMLElement | null, pageInches: number, marginLeft: number) {
  if (!track) return 0;
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return ((clientX - rect.left) / rect.width) * pageInches - marginLeft;
}

/** How much further right the paragraph is drawn than its own indent says (a list, a quote, a table cell). */
function measureInset(editor: HTMLElement, dom: unknown, model: IndentGeometry): IndentGeometry {
  const page = editor.closest(".page-content");
  if (!(dom instanceof HTMLElement) || !(page instanceof HTMLElement)) return ZERO_INDENT;
  const pageRect = page.getBoundingClientRect();
  const rect = dom.getBoundingClientRect();
  const scale = page.offsetWidth > 0 ? pageRect.width / page.offsetWidth : 1;
  const style = getComputedStyle(dom);
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padRight = parseFloat(style.paddingRight) || 0;
  const borderLeft = parseFloat(style.borderLeftWidth) || 0;
  const borderRight = parseFloat(style.borderRightWidth) || 0;
  const textIndent = parseFloat(style.textIndent) || 0;
  const inches = (screenPx: number) => screenPx / scale / 96;
  const body = inches(rect.left + (borderLeft + padLeft) * scale - pageRect.left);
  const first = inches(rect.left + (borderLeft + padLeft + textIndent) * scale - pageRect.left);
  const right = inches(pageRect.right - (rect.right - (borderRight + padRight) * scale));
  const tidy = (value: number) => (Math.abs(value) < 0.02 ? 0 : roundInches(value));
  return { first: tidy(first - model.first), left: tidy(body - model.left), right: tidy(right - model.right) };
}

function sameGeometry(a: IndentGeometry, b: IndentGeometry) {
  return a.first === b.first && a.left === b.left && a.right === b.right;
}
