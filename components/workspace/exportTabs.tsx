"use client";

import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { DocumentSession } from "@/lib/client/documentSession";
import type { PdfDocumentModel, PdfPage } from "@/lib/pdf/pdfWriter";
import { PageCanvas } from "@/components/workspace/PageCanvas";

/** Draws a tab's pages off screen, the same way the editor does, so they can be read into a PDF. */
function OffscreenPages({ session }: { session: DocumentSession }) {
  const ui = useSyncExternalStore(session.ui.subscribe, session.ui.get, session.ui.get);
  return <PageCanvas session={session} meta={ui.meta} pages={ui.pages} zoom={1} printing={false} flow={false} />;
}

async function tabPages(id: string): Promise<PdfDocumentModel> {
  const host = document.createElement("div");
  host.className = "offscreen-pages";
  host.setAttribute("aria-hidden", "true");
  document.body.append(host);
  const session = new DocumentSession(id, { offline: true });
  const root = createRoot(host);
  try {
    root.render(<OffscreenPages session={session} />);
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        const { status, error } = session.ui.get();
        if (status === "ready") return resolve();
        if (status === "error") return reject(new Error(error ?? "A tab couldn't be loaded."));
        setTimeout(check, 30);
      };
      check();
    });
    return await session.pdfModel();
  } finally {
    root.unmount();
    host.remove();
  }
}

/** Adds the document's other tabs, in tab order, around the open tab's pages. */
export function withOtherTabs(openId: string, tabIds: string[]) {
  return async (own: PdfDocumentModel): Promise<PdfDocumentModel> => {
    const pages: PdfPage[] = [];
    const fonts = { ...own.fonts };
    for (const id of tabIds) {
      const model = id === openId ? own : await tabPages(id);
      pages.push(...model.pages);
      Object.assign(fonts, model.fonts);
    }
    return { title: own.title, pages, fonts };
  };
}
