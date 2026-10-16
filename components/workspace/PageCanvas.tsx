"use client";

import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { geometryFor, type DocumentSession } from "@/lib/client/documentSession";
import { lineFactor, lineMetrics } from "@/lib/doc/fontMetrics";
import { DEFAULT_MATH_SIZE, DEFAULT_TAB_STOP, fillHeaderTokens, headerParts, type DocumentMeta } from "@/lib/doc/settings";
import { styleSheetCss, themeCssVars } from "@/lib/doc/styles";
import { PdfAnnotations } from "@/components/workspace/PdfAnnotations";

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
  const themeVars = settings?.theme ? themeCssVars(settings.theme) : undefined;
  const sheetCss = settings ? styleSheetCss(settings) : "";
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
          className="page-stack"
          style={{
            width: flow ? undefined : geometry.pageWidth,
            height: flow ? undefined : totalHeight,
            transform: scale === 1 ? undefined : `scale(${scale})`,
            ["--doc-font" as string]: settings?.fontFamily,
            ...(themeVars as CSSProperties | undefined),
          }}
        >
          {sheetCss ? <style>{sheetCss}</style> : null}
          {!flow &&
            Array.from({ length: pages }, (_, index) => <Sheet key={index} index={index} pages={pages} meta={meta} top={index * pitch} geometry={geometry} />)}
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

const Sheet = memo(function Sheet({
  index,
  pages,
  meta,
  top,
  geometry,
}: {
  index: number;
  pages: number;
  meta: DocumentMeta | null;
  top: number;
  geometry: ReturnType<typeof geometryFor>;
}) {
  const settings = meta?.settings;
  const page = index + 1;
  const first = index === 0;
  let header = "";
  let footer = "";
  let headerAlign: string = "center";
  let footerAlign: string = "center";
  let number: { where: "header" | "footer"; align: string } | null = null;
  if (settings) {
    const hf = settings.headerFooter;
    const useFirst = first && hf.differentFirstPage;
    header = useFirst ? hf.firstHeader : hf.header;
    footer = useFirst ? hf.firstFooter : hf.footer;
    headerAlign = hf.headerAlign;
    footerAlign = hf.footerAlign;
    const pn = settings.pageNumbers;
    if (pn.enabled && !(first && pn.skipFirst)) number = { where: pn.position, align: pn.align };
    const context = { page, pages, title: meta!.title };
    if (header) header = fillHeaderTokens(header, context);
    if (footer) footer = fillHeaderTokens(footer, context);
  }
  const rule = Boolean(settings?.headerFooter.headerRule && header);
  /** A header or footer's text: one part set by its alignment, or parts split by tabs at the left, center and right. */
  const zoneText = (text: string, ruled = false, sizes?: number[]) => {
    const parts = headerParts(text);
    const sized = (index: number) => (sizes?.[index] ? { fontSize: `${sizes[index]}pt` } : undefined);
    if (parts.length < 2) return <span className={ruled ? "sheet-ruled" : undefined} style={sized(0)}>{text}</span>;
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
    ...(settings?.headerFooter.size ? { fontSize: `${settings.headerFooter.size}pt` } : {}),
    ...(settings?.headerFooter.color ? { color: settings.headerFooter.color } : {}),
    paddingLeft: geometry.marginLeft,
    paddingRight: geometry.marginRight,
    justifyContent: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
  });
  // A header or footer set a distance from the page's edge (an imported PDF's, Word's) sits there rather than by the margin.
  const headerFrom = settings?.headerFooter.headerFrom;
  const footerFrom = settings?.headerFooter.footerFrom;
  const headerZone = headerFrom !== undefined ? { alignItems: "flex-start", paddingTop: `${headerFrom}in`, paddingBottom: 0 } : {};
  const footerZone = footerFrom !== undefined ? { alignItems: "flex-end", paddingBottom: `${footerFrom}in`, paddingTop: 0 } : {};
  const numberAt = (where: "header" | "footer") =>
    where === "header" ? (headerFrom !== undefined ? { top: `${headerFrom}in`, bottom: "auto" } : {}) : footerFrom !== undefined ? { bottom: `${footerFrom}in`, top: "auto" } : {};
  const numberStyle = (align: string, where: "header" | "footer") => ({
    ...(align === "left" ? { left: geometry.marginLeft } : align === "right" ? { right: geometry.marginRight } : { left: 0, right: 0, textAlign: "center" as const }),
    ...numberAt(where),
  });
  return (
    <div className="sheet" style={{ top, height: geometry.pageHeight, width: geometry.pageWidth }} aria-hidden>
      <div className="sheet-header" style={{ ...zoneStyle(geometry.marginTop, headerAlign), ...headerZone }}>
        {header && zoneText(header, rule, settings?.headerFooter.headerPartSizes)}
        {number?.where === "header" && <span className="sheet-number" style={numberStyle(number.align, "header")}>{page}</span>}
      </div>
      <div className="sheet-footer" style={{ ...zoneStyle(geometry.marginBottom, footerAlign), ...footerZone }}>
        {footer && zoneText(footer)}
        {number?.where === "footer" && <span className="sheet-number" style={numberStyle(number.align, "footer")}>{page}</span>}
      </div>
    </div>
  );
});

