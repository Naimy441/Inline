"use client";

import { ArrowDown, ArrowUp, Copy, FileText, FolderInput, FolderSearch, MoreVertical, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { folderPath, type Folder, type FolderSummary } from "@/lib/doc/folders";
import type { DocumentMeta } from "@/lib/doc/settings";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { DocCover } from "./covers";
import { dragSource, useDropTarget, type DragItem } from "./dnd";
import { itemHandlers, SelectCheck, type Selection } from "./selection";
import { countLabel, folderMenuItems, FolderGlyph, type FolderActions } from "./folders";

export type DocumentActions = {
  /** "Show in Finder" (or File Explorer): its label, and what it does. */
  revealLabel: string;
  reveal: (doc: DocumentMeta) => void;
  open: (doc: DocumentMeta) => void;
  rename: (doc: DocumentMeta) => void;
  duplicate: (doc: DocumentMeta) => void;
  move: (doc: DocumentMeta) => void;
  trash: (doc: DocumentMeta) => void;
  restore: (doc: DocumentMeta) => void;
  deleteForever: (doc: DocumentMeta) => void;
};

export type SortKey = "modified" | "name" | "words";
export type Sort = { key: SortKey; descending: boolean };

export function relativeTime(at: number) {
  const diff = Date.now() - at;
  const minute = 60_000;
  if (diff < minute) return "Just now";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} min ago`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} h ago`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export const documentTime = (doc: DocumentMeta, trashed: boolean) => (trashed && doc.trashedAt ? doc.trashedAt : Math.max(doc.updatedAt, doc.lastOpenedAt));

function documentMenuItems(doc: DocumentMeta, trashed: boolean, actions: DocumentActions): MenuItem[] {
  return trashed
    ? [
        { label: "Restore", icon: <RotateCcw size={14} />, onSelect: () => actions.restore(doc) },
        { label: actions.revealLabel, icon: <FolderSearch size={14} />, onSelect: () => actions.reveal(doc) },
        { kind: "separator" },
        { label: "Delete forever", icon: <Trash2 size={14} />, danger: true, onSelect: () => actions.deleteForever(doc) },
      ]
    : [
        { label: "Open", icon: <FileText size={14} />, onSelect: () => actions.open(doc) },
        { label: "Rename", icon: <Pencil size={14} />, onSelect: () => actions.rename(doc) },
        { label: "Make a copy", icon: <Copy size={14} />, onSelect: () => actions.duplicate(doc) },
        { label: "Move to…", icon: <FolderInput size={14} />, onSelect: () => actions.move(doc) },
        { label: actions.revealLabel, icon: <FolderSearch size={14} />, onSelect: () => actions.reveal(doc) },
        { kind: "separator" },
        { label: "Move to trash", icon: <Trash2 size={14} />, danger: true, onSelect: () => actions.trash(doc) },
      ];
}

/** "Work › Q3", for documents listed outside their folder (recent, search). */
function locationLabel(folders: Map<string, Folder>, doc: DocumentMeta) {
  return folderPath(folders, doc.folderId).map((folder) => folder.name).join(" › ");
}

function MenuButton({ label, title, items }: { label: string; title: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="icon-btn icon-btn-sm doc-card-menu"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <MoreVertical size={16} />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom-end" title={title} items={items} />
    </>
  );
}

export function DocumentCard({
  doc,
  trashed,
  folders,
  showLocation,
  actions,
  selection,
}: {
  doc: DocumentMeta;
  trashed: boolean;
  folders: Map<string, Folder>;
  showLocation: boolean;
  actions: DocumentActions;
  selection?: Selection;
}) {
  const folder = showLocation && doc.folderId ? folders.get(doc.folderId) : undefined;
  const item: DragItem = { kind: "document", id: doc.id, title: doc.title };
  const selected = selection?.has("document", doc.id) ?? false;
  return (
    <div
      className={`doc-card${selected ? " is-selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`${doc.title}${selected ? ", selected" : ""}`}
      {...itemHandlers(selection, item, () => !trashed && actions.open(doc))}
      {...dragSource(item, !trashed, selection?.items)}
    >
      <SelectCheck selection={selection} item={item} />
      <div className="doc-card-cover">
        <DocCover doc={doc} />
      </div>
      <div className="doc-card-info">
        <span className="doc-card-title">{doc.title}</span>
        <div className="doc-card-meta">
          {folder ? (
            <span className="doc-card-location" title={`In ${locationLabel(folders, doc)}`}>
              <FolderGlyph color={folder.color} size={14} />
            </span>
          ) : (
            <FileText size={14} className="doc-card-icon" />
          )}
          <span className="doc-card-time" title={`${doc.wordCount.toLocaleString()} words`}>
            {relativeTime(documentTime(doc, trashed))}
          </span>
          <MenuButton label="Document actions" title={doc.title} items={documentMenuItems(doc, trashed, actions)} />
        </div>
      </div>
    </div>
  );
}

function SortHeader({ label, sortKey, sort, onSort, className }: { label: string; sortKey: SortKey; sort: Sort; onSort: (sort: Sort) => void; className?: string }) {
  const active = sort.key === sortKey;
  return (
    <button
      type="button"
      className={`doc-list-sort${active ? " is-active" : ""}${className ? ` ${className}` : ""}`}
      aria-label={`Sort by ${label.toLowerCase()}`}
      aria-pressed={active}
      onClick={() => onSort({ key: sortKey, descending: active ? !sort.descending : sortKey !== "name" })}
    >
      {label}
      {active && (sort.descending ? <ArrowDown size={13} /> : <ArrowUp size={13} />)}
    </button>
  );
}

/** Documents and folders as rows, with sortable columns. */
export function DocumentList({
  folderRows,
  docs,
  folders,
  summaries,
  trashed,
  showLocation,
  sort,
  onSort,
  folderActions,
  documentActions,
  selection,
}: {
  folderRows: Folder[];
  docs: DocumentMeta[];
  folders: Map<string, Folder>;
  summaries: Map<string, FolderSummary>;
  trashed: boolean;
  showLocation: boolean;
  sort: Sort;
  onSort: (sort: Sort) => void;
  folderActions: FolderActions;
  documentActions: DocumentActions;
  selection?: Selection;
}) {
  return (
    <div className={`doc-list${showLocation ? " has-location" : ""}`}>
      <div className="doc-list-head">
        <SortHeader label="Name" sortKey="name" sort={sort} onSort={onSort} />
        {showLocation && <span className="doc-list-location">Location</span>}
        <SortHeader label={trashed ? "Trashed" : "Modified"} sortKey="modified" sort={sort} onSort={onSort} className="doc-list-modified" />
        <SortHeader label="Words" sortKey="words" sort={sort} onSort={onSort} className="doc-list-words" />
        <span />
      </div>
      {folderRows.map((folder) => (
        <FolderRow key={folder.id} folder={folder} summary={summaries.get(folder.id)} folders={folders} showLocation={showLocation} actions={folderActions} selection={selection} />
      ))}
      {docs.map((doc) => (
        <DocumentRow key={doc.id} doc={doc} folders={folders} trashed={trashed} showLocation={showLocation} actions={documentActions} selection={selection} />
      ))}
    </div>
  );
}

function DocumentRow({ doc, folders, trashed, showLocation, actions, selection }: { doc: DocumentMeta; folders: Map<string, Folder>; trashed: boolean; showLocation: boolean; actions: DocumentActions; selection?: Selection }) {
  const item: DragItem = { kind: "document", id: doc.id, title: doc.title };
  const selected = selection?.has("document", doc.id) ?? false;
  return (
        <div
          className={`doc-row${selected ? " is-selected" : ""}`}
          role="button"
          tabIndex={0}
          aria-label={`${doc.title}${selected ? ", selected" : ""}`}
          {...itemHandlers(selection, item, () => !trashed && actions.open(doc))}
          {...dragSource(item, !trashed, selection?.items)}
        >
          <span className="doc-row-name">
            <SelectCheck selection={selection} item={item} inline />
            <span className="doc-row-thumb">
              <DocCover doc={doc} />
            </span>
            <span className="doc-row-title">
              <span>{doc.title}</span>
              <span className="doc-row-sub">{relativeTime(documentTime(doc, trashed))}</span>
            </span>
          </span>
          {showLocation && <span className="doc-list-location">{locationLabel(folders, doc) || "All documents"}</span>}
          <span className="doc-list-modified">{relativeTime(documentTime(doc, trashed))}</span>
          <span className="doc-list-words">{doc.wordCount.toLocaleString()}</span>
          <MenuButton label="Document actions" title={doc.title} items={documentMenuItems(doc, trashed, actions)} />
        </div>
  );
}

function FolderRow({
  folder,
  summary,
  folders,
  showLocation,
  actions,
  selection,
}: {
  folder: Folder;
  summary: FolderSummary | undefined;
  folders: Map<string, Folder>;
  showLocation: boolean;
  actions: FolderActions;
  selection?: Selection;
}) {
  const drop = useDropTarget((item) => actions.canDrop(folder.id, item), (items) => actions.drop(folder.id, items));
  const item: DragItem = { kind: "folder", id: folder.id, title: folder.name };
  const selected = selection?.has("folder", folder.id) ?? false;
  const words = summary?.documents.reduce((total, doc) => total + doc.wordCount, 0) ?? 0;
  return (
    <div
      className={`doc-row is-folder folder-${folder.color}${drop.over ? " is-drop" : ""}${selected ? " is-selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`${folder.name}, folder, ${countLabel(summary)}${selected ? ", selected" : ""}`}
      {...itemHandlers(selection, item, () => actions.open(folder.id))}
      {...dragSource(item, true, selection?.items)}
      {...drop.props}
    >
      <span className="doc-row-name">
        <SelectCheck selection={selection} item={item} inline />
        <span className="doc-row-thumb is-folder">
          <FolderGlyph color={folder.color} size={20} open={drop.over} />
        </span>
        <span className="doc-row-title">
          <span>{folder.name}</span>
          <span className="doc-row-sub">{countLabel(summary)}</span>
        </span>
      </span>
      {showLocation && <span className="doc-list-location">{folderPath(folders, folder.parentId).map((item) => item.name).join(" › ") || "All documents"}</span>}
      <span className="doc-list-modified">{relativeTime(summary?.updatedAt ?? folder.updatedAt)}</span>
      <span className="doc-list-words">{words ? words.toLocaleString() : "—"}</span>
      <MenuButton label="Folder actions" title={folder.name} items={folderMenuItems(folder, actions, { includeOpen: true })} />
    </div>
  );
}
