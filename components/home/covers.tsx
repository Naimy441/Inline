"use client";

import { useState } from "react";
import type { DocumentMeta } from "@/lib/doc/settings";

/**
 * A first-page picture for each theme. CSS shows the one for the current
 * theme; the hidden one isn't fetched (lazy images that aren't displayed
 * don't load), and switching theme swaps them at once.
 */
export function ThemedCover({ light, dark, onError }: { light: string; dark: string; onError: () => void }) {
  const [darkFailed, setDarkFailed] = useState(false);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={darkFailed ? undefined : "cover-light"} src={light} alt="" loading="lazy" draggable={false} onError={onError} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {!darkFailed && <img className="cover-dark" src={dark} alt="" loading="lazy" draggable={false} onError={() => setDarkFailed(true)} />}
    </>
  );
}

/** A cover drawn from text, for documents (and templates) without a saved picture of their first page. */
export function TextCover({ lines: raw }: { lines: string[] }) {
  const lines = raw.filter((line) => line.trim() && line.trim() !== "&nbsp;" && !line.startsWith("|") && line !== "\\pagebreak").slice(0, 14);
  return (
    <span className="template-thumb" aria-hidden>
      {lines.map((line, index) => {
        const heading = /^#{1,6}\s/.test(line);
        const title = /\{\.title/.test(line);
        const center = /align=center/.test(line);
        const text = line
          .replace(/^#{1,6}\s/, "")
          .replace(/\s*\{[^}]*\}\s*$/, "")
          .replace(/[*_`=]|<br>/g, " ")
          .replace(/^[-\d.]+\s|^- \[ \]\s/, "• ");
        return (
          <span key={index} className={`thumb-line${title ? " is-title" : heading ? " is-heading" : ""}${center ? " is-center" : ""}`}>
            {text}
          </span>
        );
      })}
    </span>
  );
}

/** A document's first page: its saved picture, or one drawn from its opening text. */
export function DocCover({ doc }: { doc: DocumentMeta }) {
  const [broken, setBroken] = useState(false);
  if (doc.thumbnailAt && !broken) {
    return <ThemedCover light={`/api/documents/${doc.id}/thumbnail?v=${doc.thumbnailAt}`} dark={`/api/documents/${doc.id}/thumbnail?v=${doc.thumbnailAt}&theme=dark`} onError={() => setBroken(true)} />;
  }
  if (doc.preview) return <TextCover lines={doc.preview.split(/(?<=[.!?])\s+/)} />;
  return <span className="template-thumb is-blank" />;
}
