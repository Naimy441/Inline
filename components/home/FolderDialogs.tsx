"use client";

import { Check, FolderPlus, House, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { canMoveFolder, documentFolder, FOLDER_COLORS, folderPath, type Folder, type FolderColor } from "@/lib/doc/folders";
import type { DocumentMeta } from "@/lib/doc/settings";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { DocCover } from "./covers";
import { COLOR_NAMES, FolderGlyph } from "./folders";

/** Name and color for a new folder, or for renaming one. */
export function FolderDialog({
  open,
  title,
  confirmLabel,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  initial: { name: string; color: FolderColor };
  onClose: () => void;
  onSave: (name: string, color: FolderColor) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState<FolderColor>(initial.color);
  useEffect(() => {
    if (!open) return;
    setName(initial.name);
    setColor(initial.color);
  }, [open, initial.name, initial.color]);
  const save = () => name.trim() && onSave(name.trim(), color);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!name.trim()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="folder-form">
        <div className="folder-form-name">
          <FolderGlyph color={color} size={22} />
          <input className="input" value={name} placeholder="Folder name" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && save()} aria-label="Folder name" maxLength={120} />
        </div>
        <div className="color-swatches" role="radiogroup" aria-label="Folder color">
          {FOLDER_COLORS.map((item) => (
            <button key={item} type="button" role="radio" aria-checked={color === item} aria-label={COLOR_NAMES[item]} title={COLOR_NAMES[item]} className={`color-swatch folder-${item}${color === item ? " is-active" : ""}`} onClick={() => setColor(item)}>
              {color === item && <Check size={13} strokeWidth={3} />}
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

type TreeEntry = { folder: Folder; depth: number };

function folderTree(folders: Folder[]): TreeEntry[] {
  const children = new Map<string | null, Folder[]>();
  for (const folder of folders) children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder]);
  const entries: TreeEntry[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const folder of (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      entries.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return entries;
}

/** What's being moved: one item or several. `from` is where they all are now, or undefined when they're in different folders. */
export type MoveTarget = { title: string; from: string | null | undefined; items: Array<{ kind: "document" | "folder"; id: string }> };

/** Pick where a document or folder goes, with a way to make a new folder on the spot. */
export function MoveDialog({
  item,
  folders,
  onClose,
  onMove,
  onCreateFolder,
}: {
  item: MoveTarget | null;
  folders: Folder[];
  onClose: () => void;
  onMove: (target: string | null) => void;
  onCreateFolder: (name: string, parentId: string | null) => Promise<Folder | null>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const byId = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const tree = useMemo(() => folderTree(folders), [folders]);
  useEffect(() => {
    setSelected(item?.from ?? null);
    setNaming(null);
  }, [item]);
  const allowed = (target: string | null) => !item || item.items.every((entry) => entry.kind === "document" || canMoveFolder(byId, entry.id, target));
  const unchanged = item?.from !== undefined && selected === item.from;
  const createHere = async () => {
    if (!naming?.trim()) return;
    const folder = await onCreateFolder(naming.trim(), selected);
    setNaming(null);
    if (folder) setSelected(folder.id);
  };
  const destination = selected ? byId.get(selected)?.name : "All documents";
  return (
    <Dialog
      open={Boolean(item)}
      onClose={onClose}
      title={item ? (item.items.length > 1 ? `Move ${item.items.length} items` : `Move "${item.title}"`) : "Move"}
      description={item && item.from !== undefined ? <>Currently in {item.from ? folderPath(byId, item.from).map((folder) => folder.name).join(" › ") : "All documents"}.</> : null}
      width={460}
      footer={
        <>
          <Button variant="ghost" icon={<FolderPlus size={15} />} className="move-new-folder" onClick={() => setNaming("")} disabled={naming !== null}>
            New folder
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onMove(selected)} disabled={unchanged || !allowed(selected)}>
            {unchanged ? "Move" : `Move to ${destination}`}
          </Button>
        </>
      }
    >
      <div className="folder-picker" role="listbox" aria-label="Destination folder">
        <button type="button" role="option" aria-selected={selected === null} className={`folder-pick${selected === null ? " is-selected" : ""}`} onClick={() => setSelected(null)}>
          <House size={16} />
          <span>All documents</span>
          {item?.from === null && <span className="folder-pick-note">Current</span>}
        </button>
        {tree.map(({ folder, depth }) => {
          const ok = allowed(folder.id);
          return (
            <button
              key={folder.id}
              type="button"
              role="option"
              aria-selected={selected === folder.id}
              aria-disabled={!ok}
              disabled={!ok}
              className={`folder-pick${selected === folder.id ? " is-selected" : ""}`}
              style={{ paddingLeft: 10 + Math.min(depth + 1, 8) * 16 }}
              onClick={() => setSelected(folder.id)}
              onDoubleClick={() => ok && folder.id !== item?.from && onMove(folder.id)}
            >
              <FolderGlyph color={folder.color} size={16} open={selected === folder.id} />
              <span>{folder.name}</span>
              {item?.from === folder.id && <span className="folder-pick-note">Current</span>}
            </button>
          );
        })}
        {naming !== null && (
          <div className="folder-pick is-new">
            <FolderPlus size={16} />
            <input
              className="input input-sm"
              autoFocus
              value={naming}
              placeholder={`New folder in ${destination}`}
              onChange={(event) => setNaming(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createHere();
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setNaming(null);
                }
              }}
              aria-label="New folder name"
              maxLength={120}
            />
            <Button size="sm" variant="primary" onClick={() => void createHere()} disabled={!naming.trim()}>
              Create
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Choose existing documents to file in a folder. */
export function AddDocumentsDialog({
  folder,
  documents,
  folders,
  onClose,
  onAdd,
}: {
  folder: Folder | null;
  documents: DocumentMeta[];
  folders: Map<string, Folder>;
  onClose: () => void;
  onAdd: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    setQuery("");
    setPicked(new Set());
  }, [folder]);
  const candidates = useMemo(() => {
    if (!folder) return [];
    const q = query.trim().toLowerCase();
    return documents.filter((doc) => documentFolder(folders, doc) !== folder.id && (!q || doc.title.toLowerCase().includes(q) || doc.preview.toLowerCase().includes(q)));
  }, [documents, folders, folder, query]);
  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allPicked = candidates.length > 0 && candidates.every((doc) => picked.has(doc.id));
  return (
    <Dialog
      open={Boolean(folder)}
      onClose={onClose}
      title={folder ? `Add documents to "${folder.name}"` : "Add documents"}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onAdd([...picked])} disabled={!picked.size}>
            {picked.size ? `Add ${picked.size} document${picked.size === 1 ? "" : "s"}` : "Add documents"}
          </Button>
        </>
      }
    >
      <div className="add-docs">
        <div className="add-docs-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your documents" aria-label="Search your documents" />
          {candidates.length > 0 && (
            <button
              type="button"
              className="add-docs-all"
              onClick={() =>
                setPicked((current) => {
                  const next = new Set(current);
                  for (const doc of candidates) {
                    if (allPicked) next.delete(doc.id);
                    else next.add(doc.id);
                  }
                  return next;
                })
              }
            >
              {allPicked ? "Clear" : "Select all"}
            </button>
          )}
        </div>
        <div className="add-docs-list" role="listbox" aria-multiselectable="true" aria-label="Documents">
          {candidates.length === 0 ? (
            <p className="add-docs-empty">{query ? `No documents match "${query}".` : "Every document is already in this folder."}</p>
          ) : (
            candidates.map((doc) => {
              const location = folderPath(folders, documentFolder(folders, doc));
              return (
                <button key={doc.id} type="button" role="option" aria-selected={picked.has(doc.id)} className={`add-doc${picked.has(doc.id) ? " is-picked" : ""}`} onClick={() => toggle(doc.id)}>
                  <span className="add-doc-check">{picked.has(doc.id) && <Check size={12} strokeWidth={3} />}</span>
                  <span className="doc-row-thumb">
                    <DocCover doc={doc} />
                  </span>
                  <span className="add-doc-text">
                    <span className="add-doc-title">{doc.title}</span>
                    <span className="add-doc-where">
                      {location.length ? (
                        <>
                          <FolderGlyph color={location[location.length - 1]!.color} size={12} /> {location.map((item) => item.name).join(" › ")}
                        </>
                      ) : (
                        "All documents"
                      )}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </Dialog>
  );
}
