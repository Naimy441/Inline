"use client";

import { ChevronDown, ChevronRight, Folder as FolderIcon, FolderInput, FolderOpen, FolderPlus, FolderSearch, House, MoreHorizontal, MoreVertical, Palette, Pencil, Trash2 } from "lucide-react";
import { Fragment, useRef, useState, type ReactNode } from "react";
import { FOLDER_COLORS, type Folder, type FolderColor, type FolderSummary } from "@/lib/doc/folders";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { DocCover } from "./covers";
import { dragSource, useDropTarget, type DragItem } from "./dnd";
import { itemHandlers, SelectCheck, type Selection } from "./selection";

export type FolderActions = {
  /** "Show in Finder" (or File Explorer): its label, and what it does. */
  revealLabel: string;
  reveal: (folder: Folder) => void;
  open: (id: string | null) => void;
  rename: (folder: Folder) => void;
  recolor: (folder: Folder, color: FolderColor) => void;
  newFolder: (parentId: string | null) => void;
  move: (folder: Folder) => void;
  remove: (folder: Folder) => void;
  /** Whether a dragged document or folder may drop into this folder (null: the top level). */
  canDrop: (target: string | null, item: DragItem) => boolean;
  drop: (target: string | null, items: DragItem[]) => void;
};

export const COLOR_NAMES: Record<FolderColor, string> = { gray: "Gray", clay: "Clay", amber: "Amber", green: "Green", teal: "Teal", blue: "Blue", violet: "Violet", rose: "Rose" };

