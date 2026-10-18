"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { geometryFor, type DocumentSession } from "@/lib/client/documentSession";
import { commitDomCaret } from "@/lib/editor/domSync";
import { lineFactor, lineMetrics } from "@/lib/doc/fontMetrics";
import { DEFAULT_MATH_SIZE, DEFAULT_TAB_STOP, fillHeaderTokens, headerParts, type DocumentMeta } from "@/lib/doc/settings";
import { styleSheetCss } from "@/lib/doc/styles";
import { PdfAnnotations } from "@/components/workspace/PdfAnnotations";
import { toast } from "@/components/ui/Toast";

/**
 * The page stack: paper sheets with headers, footers and page numbers drawn
 * behind a single continuous editor. The pagination plugin pushes content
 * across sheet boundaries; this component only draws the sheets.
 */
export const PageCanvas = memo(function PageCanvas({
  session,
  meta,
  pages,
  zoom,
  printing,
  flow,
  zoomCommit,
}: {
  session: DocumentSession;
  meta: DocumentMeta | null;
  pages: number;
  zoom: number;
  printing: boolean;
  /** Reflow the text to the screen (phones): no sheets, margins or page breaks. */
  flow: boolean;
  /** Called after the scaled frame is committed, before later layout effects read positions. */
  zoomCommit?: RefObject<(() => void) | null>;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const readOnly = useSyncExternalStore(
    session.ui.subscribe,
    () => session.ui.get().mode === "viewing",
    () => session.ui.get().mode === "viewing",
  );
  const [editing, setEditing] = useState<{ page: number; kind: ZoneKind } | null>(null);
  const [pending, setPending] = useState<{ page: number; kind: ZoneKind; value: string } | null>(null);

  useEffect(() => {
    if (readOnly || printing || flow) setEditing(null);
  }, [readOnly, printing, flow]);

  useEffect(() => {
    if (!pending || !meta) return;
    const key = headerField(pending.page, pending.kind, meta.settings.headerFooter.differentFirstPage);
    if (meta.settings.headerFooter[key] === pending.value) setPending(null);
  }, [meta, pending]);

  const editZone = useCallback((page: number, kind: ZoneKind) => {
    if (session.ui.get().mode === "viewing") return;
    setEditing((current) => (current?.page === page && current.kind === kind ? current : { page, kind }));
  }, [session]);

  const closeZone = useCallback((page: number, kind: ZoneKind) => {
    setEditing((current) => (current?.page === page && current.kind === kind ? null : current));
  }, []);

  const commitZone = useCallback((page: number, kind: ZoneKind, value: string) => {
    const current = session.meta?.settings.headerFooter;
    if (!current) return;
    const key = headerField(page, kind, current.differentFirstPage);
    if (current[key] === value) {
      setPending((item) => (item?.page === page && item.kind === kind ? null : item));
      return;
    }
    setPending({ page, kind, value });
    void session.updateMeta({ settings: { headerFooter: { [key]: value } } }).catch((error: unknown) => {
      setPending((item) => (item?.page === page && item.kind === kind && item.value === value ? null : item));
      toast(error instanceof Error ? error.message : `Couldn't save the ${kind}.`, { tone: "error" });
    });
  }, [session]);

  useEffect(() => {
    const element = mount.current;
    if (!element) return;
    void session.start(element);
    return () => session.destroy();
  }, [session]);

  const base = geometryFor(meta);
  const geometry = printing ? { ...base, gap: 0 } : base;
  const settings = meta?.settings;
  const pitch = geometry.pageHeight + geometry.gap;
  const totalHeight = pages * pitch - geometry.gap;
  const contentStyle = settings
    ? {
        fontFamily: settings.fontFamily,
        fontSize: `${settings.fontSize}pt`,
        lineHeight: String(settings.lineSpacing),
        ["--para-space" as string]: `${settings.paragraphSpacing}pt`,
        // Line spacing in each font's own line height (document.css), and where default tab stops fall.
        ["--ls" as string]: String(settings.lineSpacing),
        ["--font-lh" as string]: String(lineFactor(settings.fontFamily)),
        ["--font-lh-step" as string]: lineMetrics(settings.fontFamily).pixelRound ? "1px" : "0.01px",
        ["--tab-stop" as string]: `${settings.tabStop ?? DEFAULT_TAB_STOP}pt`,
        ["--math-size" as string]: `${settings.mathSize ?? DEFAULT_MATH_SIZE}em`,
      }
    : undefined;
  const lineModel = `${settings?.lineModel === "font" ? " font-lines" : ""}${meta?.pdfImport ? " from-pdf" : ""}`;
  const sheetCss = settings && meta?.kind !== "canvas" ? styleSheetCss(settings) : "";
  // Zoom scales the laid-out pages rather than laying them out again (CSS zoom would): text
  // shaped at another size wraps differently, so the page count would change with the window.
  const scale = printing || flow ? 1 : zoom;

  // Runs before sibling layout effects (comments) so a zoom scroll lands first.
  useLayoutEffect(() => {
    zoomCommit?.current?.();
  }, [scale, pages, zoomCommit]);

  // The tree stays the same in both layouts so the editor's DOM is never remounted.
  return (
    <div className={`page-stack-wrap${flow ? " is-flow" : ""}`}>
      <div className="page-stack-frame" style={flow ? undefined : { width: geometry.pageWidth * scale, height: totalHeight * scale }}>
        <div
          className={`page-stack${meta?.kind === "canvas" ? " is-canvas-document" : ""}`}
          style={{
            width: flow ? undefined : geometry.pageWidth,
            height: flow ? undefined : totalHeight,
            transform: scale === 1 ? undefined : `scale(${scale})`,
            ["--doc-font" as string]: settings?.fontFamily,
          }}
        >
          {sheetCss ? <style>{sheetCss}</style> : null}
          {!flow &&
            Array.from({ length: pages }, (_, index) => (
              <Sheet
                key={index}
                index={index}
                pages={pages}
                meta={meta}
                session={session}
                top={index * pitch}
                geometry={geometry}
                pending={pending?.page === index ? pending : null}
                editing={editing?.page === index ? editing.kind : null}
                readOnly={readOnly}
                onEdit={editZone}
                onClose={closeZone}
                onCommit={commitZone}
              />
            ))}
          <div
            className={`page-content${lineModel}`}
            style={
              flow
                ? contentStyle
                : {
                    top: geometry.marginTop,
                    left: geometry.marginLeft,
                    width: geometry.pageWidth - geometry.marginLeft - geometry.marginRight,
                    minHeight: totalHeight - geometry.marginTop - geometry.marginBottom,
                    ...contentStyle,
                  }
            }
          >
            <div ref={mount} className="editor-mount" />
          </div>
          {!flow && meta?.pdfImport?.showAnnotations && <PdfAnnotations session={session} documentId={meta.id} pageWidth={geometry.pageWidth} pageHeight={geometry.pageHeight} pitch={pitch} pages={pages} />}
        </div>
      </div>
    </div>
  );
});

type ZoneKind = "header" | "footer";

/** Which stored string a page's header or footer edits. The first page can have its own. */
function headerField(page: number, kind: ZoneKind, differentFirst: boolean): "header" | "footer" | "firstHeader" | "firstFooter" {
  const first = page === 0 && differentFirst;
  if (kind === "header") return first ? "firstHeader" : "header";
  return first ? "firstFooter" : "footer";
}

function textAlignOf(align: string): CSSProperties["textAlign"] {
  return align === "right" || align === "center" ? align : "left";
}

/**
 * A click in the margin must not move the body caret. Home can leave that caret
 * on a page gap before the editor has recorded it, and the next layout would
 * paint the caret from before Home. Commit the caret the page is showing first.
 */
function holdBodyCaret(session: DocumentSession) {
  const view = session.view;
  if (view) commitDomCaret(view);
}

const Sheet = memo(function Sheet({
  index,
  pages,
  meta,
  session,
  top,
  geometry,
  pending,
  editing,
  readOnly,
  onEdit,
  onClose,
  onCommit,
}: {
  index: number;
  pages: number;
  meta: DocumentMeta | null;
  session: DocumentSession;
  top: number;
  geometry: ReturnType<typeof geometryFor>;
  pending: { kind: ZoneKind; value: string } | null;
  editing: ZoneKind | null;
  readOnly: boolean;
  onEdit: (page: number, kind: ZoneKind) => void;
  onClose: (page: number, kind: ZoneKind) => void;
  onCommit: (page: number, kind: ZoneKind, value: string) => void;
}) {
  const settings = meta?.settings;
  const page = index + 1;
  const hf = settings?.headerFooter;
  const raw = (kind: ZoneKind) => {
    if (!hf) return "";
    if (pending?.kind === kind) return pending.value;
    return hf[headerField(index, kind, hf.differentFirstPage)];
  };
  let header = raw("header");
  let footer = raw("footer");
  let headerAlign = hf?.headerAlign ?? "left";
  let footerAlign = hf?.footerAlign ?? "center";
  let number: { where: "header" | "footer"; align: string } | null = null;
  if (settings) {
    const pn = settings.pageNumbers;
    if (pn.enabled && !(index === 0 && pn.skipFirst)) number = { where: pn.position, align: pn.align };
    const context = { page, pages, title: meta!.title };
    if (header) header = fillHeaderTokens(header, context);
    if (footer) footer = fillHeaderTokens(footer, context);
  }
  const rule = Boolean(hf?.headerRule && header);
  /** A header or footer's text: one part set by its alignment, or parts split by tabs at the left, center and right. */
  const zoneText = (text: string, align: string, ruled = false, sizes?: number[]) => {
    const parts = headerParts(text);
    const sized = (part: number) => (sizes?.[part] ? { fontSize: `${sizes[part]}pt` } : undefined);
    // A full-width line, so text-align moves the words. Flex justify leaves a ruled (full-width) header on the left.
    if (parts.length < 2) return <span className={ruled ? "sheet-line sheet-ruled" : "sheet-line"} style={{ ...sized(0), textAlign: textAlignOf(align) }}>{text}</span>;
    const [left, center, right] = parts.length === 2 ? [parts[0], "", parts[1]] : parts;
    // Sizes are given per written part: two parts are the left and right ones.
    const [leftSize, centerSize, rightSize] = sizes ? (parts.length === 2 ? [0, -1, 1] : [0, 1, 2]) : [];
    return (
      <span className={`sheet-parts${ruled ? " sheet-ruled" : ""}`}>
        <span style={leftSize !== undefined ? sized(leftSize) : undefined}>{left}</span>
        <span style={centerSize !== undefined ? sized(centerSize) : undefined}>{center}</span>
        <span style={rightSize !== undefined ? sized(rightSize) : undefined}>{right}</span>
      </span>
    );
  };
  const zoneStyle = (height: number, align: string) => ({
    height,
    ...(hf?.size ? { fontSize: `${hf.size}pt` } : {}),
    ...(hf?.color ? { color: hf.color } : {}),
    paddingLeft: geometry.marginLeft,
    paddingRight: geometry.marginRight,
    textAlign: textAlignOf(align),
    justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start",
  });
  // A header or footer set a distance from the page's edge (an imported PDF's, Word's) sits there rather than by the margin.
  const headerFrom = hf?.headerFrom;
  const footerFrom = hf?.footerFrom;
  const headerZone = headerFrom !== undefined ? { alignItems: "flex-start", paddingTop: `${headerFrom}in`, paddingBottom: 0 } : {};
  const footerZone = footerFrom !== undefined ? { alignItems: "flex-end", paddingBottom: `${footerFrom}in`, paddingTop: 0 } : {};
  const numberAt = (where: "header" | "footer") =>
    where === "header" ? (headerFrom !== undefined ? { top: `${headerFrom}in`, bottom: "auto" } : {}) : footerFrom !== undefined ? { bottom: `${footerFrom}in`, top: "auto" } : {};
  const numberStyle = (align: string, where: "header" | "footer") => ({
    ...(align === "left" ? { left: geometry.marginLeft } : align === "right" ? { right: geometry.marginRight } : { left: 0, right: 0, textAlign: "center" as const }),
    ...numberAt(where),
  });
  // A click in the margin must not move the body caret. Home can leave the caret on a page
  // gap the editor will not adopt; the next selection change then paints the old caret.
  // Remember the DOM caret on pointerdown, before that happens, and put it back.
  const keepCaret = (event: PointerEvent | MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("textarea")) return;
    if (event.type === "mousedown") {
      event.preventDefault();
      return;
    }
    holdBodyCaret(session);
  };
  const open = (kind: ZoneKind) => (event: MouseEvent) => {
    if (readOnly) return;
    event.preventDefault();
    onEdit(index, kind);
  };
  return (
    <div className="sheet" style={{ top, height: geometry.pageHeight, width: geometry.pageWidth }} aria-hidden={editing ? undefined : true}>
      <div className="sheet-header" style={{ ...zoneStyle(geometry.marginTop, headerAlign), ...headerZone }} onPointerDown={keepCaret} onMouseDown={keepCaret} onDoubleClick={open("header")}>
        <div className="sheet-hit">
          {editing === "header" ? (
            <ZoneField label="Header" value={raw("header")} align={headerAlign} ruled={Boolean(hf?.headerRule)} onCommit={(value) => onCommit(index, "header", value)} onClose={() => onClose(index, "header")} />
          ) : (
            header && zoneText(header, headerAlign, rule, hf?.headerPartSizes)
          )}
        </div>
        {number?.where === "header" && <span className="sheet-number" style={numberStyle(number.align, "header")}>{page}</span>}
      </div>
      <div className="sheet-footer" style={{ ...zoneStyle(geometry.marginBottom, footerAlign), ...footerZone }} onPointerDown={keepCaret} onMouseDown={keepCaret} onDoubleClick={open("footer")}>
        <div className="sheet-hit">
          {editing === "footer" ? (
            <ZoneField label="Footer" value={raw("footer")} align={footerAlign} ruled={false} onCommit={(value) => onCommit(index, "footer", value)} onClose={() => onClose(index, "footer")} />
          ) : (
            footer && zoneText(footer, footerAlign)
          )}
        </div>
        {number?.where === "footer" && <span className="sheet-number" style={numberStyle(number.align, "footer")}>{page}</span>}
      </div>
    </div>
  );
});

/** The header or footer, opened for editing. The value is the stored text, tokens and all, so nothing already there is dropped. */
function ZoneField({
  label,
  value,
  align,
  ruled,
  onCommit,
  onClose,
}: {
  label: string;
  value: string;
  align: string;
  ruled: boolean;
  onCommit: (value: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus();
    const end = field.value.length;
    field.setSelectionRange(end, end);
  }, []);
  return (
    <textarea
      ref={ref}
      className={`sheet-zone-field${ruled ? " sheet-ruled" : ""}`}
      aria-label={label}
      rows={1}
      maxLength={500}
      value={draft}
      style={{ textAlign: textAlignOf(align) }}
      onChange={(event) => setDraft(event.target.value)}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        onCommit(draft);
        const next = event.relatedTarget;
        if (next instanceof Element && next.closest("textarea.sheet-zone-field")) return;
        onClose();
      }}
    />
  );
}

