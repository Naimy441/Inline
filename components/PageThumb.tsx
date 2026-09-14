import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { HeaderAlign, PageNumberLocation, StoredDocument } from "@/lib/documentStore";
import type { DocumentTemplate } from "@/lib/documentTemplates";
import { sanitizeStoredHtml } from "@/lib/documentStore";
import { DEFAULT_PAGE_LAYOUT, type PageLayout } from "@/lib/pagination";

type ThumbSource = {
  html: string;
  headerText: string;
  footerText: string;
  showHeader: boolean;
  showFooter: boolean;
  showPageNumbers: boolean;
  pageNumberLocation: PageNumberLocation;
  headerAlign: HeaderAlign;
  footerAlign?: HeaderAlign;
  fontFamily: string;
  fontSize: string;
  lineSpacing: string;
  pageLayout?: PageLayout;
};

type Props = {
  source: ThumbSource;
  blank?: boolean;
  width?: number;
  fill?: boolean;
};

export function PageThumb({ source, blank, width = 154, fill }: Props) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const [html, setHtml] = useState("");
  const [fillWidth, setFillWidth] = useState(0);
  const layout = source.pageLayout ?? DEFAULT_PAGE_LAYOUT;

  useEffect(() => {
    setHtml(blank ? "" : thumbHtml(source.html));
  }, [blank, source.html]);

  useLayoutEffect(() => {
    if (!fill) return;
    const node = boxRef.current;
    if (!node) return;
    const update = () => {
      const next = node.getBoundingClientRect().width;
      if (next) setFillWidth(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [fill]);

  const thumbWidth = fill && fillWidth ? fillWidth : width;
  const scale = thumbWidth / layout.width;
  const headerHasNumber = source.showPageNumbers && source.pageNumberLocation === "header";
  const footerHasNumber = source.showPageNumbers && source.pageNumberLocation === "footer";
  const style = {
    "--page-width": `${layout.width}px`,
    "--page-height": `${layout.height}px`,
    "--page-margin-top": `${layout.marginTop}px`,
    "--page-margin-right": `${layout.marginRight}px`,
    "--page-margin-bottom": `${layout.marginBottom}px`,
    "--page-margin-left": `${layout.marginLeft}px`,
    "--page-content-width": `${layout.width - layout.marginLeft - layout.marginRight}px`,
    "--page-content-height": `${layout.height - layout.marginTop - layout.marginBottom}px`,
    "--doc-font": source.fontFamily,
    "--doc-size": source.fontSize,
    "--header-from": "0.5in",
    "--footer-from": "0.5in",
    width: layout.width,
    height: layout.height,
    transform: `scale(${scale})`,
  } as CSSProperties;

  return (
    <span
      ref={boxRef}
      className={`page-thumb${fill ? " is-fill" : ""}`}
      style={
        fill
          ? { width: "100%", aspectRatio: `${layout.width} / ${layout.height}` }
          : { width, height: layout.height * (width / layout.width) }
      }
    >
      <span className="page-thumb-world" style={style}>
        <span className="paper page-thumb-paper">
          {source.showHeader ? (
            <span className="paper-header-stack">
              <span className={`paper-header${headerHasNumber ? " has-page-num" : ""}`} data-align={source.headerAlign}>
                <span className="paper-chrome">{source.headerText}</span>
              </span>
            </span>
          ) : null}
          {headerHasNumber ? <span className="page-num page-num-header">1</span> : null}
          <span
            className="editor page-thumb-editor"
            style={{ lineHeight: source.lineSpacing }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {source.showFooter ? (
            <span className="paper-footer-stack">
              <span className={`paper-footer${footerHasNumber ? " has-page-num" : ""}`} data-align={source.footerAlign ?? "center"}>
                <span className="paper-chrome">{source.footerText}</span>
              </span>
            </span>
          ) : null}
          {footerHasNumber ? <span className="page-num page-num-footer">1</span> : null}
        </span>
      </span>
      {blank ? <span className="page-thumb-plus" aria-hidden="true">+</span> : null}
    </span>
  );
}

function thumbHtml(html: string) {
  const source = html || "<div><br></div>";
  if (typeof document === "undefined") return source;
  return sanitizeStoredHtml(source);
}

export function thumbFromTemplate(template: DocumentTemplate): ThumbSource {
  return template;
}

export function thumbFromDocument(document: StoredDocument): ThumbSource {
  return {
    html: document.html,
    headerText: document.headerText,
    footerText: document.footerText,
    showHeader: document.showHeader,
    showFooter: document.showFooter,
    showPageNumbers: document.showPageNumbers,
    pageNumberLocation: document.pageNumberLocation,
    headerAlign: document.headerAlign,
    footerAlign: document.footerAlign,
    fontFamily: document.fontFamily,
    fontSize: document.fontSize,
    lineSpacing: document.lineSpacing,
    pageLayout: document.pageLayout,
  };
}
