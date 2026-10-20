"use client";

import { DOMSerializer, Node as PMNode } from "prosemirror-model";
import { useEffect, useRef, useState } from "react";
import { api, post } from "@/lib/client/api";
import type { DocumentSession } from "@/lib/client/documentSession";
import { schema } from "@/lib/doc/schema";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";

/** Claude's revision sits beside the document until the user keeps it. */
export function DraftBanner({
  session,
  words,
  previewing,
  onPreview,
  onClosePreview,
}: {
  session: DocumentSession;
  words: number;
  previewing: boolean;
  onPreview: () => void;
  onClosePreview: () => void;
}) {
  const [busy, setBusy] = useState<"keep" | "discard" | null>(null);

  const keep = async () => {
    setBusy("keep");
    try {
      await session.whenSaved();
      await post(`/api/documents/${session.id}/draft/keep`);
      toast("Revision kept. It is the document now.", { tone: "success" });
      onClosePreview();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't keep that revision.", { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    setBusy("discard");
    try {
      await post(`/api/documents/${session.id}/draft/discard`);
      toast("Revision discarded. The document is unchanged.");
      onClosePreview();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't discard that revision.", { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="draft-banner" role="region" aria-label="AI revision">
      <p>A revision is ready ({words.toLocaleString()} words). This document stays as it is until you keep it.</p>
      <div className="draft-banner-actions">
        <Button variant="ghost" onClick={onPreview}>
          {previewing ? "Hide preview" : "Preview"}
        </Button>
        <Button variant="ghost" loading={busy === "discard"} disabled={busy !== null && busy !== "discard"} onClick={() => void discard()}>
          Discard
        </Button>
        <Button variant="primary" loading={busy === "keep"} disabled={busy !== null && busy !== "keep"} onClick={() => void keep()}>
          Keep
        </Button>
      </div>
    </div>
  );
}

/** The revision, shown in place of the document. */
export function DraftPreview({ session }: { session: DocumentSession }) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    api<{ draft: { doc: unknown } | null }>(`/api/documents/${session.id}/draft`)
      .then((result) => {
        if (cancelled) return;
        const element = container.current;
        if (!result.draft || !element) {
          setFailed(true);
          return;
        }
        const doc = PMNode.fromJSON(schema, result.draft.doc as Parameters<typeof PMNode.fromJSON>[1]);
        element.replaceChildren(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  const settings = session.meta?.settings;
  return (
    <div className="version-view" aria-label="Revision preview">
      <div className="version-page" style={settings ? { fontFamily: settings.fontFamily, fontSize: `${settings.fontSize}pt`, lineHeight: String(settings.lineSpacing) } : undefined}>
        {failed ? <p className="muted">This revision couldn&apos;t be loaded.</p> : <div className="doc-content" ref={container} />}
      </div>
    </div>
  );
}
