"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { DocumentSession } from "@/lib/client/documentSession";

type OriginalPage = { page: number; width: number; height: number; ink: string | null };

/**
 * The annotations an imported PDF had (handwriting, highlighting, notes),
 * drawn over the document's pages where they were on the original pages.
 * Each original page's annotations go on the sheet where that page begins:
 * the first sheet for page 1, and for later pages the sheet after the page
 * break before them. They are pictures and don't follow edits.
 */
export function PdfAnnotations({ session, documentId, pageWidth, pageHeight, pitch, pages }: { session: DocumentSession; documentId: string; pageWidth: number; pageHeight: number; pitch: number; pages: number }) {
  const [originals, setOriginals] = useState<OriginalPage[] | null>(null);
  const [sheets, setSheets] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    api<{ pages: OriginalPage[] }>(`/api/documents/${documentId}/pdf`)
      .then((result) => {
        if (!cancelled) setOriginals(result.pages);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  // Which sheet each original page begins on, read from where the page breaks fall.
  useLayoutEffect(() => {
    const root = session.view?.dom;
    const stack = root?.closest<HTMLElement>(".page-stack");
    if (!root || !stack || !originals) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      timer = null;
      const top = stack.getBoundingClientRect().top;
      const scale = stack.getBoundingClientRect().height / (stack.offsetHeight || 1) || 1;
      const breaks = [...root.children].filter((child) => child.classList.contains("page-break"));
      const next = [0];
      for (const item of breaks) {
        // The page's first block, past the spacer pagination puts after a break (it sits on the page before).
        let after = item.nextElementSibling;
        while (after && (after.classList.contains("page-gap") || !after.getBoundingClientRect().height)) after = after.nextElementSibling;
        if (!after) break;
        next.push(Math.max(0, Math.floor((after.getBoundingClientRect().top - top) / scale / pitch + 0.001)));
      }
      setSheets((current) => (current.length === next.length && current.every((value, index) => value === next[index]) ? current : next));
    };
    measure();
    const observer = new MutationObserver(() => {
      if (!timer) timer = setTimeout(measure, 250);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [session, originals, pitch, pages]);

  if (!originals) return null;
  return (
    <div className="pdf-annotations" aria-hidden>
      {originals.map((original, index) => {
        const sheet = sheets[index];
        if (!original.ink || sheet === undefined || sheet >= pages) return null;
        // The original page laid over the sheet, scaled to its width.
        const height = Math.min(pageHeight, (pageWidth * original.height) / original.width);
        return <img key={original.page} src={original.ink} alt="" draggable={false} style={{ top: sheet * pitch, width: pageWidth, height }} />;
      })}
    </div>
  );
}
