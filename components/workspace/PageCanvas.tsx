"use client";

import { useEffect, useRef } from "react";
import { geometryFor, type DocumentSession } from "@/lib/client/documentSession";
import { fillHeaderTokens, type DocumentMeta } from "@/lib/doc/settings";

/**
 * The page stack: paper sheets with headers, footers and page numbers drawn
 * behind a single continuous editor. The pagination plugin pushes content
 * across sheet boundaries; this component only draws the sheets.
 */
export function PageCanvas({ session, meta, pages, zoom, printing }: { session: DocumentSession; meta: DocumentMeta | null; pages: number; zoom: number; printing: boolean }) {
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
      }
    : undefined;

  return (
    <div className="page-stack-wrap" style={{ zoom: printing ? 1 : zoom }}>
      <div className="page-stack" style={{ width: geometry.pageWidth, height: totalHeight }}>
        {Array.from({ length: pages }, (_, index) => (
          <Sheet key={index} index={index} pages={pages} meta={meta} top={index * pitch} geometry={geometry} />
        ))}
        <div
          className="page-content"
          style={{
            top: geometry.marginTop,
            left: geometry.marginLeft,
            width: geometry.pageWidth - geometry.marginLeft - geometry.marginRight,
            minHeight: totalHeight - geometry.marginTop - geometry.marginBottom,
            ...contentStyle,
          }}
        >
          <div ref={mount} className="editor-mount" />
        </div>
      </div>
    </div>
  );
}

function Sheet({
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
    header = fillHeaderTokens(header, context);
    footer = fillHeaderTokens(footer, context);
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
}
