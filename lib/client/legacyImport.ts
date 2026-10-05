"use client";

import { DOMParser as PMDOMParser } from "prosemirror-model";
import { schema } from "@/lib/doc/schema";
import { post } from "@/lib/client/api";

/**
 * One-time import of documents saved by the previous version of Inline,
 * which kept them as HTML in localStorage.
 */

const KEY = "inline-documents-v2";
const DONE_KEY = "inline-documents-v2-imported";

type LegacyDocument = {
  id: string;
  title?: string;
  html?: string;
  headerText?: string;
  footerText?: string;
  showHeader?: boolean;
  showFooter?: boolean;
  showPageNumbers?: boolean;
  pageNumberLocation?: "header" | "footer";
  headerAlign?: string;
  footerAlign?: string;
  fontFamily?: string;
  fontSize?: string;
  lineSpacing?: string;
  deletedAt?: number | null;
};

export function htmlToDocJSON(html: string) {
  const container = document.createElement("div");
  // Old documents used <div> per line; treat them as paragraphs.
  container.innerHTML = html.replace(/<div(\s[^>]*)?>/gi, "<p$1>").replace(/<\/div>/gi, "</p>");
  container.querySelectorAll(".page-break-spacer, [data-page-spacer], .inline-page-break").forEach((el) => el.remove());
  return PMDOMParser.fromSchema(schema).parse(container).toJSON();
}

function align(value: string | undefined) {
  return value === "left" || value === "right" || value === "center" ? value : "center";
}

export function hasLegacyDocuments() {
  try {
    if (localStorage.getItem(DONE_KEY)) return false;
    const raw = localStorage.getItem(KEY);
    const docs = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(docs) && docs.some((doc: LegacyDocument) => doc && !doc.deletedAt && doc.html);
  } catch {
    return false;
  }
}

export async function importLegacyDocuments(): Promise<number> {
  const raw = localStorage.getItem(KEY);
  const docs = raw ? (JSON.parse(raw) as LegacyDocument[]) : [];
  let imported = 0;
  for (const legacy of docs) {
    if (!legacy || legacy.deletedAt || !legacy.html) continue;
    const size = Number.parseFloat(legacy.fontSize ?? "");
    await post("/api/documents", {
      title: legacy.title || "Untitled document",
      doc: htmlToDocJSON(legacy.html),
      settings: {
        fontFamily: legacy.fontFamily,
        fontSize: Number.isFinite(size) ? size : undefined,
        lineSpacing: Number.parseFloat(legacy.lineSpacing ?? "") || undefined,
        headerFooter: {
          header: legacy.showHeader ? legacy.headerText ?? "" : "",
          footer: legacy.showFooter ? legacy.footerText ?? "" : "",
          headerAlign: align(legacy.headerAlign),
          footerAlign: align(legacy.footerAlign),
        },
        pageNumbers: { enabled: Boolean(legacy.showPageNumbers), position: legacy.pageNumberLocation ?? "footer", align: "right" },
      },
    });
    imported += 1;
  }
  localStorage.setItem(DONE_KEY, String(Date.now()));
  return imported;
}
