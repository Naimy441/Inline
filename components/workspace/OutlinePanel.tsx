"use client";

import { FileText, MoreVertical, PanelLeftClose, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import type { EditorState } from "prosemirror-state";
import { useMemo, useRef, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { addTab, deleteTab, renameTab, useTabs } from "@/lib/client/tabs";
import type { DocumentMeta } from "@/lib/doc/settings";
import { IconButton } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/Confirm";
import { Menu } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";
import { isCompact } from "@/lib/client/viewport";

/** A tab just added from this pane, named as soon as its page opens. */
let renameOnOpen: string | null = null;

type Entry = { pos: number; level: number; text: string };

function outline(state: EditorState): Entry[] {
  const entries: Entry[] = [];
  state.doc.forEach((node, pos) => {
    if (node.type.name === "title") entries.push({ pos, level: 0, text: node.textContent });
    else if (node.type.name === "heading" && (node.attrs.level as number) <= 4) entries.push({ pos, level: node.attrs.level as number, text: node.textContent });
  });
  return entries.filter((entry) => entry.text.trim());
}

/** The tabs pane in the left margin, like Google Docs': the document's tabs, with the open tab's outline under it. */
export function OutlinePanel({
  session,
  state,
  meta,
  readOnly = false,
  onClose,
}: {
  session: DocumentSession;
  state: EditorState | null;
  meta: DocumentMeta | null;
  readOnly?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const loaded = useTabs(session.id);
  const tabs = loaded ?? [{ id: session.id, title: meta?.tabTitle || "Tab 1" }];
  const [renaming, setRenaming] = useState<string | null>(() => {
    const id = renameOnOpen;
    renameOnOpen = null;
    return id;
  });
  const [menu, setMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const entries = useMemo(() => (state ? outline(state) : []), [state?.doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const head = state?.selection.head ?? 0;
  const current = [...entries].reverse().find((entry) => entry.pos <= head);
  const failed = (error: Error) => toast(error.message || "Couldn't change the tabs.", { tone: "error" });

  const add = () =>
    void addTab(session.id)
      .then((id) => {
        renameOnOpen = id;
        router.push(`/d/${id}`);
      })
      .catch(failed);

  const remove = async (id: string) => {
    const tab = tabs.find((item) => item.id === id);
    const ok = await confirmDialog({
      title: `Delete “${tab?.title ?? "this tab"}”?`,
      body: "The tab and everything in it are deleted for good.",
      confirmLabel: "Delete tab",
      danger: true,
    });
    if (!ok) return;
    const index = tabs.findIndex((item) => item.id === id);
    const next = tabs[index - 1] ?? tabs[0]!;
    if (id === session.id) router.push(`/d/${next.id}`);
    void deleteTab(id).catch(failed);
  };

  const menuTab = menu ? tabs.find((tab) => tab.id === menu.id) : null;
  const menuIndex = menuTab ? tabs.indexOf(menuTab) : -1;

  return (
    <nav className="outline" aria-label="Document tabs">
      <div className="outline-head">
        <span className="outline-title">Document tabs</span>
        {!readOnly && (
          <IconButton label="Add tab" size="sm" onClick={add}>
            <Plus size={15} />
          </IconButton>
        )}
        <IconButton label="Hide tabs & outline" size="sm" onClick={onClose}>
          <PanelLeftClose size={15} />
        </IconButton>
      </div>
      <ul className="tab-list">
        {tabs.map((tab) => {
          const open = tab.id === session.id;
          return (
            <li key={tab.id}>
              <div className={`tab-row${open ? " is-open" : ""}${menu?.id === tab.id ? " has-menu" : ""}`}>
                {renaming === tab.id ? (
                  <TabNameInput
                    initial={tab.title}
                    onDone={(title) => {
                      setRenaming(null);
                      if (title && title !== tab.title) void renameTab(tab.id, title).catch(failed);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="tab-name"
                    aria-current={open ? "page" : undefined}
                    onClick={() => {
                      if (!open) router.push(`/d/${tab.id}`);
                      if (isCompact()) onClose();
                    }}
                    onDoubleClick={() => !readOnly && setRenaming(tab.id)}
                  >
                    <FileText size={14} />
                    <span>{tab.title}</span>
                  </button>
                )}
                {!readOnly && renaming !== tab.id && (
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm tab-more"
                    aria-label={`${tab.title} options`}
                    onClick={(event) => setMenu({ id: tab.id, rect: event.currentTarget.getBoundingClientRect() })}
                  >
                    <MoreVertical size={14} />
                  </button>
                )}
              </div>
              {open && entries.length > 0 && (
                <ul className="tab-outline">
                  {entries.map((entry) => (
                    <li key={entry.pos}>
                      <button
                        type="button"
                        className={`outline-item level-${entry.level}${current === entry ? " is-current" : ""}`}
                        onClick={() => {
                          session.scrollTo(entry.pos + 1, entry.pos + 1);
                          if (isCompact()) onClose();
                        }}
                      >
                        {entry.text}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {tabs.length === 1 && entries.length === 0 && <p className="outline-empty">Headings you add appear here.</p>}
      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchor={menu?.rect ?? null}
        title={menuTab?.title}
        items={[
          { label: "Rename", icon: <Pencil size={14} />, onSelect: () => menu && setRenaming(menu.id) },
          {
            label: "Delete",
            icon: <Trash2 size={14} />,
            danger: true,
            disabled: menuIndex === 0,
            hint: menuIndex === 0 ? "The first tab holds the document" : undefined,
            onSelect: () => menu && void remove(menu.id),
          },
        ]}
      />
    </nav>
  );
}

function TabNameInput({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <input
      className="tab-name-input"
      aria-label="Tab name"
      value={value}
      maxLength={100}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value.trim() || null)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(value.trim() || null);
        if (event.key === "Escape") {
          event.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}
