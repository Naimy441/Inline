"use client";

import { memo, useEffect, useRef } from "react";
import { geometryFor, type DocumentSession } from "@/lib/client/documentSession";
import { lineFactor, lineMetrics } from "@/lib/doc/fontMetrics";
import { DEFAULT_TAB_STOP, fillHeaderTokens, type DocumentMeta } from "@/lib/doc/settings";

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
}: {
  session: DocumentSession;
  meta: DocumentMeta | null;
  pages: number;
  zoom: number;
  printing: boolean;
  /** Reflow the text to the screen (phones): no sheets, margins or page breaks. */
  flow: boolean;
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
      }
    : undefined;
  const lineModel = settings?.lineModel === "font" ? " font-lines" : "";

  // The tree stays the same in both layouts so the editor's DOM is never remounted.
  return (
    <div className={`page-stack-wrap${flow ? " is-flow" : ""}`} style={{ zoom: printing || flow ? 1 : zoom }}>
      <div className="page-stack" style={{ width: flow ? undefined : geometry.pageWidth, height: flow ? undefined : totalHeight, ["--doc-font" as string]: settings?.fontFamily }}>
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
  const zoneStyle = (height: number, align: string) => ({
    height,
    paddingLeft: geometry.marginLeft,
    paddingRight: geometry.marginRight,
    justifyContent: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
  });
  const numberStyle = (align: string) =>
    align === "left" ? { left: geometry.marginLeft } : align === "right" ? { right: geometry.marginRight } : { left: 0, right: 0, textAlign: "center" as const };
  return (
    <div className="sheet" style={{ top, height: geometry.pageHeight, width: geometry.pageWidth }} aria-hidden>
      <div className="sheet-header" style={zoneStyle(geometry.marginTop, headerAlign)}>
        {header && <span>{header}</span>}
        {number?.where === "header" && <span className="sheet-number" style={numberStyle(number.align)}>{page}</span>}
      </div>
      <div className="sheet-footer" style={zoneStyle(geometry.marginBottom, footerAlign)}>
        {footer && <span>{footer}</span>}
        {number?.where === "footer" && <span className="sheet-number" style={numberStyle(number.align)}>{page}</span>}
      </div>
    </div>
  );
});

