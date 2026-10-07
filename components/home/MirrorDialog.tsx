"use client";

import { Check, CircleAlert, Copy, FolderSearch, FolderSync, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, patch, post } from "@/lib/client/api";
import { revealLabel, revealOnDisk } from "@/lib/client/fileManager";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";

type MirrorStatus = {
  platform: string;
  enabled: boolean;
  dir: string;
  source: "env" | "settings" | "default";
  state: "off" | "idle" | "syncing" | "error";
  files: number;
  lastSyncAt: number | null;
  error: string | null;
};

function ago(at: number) {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : new Date(at).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
}

/** Where Inline keeps a Word copy of every document on this computer, and how that's going. */
export function MirrorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  const [dir, setDir] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const { mirror } = await api<{ mirror: MirrorStatus }>("/api/mirror");
    setStatus(mirror);
    return mirror;
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh().then((mirror) => setDir(mirror.dir));
    const timer = setInterval(() => void refresh().catch(() => undefined), 2000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  const update = async (change: { enabled?: boolean; dir?: string }) => {
    setSaving(true);
    try {
      const { mirror } = await patch<{ mirror: MirrorStatus }>("/api/mirror", change);
      setStatus(mirror);
      setDir(mirror.dir);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't change the folder.", { tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  const fixed = status?.source === "env";
  const changedDir = status && dir.trim() && dir.trim() !== status.dir;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Copies on this computer"
      description="Inline keeps a Word copy of every document in a folder on this computer, in the same folders as here, and updates it moments after you write. Fonts, margins, page size, headers and footers are all kept, so your documents are yours even without Inline."
      width={540}
      footer={
        <>
          {status?.enabled && (
            <Button variant="secondary" icon={<FolderSearch size={14} />} className="mirror-open" onClick={() => void revealOnDisk()}>
              {revealLabel(status.platform)}
            </Button>
          )}
          {status?.enabled && (
            <Button variant="ghost" icon={<RefreshCw size={14} />} className="mirror-sync" onClick={() => void post<{ mirror: MirrorStatus }>("/api/mirror").then(({ mirror }) => setStatus(mirror))}>
              Copy now
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {!status ? (
        <p className="mirror-loading">Loading…</p>
      ) : (
        <div className="mirror">
          <label className="check">
            <input type="checkbox" checked={status.enabled} disabled={fixed || saving} onChange={(event) => void update({ enabled: event.target.checked })} />
            Keep a Word copy of every document on this computer
          </label>
          <label className="field">
            <span>Folder</span>
            <div className="mirror-dir">
              <input
                className="input"
                value={dir}
                disabled={fixed || saving}
                onChange={(event) => setDir(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && changedDir && void update({ dir: dir.trim() })}
                spellCheck={false}
                aria-label="Folder"
              />
              {changedDir ? (
                <Button variant="secondary" loading={saving} onClick={() => void update({ dir: dir.trim() })}>
                  Use this folder
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  icon={<Copy size={14} />}
                  onClick={() => void navigator.clipboard?.writeText(status.dir).then(() => toast("Copied the folder's path."))}
                  aria-label="Copy the folder's path"
                />
              )}
            </div>
            {fixed && <span className="mirror-note">Set by INLINE_MIRROR_DIR on the server.</span>}
          </label>
          <div className={`mirror-status is-${status.state}`} role="status">
            {status.state === "syncing" ? (
              <>
                <Loader2 size={15} className="spin" /> Copying…
              </>
            ) : status.state === "error" ? (
              <>
                <CircleAlert size={15} /> Couldn&apos;t copy: {status.error}
              </>
            ) : status.state === "off" ? (
              <>
                <FolderSync size={15} /> Copies are off. Documents stay in Inline only.
              </>
            ) : (
              <>
                <Check size={15} /> Up to date · {status.files} {status.files === 1 ? "document" : "documents"}
                {status.lastSyncAt ? ` · checked ${ago(status.lastSyncAt)}` : ""}
              </>
            )}
          </div>
          <p className="mirror-note">Trashed documents go to an &quot;Inline Trash&quot; folder there and are removed when you delete them for good. Changing the folder leaves the old copies where they are.</p>
        </div>
      )}
    </Dialog>
  );
}
