"use client";

import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { PageCanvas } from "@/components/workspace/PageCanvas";
import { THEME_KEY } from "@/lib/client/bootScripts";
import { DocumentSession } from "@/lib/client/documentSession";
import type { PageAppearance } from "@/lib/pdf/screenAppearance";

/**
 * The editor's page stack with no chrome, so a headless browser can picture a
 * document that isn't open in a window. The picture is drawn by the same
 * layout the open editor exports (DocumentSession.picturePage).
 */

type Picture = (page: number, scale: number) => Promise<{ pages: number; png: string | null; error?: string }>;

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function HeadlessPages({ documentId, appearance }: { documentId: string; appearance: PageAppearance }) {
  // Offline: lay the page out without joining the live editor stream, so this
  // picture isn't mistaken for a window the user has open.
  const session = useMemo(() => new DocumentSession(documentId, { offline: true }), [documentId]);
  const ui = useSyncExternalStore(session.ui.subscribe, session.ui.get, session.ui.get);

  useLayoutEffect(() => {
    // No editor is open, so this page uses the appearance it was asked for
    // (the user's saved one, or the one the screenshot asked for). The picture
    // is painted in that same appearance.
    document.documentElement.dataset.theme = appearance;
    try {
      localStorage.setItem(THEME_KEY, appearance);
    } catch {
      // Private mode: the attribute above is enough for this page.
    }
  }, [appearance]);

  useEffect(() => {
    const root = document.documentElement;
    const pictureWindow = window as unknown as { __inlinePagePicture?: Picture; __inlineCanvasInspect?: () => Promise<unknown>; __inlineCanvasPrint?: () => Promise<unknown> };
    let cancel = false;
    const disarm = () => {
      cancel = true;
      delete pictureWindow.__inlinePagePicture;
      delete pictureWindow.__inlineCanvasInspect;
      delete pictureWindow.__inlineCanvasPrint;
      delete root.dataset.renderStatus;
      delete root.dataset.renderError;
    };
    if (ui.status === "error" || ui.status === "deleted") {
      root.dataset.renderStatus = "error";
      root.dataset.renderError = ui.error ?? "This document doesn't exist or was deleted.";
      return () => {
        cancel = true;
      };
    }
    if (ui.status !== "ready") {
      root.dataset.renderStatus = "loading";
      return disarm;
    }
    root.dataset.renderStatus = "loading";
    const arm = () => {
      if (cancel) return;
      if (!document.querySelector(".doc-content")) {
        requestAnimationFrame(arm);
        return;
      }
      pictureWindow.__inlinePagePicture = async (page, scale) => {
        try {
          const shot = await session.picturePage(page - 1, scale, appearance);
          if (!shot.png) return { pages: shot.pages, png: null };
          return { pages: shot.pages, png: bytesToBase64(new Uint8Array(await shot.png.arrayBuffer())) };
        } catch (error) {
          return { pages: 0, png: null, error: error instanceof Error ? error.message : "Couldn't picture the page." };
        }
      };
      pictureWindow.__inlineCanvasInspect = () => session.prepareCanvasRender();
      pictureWindow.__inlineCanvasPrint = () => session.prepareCanvasPrint().then(() => true);
      root.dataset.renderStatus = "ready";
    };
    // Web fonts can stall fonts.ready when the network is blocked. Layout uses
    // the document's own family and does not wait on the UI font.
    void Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 3000))]).then(() => requestAnimationFrame(arm));
    return disarm;
  }, [session, ui.status, ui.error, appearance]);

  return (
    <div className="render-pages">
      {/* printing follows the session: PDF export closes the sheet gap, or the leftover gap prints as a blank page. */}
      <PageCanvas session={session} meta={ui.meta} pages={ui.pages} zoom={1} printing={ui.printing} flow={false} />
    </div>
  );
}
