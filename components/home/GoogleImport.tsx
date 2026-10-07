"use client";

import { ExternalLink, FileUp, X } from "lucide-react";
import { api, patch } from "@/lib/client/api";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";

export const TAKEOUT_URL = "https://takeout.google.com/";

const LOCAL_KEY = "inline-google-import-dismissed";

/**
 * Whether to show the Google Docs tip. A dismissal is kept on the server (so
 * every browser honors it) and in this browser (so the tip doesn't flash in
 * before the server answers).
 */
export async function shouldShowGoogleImport() {
  try {
    if (localStorage.getItem(LOCAL_KEY)) return false;
  } catch {
    // Storage blocked: ask the server.
  }
  const { preferences } = await api<{ preferences: { googleImportDismissed?: boolean } }>("/api/preferences").catch(() => ({ preferences: {} as { googleImportDismissed?: boolean } }));
  if (preferences.googleImportDismissed) {
    try {
      localStorage.setItem(LOCAL_KEY, "1");
    } catch {
      // ignore
    }
    return false;
  }
  return true;
}

export function dismissGoogleImport() {
  try {
    localStorage.setItem(LOCAL_KEY, "1");
  } catch {
    // ignore
  }
  void patch("/api/preferences", { googleImportDismissed: true }).catch(() => undefined);
}

/** The home page tip: Google Docs come over through a Google Takeout export. */
export function GoogleImportBanner({ onShowGuide, onDismiss }: { onShowGuide: () => void; onDismiss: () => void }) {
  return (
    <div className="home-banner google-banner" role="region" aria-label="Import from Google Docs">
      <span>
        <strong>Moving from Google Docs?</strong> Export all your Google Drive files with{" "}
        <button type="button" className="banner-link" onClick={onShowGuide}>
          takeout.google.com
        </button>{" "}
        and import the .zip here. Your documents and folders come along.
      </span>
      <Button size="sm" variant="primary" onClick={onShowGuide}>
        Show me how
      </Button>
      <IconButton label="Dismiss" size="sm" className="home-banner-close" onClick={onDismiss}>
        <X size={15} />
      </IconButton>
    </div>
  );
}

/** Step by step: export from Google Takeout, then import the .zip. */
export function TakeoutGuide({ open, importing, onClose, onImport }: { open: boolean; importing: boolean; onClose: () => void; onImport: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import your Google Docs"
      description="Google Takeout exports your Drive as a .zip of Word files. Inline turns each one into a document and keeps your folders."
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
          <Button variant="primary" icon={<FileUp size={15} />} loading={importing} onClick={onImport}>
            Import .zip
          </Button>
        </>
      }
    >
      <ol className="takeout-steps">
        <li>
          <strong>Open Google Takeout</strong> and sign in to your Google account.
          <a className="btn btn-secondary btn-sm takeout-open" href={TAKEOUT_URL} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} />
            <span className="btn-label">Open takeout.google.com</span>
          </a>
        </li>
        <li>
          Click <strong>Deselect all</strong>, then scroll down and tick <strong>Drive</strong>.
        </li>
        <li>
          Under Drive, open <strong>Multiple formats</strong> and keep Documents as <strong>DOCX</strong> (the default). To export only some folders, use <strong>All Drive data included</strong>.
        </li>
        <li>
          Click <strong>Next step</strong>, choose <strong>Export once</strong>, file type <strong>.zip</strong>, and a size of 1 GB or 2 GB, then <strong>Create export</strong>.
        </li>
        <li>
          Google emails you when the export is ready, usually within minutes for documents. Download the .zip (or each part, if it was split) and click <strong>Import .zip</strong> below.
        </li>
      </ol>
      <p className="takeout-note">Previews of every page are drawn after the import, and you can ask Claude to sort anything that isn&apos;t in a folder yet.</p>
    </Dialog>
  );
}