/** "6 documents · 1 folder"; `compact` ("6 docs · 1 folder") fits a card. */
export function countLabel(summary: FolderSummary | undefined, compact = false) {
  const docs = summary?.documents.length ?? 0;
  const folders = summary?.folders ?? 0;
  if (!docs && !folders) return "Empty";
  const parts = [];
  if (docs) parts.push(compact && folders ? `${docs} doc${docs === 1 ? "" : "s"}` : `${docs} document${docs === 1 ? "" : "s"}`);
  if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function FolderGlyph({ color, size = 16, open = false }: { color: FolderColor; size?: number; open?: boolean }) {
  const Icon = open ? FolderOpen : FolderIcon;
  return <Icon size={size} className={`folder-glyph folder-${color}`} fill="currentColor" fillOpacity={0.18} aria-hidden />;
}

export function folderMenuItems(folder: Folder, actions: FolderActions, options: { includeOpen?: boolean } = {}): MenuItem[] {
  return [
    ...(options.includeOpen ? [{ label: "Open", icon: <FolderOpen size={14} />, onSelect: () => actions.open(folder.id) }] : []),
    { label: "New folder inside", icon: <FolderPlus size={14} />, onSelect: () => actions.newFolder(folder.id) },
    { label: "Rename", icon: <Pencil size={14} />, onSelect: () => actions.rename(folder) },
    {
      label: "Color",
      icon: <Palette size={14} />,
      submenu: FOLDER_COLORS.map((color) => ({
        label: COLOR_NAMES[color],
        icon: <span className={`color-dot folder-${color}`} aria-hidden />,
        checked: folder.color === color,
        onSelect: () => actions.recolor(folder, color),
      })),
    },
    { label: "Move to…", icon: <FolderInput size={14} />, onSelect: () => actions.move(folder) },
    { label: actions.revealLabel, icon: <FolderSearch size={14} />, onSelect: () => actions.reveal(folder) },
    { kind: "separator" },
    { label: "Delete folder", icon: <Trash2 size={14} />, danger: true, onSelect: () => actions.remove(folder) },
  ];
}

/**
 * A folder as a block: the first pages of its three latest documents, and a
 * fourth tile counting the rest.
 */
export function FolderCard({ folder, summary, actions, selection }: { folder: Folder; summary: FolderSummary | undefined; actions: FolderActions; selection?: Selection }) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const drop = useDropTarget((item) => actions.canDrop(folder.id, item), (items) => actions.drop(folder.id, items));
  const item: DragItem = { kind: "folder", id: folder.id, title: folder.name };
  const selected = selection?.has("folder", folder.id) ?? false;
  const docs = summary?.documents ?? [];
  const previews = docs.slice(0, 3);
  const more = docs.length - previews.length;
  const subfolders = summary?.folders ?? 0;
  return (
    <div
      className={`folder-card folder-${folder.color}${drop.over ? " is-drop" : ""}${selected ? " is-selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`${folder.name}, folder, ${countLabel(summary)}${selected ? ", selected" : ""}`}
      {...itemHandlers(selection, item, () => actions.open(folder.id))}
      {...dragSource(item, true, selection?.items)}
      {...drop.props}
    >
      <SelectCheck selection={selection} item={item} />
      <div className="folder-card-cover">
        {docs.length === 0 ? (
          <div className="folder-empty">
            <FolderGlyph color={folder.color} size={44} open={drop.over} />
            <span>{subfolders ? `${subfolders} folder${subfolders === 1 ? "" : "s"} inside` : drop.over ? "Drop to move here" : "Empty folder"}</span>
          </div>
        ) : (
          <div className="folder-mosaic">
            {previews.map((doc) => (
              <span key={doc.id} className="folder-tile" title={doc.title}>
                <DocCover doc={doc} />
              </span>
            ))}
            {Array.from({ length: 3 - previews.length }, (_, index) => (
              <span key={`slot-${index}`} className="folder-tile is-slot" />
            ))}
            {more > 0 ? (
              <span className="folder-tile is-more">
                <strong>+{more}</strong>
                <span>more</span>
              </span>
            ) : subfolders > 0 ? (
              <span className="folder-tile is-more">
                <FolderGlyph color={folder.color} size={22} />
                <span>
                  {subfolders} folder{subfolders === 1 ? "" : "s"}
                </span>
              </span>
            ) : (
              <span className="folder-tile is-slot" />
            )}
          </div>
        )}
      </div>
      <div className="doc-card-info">
        <span className="doc-card-title">{folder.name}</span>
        <div className="doc-card-meta">
          <FolderGlyph color={folder.color} size={14} />
          <span className="doc-card-time" title={countLabel(summary)}>
            {countLabel(summary, true)}
          </span>
          <button
            ref={ref}
            type="button"
            className="icon-btn icon-btn-sm doc-card-menu"
            aria-label="Folder actions"
            onClick={(event) => {
              event.stopPropagation();
              setMenu(true);
            }}
          >
            <MoreVertical size={16} />
          </button>
        </div>
      </div>
      <Menu open={menu} onClose={() => setMenu(false)} anchor={ref} placement="bottom-end" title={folder.name} items={folderMenuItems(folder, actions, { includeOpen: true })} />
    </div>
  );
}

/** One step of the breadcrumb trail; documents and folders can be dropped on it to move them there. */
function Crumb({ id, label, icon, actions }: { id: string | null; label: string; icon?: ReactNode; actions: FolderActions }) {
  const drop = useDropTarget((item) => actions.canDrop(id, item), (items) => actions.drop(id, items));
  return (
    <button type="button" className={`crumb${drop.over ? " is-drop" : ""}`} onClick={() => actions.open(id)} {...drop.props}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

/**
 * Where you are: All documents › Work › Q3. The last step opens the folder's
 * menu; long trails fold their middle steps into a "…" menu.
 */
export function Breadcrumbs({ path, actions }: { path: Folder[]; actions: FolderActions }) {
  const [menu, setMenu] = useState(false);
  const [hiddenMenu, setHiddenMenu] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const hiddenRef = useRef<HTMLButtonElement>(null);
  const current = path[path.length - 1];
  const above = path.slice(0, -1);
  const hidden = above.length > 2 ? above.slice(0, above.length - 1) : [];
  const shown = above.length > 2 ? above.slice(-1) : above;
  const root = <Crumb id={null} label="All documents" icon={<House size={15} />} actions={actions} />;
  if (!current) {
    return (
      <nav className="crumbs" aria-label="Folder path">
        <span className="crumb is-current" aria-current="page">
          <House size={15} />
          <span>All documents</span>
        </span>
      </nav>
    );
  }
  return (
    <nav className="crumbs" aria-label="Folder path">
      {root}
      {hidden.length > 0 && (
        <>
          <ChevronRight size={14} className="crumb-sep" aria-hidden />
          <button ref={hiddenRef} type="button" className="crumb" aria-label="More folders" onClick={() => setHiddenMenu(true)}>
            <MoreHorizontal size={15} />
          </button>
          <Menu open={hiddenMenu} onClose={() => setHiddenMenu(false)} anchor={hiddenRef} items={hidden.map((folder) => ({ label: folder.name, icon: <FolderGlyph color={folder.color} size={14} />, onSelect: () => actions.open(folder.id) }))} />
        </>
      )}
      {shown.map((folder) => (
        <Fragment key={folder.id}>
          <ChevronRight size={14} className="crumb-sep" aria-hidden />
          <Crumb id={folder.id} label={folder.name} actions={actions} />
        </Fragment>
      ))}
      <ChevronRight size={14} className="crumb-sep" aria-hidden />
      <button ref={ref} type="button" className="crumb is-current" aria-current="page" aria-haspopup="menu" onClick={() => setMenu(true)}>
        <FolderGlyph color={current.color} size={15} open />
        <span>{current.name}</span>
        <ChevronDown size={14} className="crumb-caret" />
      </button>
      <Menu open={menu} onClose={() => setMenu(false)} anchor={ref} title={current.name} items={folderMenuItems(current, actions)} />
    </nav>
  );
}
