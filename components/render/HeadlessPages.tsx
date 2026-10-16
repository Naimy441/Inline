"use client";

import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { PageCanvas } from "@/components/workspace/PageCanvas";
import { DocumentSession } from "@/lib/client/documentSession";

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

export function HeadlessPages({ documentId }: { documentId: string }) {
  // Offline: lay the page out without joining the live editor stream, so this
  // picture isn't mistaken for a window the user has open.
  const session = useMemo(() => new DocumentSession(documentId, { offline: true }), [documentId]);
  const ui = useSyncExternalStore(session.ui.subscribe, session.ui.get, session.ui.get);

  useLayoutEffect(() => {
    // Print is the light page. A saved dark theme would paint the paper dark
    // before the first layout; the exported ink is black either way.
    document.documentElement.dataset.theme = "light";
    try {
      localStorage.setItem("inline-theme", "light");
    } catch {
      // Private mode: the attribute above is enough for this page.
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const pictureWindow = window as unknown as { __inlinePagePicture?: Picture };
    let cancel = false;
    const disarm = () => {
      cancel = true;
      delete pictureWindow.__inlinePagePicture;
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
          const shot = await session.picturePage(page - 1, scale);
          if (!shot.png) return { pages: shot.pages, png: null };
          return { pages: shot.pages, png: bytesToBase64(new Uint8Array(await shot.png.arrayBuffer())) };
        } catch (error) {
          return { pages: 0, png: null, error: error instanceof Error ? error.message : "Couldn't picture the page." };
        }
      };
      root.dataset.renderStatus = "ready";
    };
    // Web fonts can stall fonts.ready when the network is blocked. Layout uses
    // the document's own family and does not wait on the UI font.
    void Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 3000))]).then(() => requestAnimationFrame(arm));
    return disarm;
  }, [session, ui.status, ui.error]);

  return (
    <div className="render-pages">
      <PageCanvas session={session} meta={ui.meta} pages={ui.pages} zoom={1} printing={false} flow={false} />
    </div>
  );
}
