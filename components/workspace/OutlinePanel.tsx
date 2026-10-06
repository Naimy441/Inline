"use client";

import { ArrowDown, ArrowUp, ChevronRight, FileText, MoreVertical, PanelLeftClose, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import type { EditorState } from "prosemirror-state";
import { useMemo, useRef, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { addTab, deleteTab, moveTab, renameTab, scrollAfterOpen, useTabs } from "@/lib/client/tabs";
import type { DocumentMeta, TabHeading } from "@/lib/doc/settings";
import { IconButton } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/Confirm";
import { Menu } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";

/** A tab just added from this pane, named as soon as its page opens. */
let renameOnOpen: string | null = null;

const COLLAPSED_KEY = "inline-tab-outline-collapsed";

function outline(state: EditorState): TabHeading[] {
  const entries: TabHeading[] = [];
  state.doc.forEach((node, pos) => {
    if (node.type.name === "title") entries.push({ pos, level: 0, text: node.textContent });
    else if (node.type.name === "heading" && (node.attrs.level as number) <= 4) entries.push({ pos, level: node.attrs.level as number, text: node.textContent });
  });
  return entries.filter((entry) => entry.text.trim());
}

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** The tabs pane in the left margin, like Google Docs': the document's tabs, each with its outline. */
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
  // Each tab's outline stays open until its arrow is pressed.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => (typeof window === "undefined" ? new Set() : readCollapsed()));
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);
  const entries = useMemo(() => (state ? outline(state) : []), [state?.doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const head = state?.selection.head ?? 0;
  const current = [...entries].reverse().find((entry) => entry.pos <= head);
  const failed = (error: Error) => toast(error.message || "Couldn't change the tabs.", { tone: "error" });

  const toggleOutline = (id: string) =>
    setCollapsed((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next].slice(-500)));
      } catch {
        // ignore
      }
      return next;
    });

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
    const next = tabs[index - 1] ?? tabs[index + 1];
    if (id === session.id && next) router.push(`/d/${next.id}`);
    void deleteTab(id).catch(failed);
  };

  const move = (id: string, index: number) => {
    if (index < 0 || index >= tabs.length || tabs[index]?.id === id) return;
    void moveTab(id, index).catch(failed);
  };

  const openHeading = (tabId: string, pos: number) => {
    if (tabId === session.id) session.scrollTo(pos + 1, pos + 1);
    else {
      scrollAfterOpen(tabId, pos + 1);
      router.push(`/d/${tabId}`);
    }
  };

  const menuIndex = menu ? tabs.findIndex((tab) => tab.id === menu.id) : -1;
  const menuTab = menuIndex >= 0 ? tabs[menuIndex] : null;

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
        {tabs.map((tab, index) => {
          const open = tab.id === session.id;
          const headings = open ? entries : (tab.outline ?? []);
          const expanded = headings.length > 0 && !collapsed.has(tab.id);
          const dropping = drag && drag.over === tab.id && drag.id !== tab.id ? (drag.after ? " drop-after" : " drop-before") : "";
          return (
            <li
              key={tab.id}
              draggable={!readOnly && renaming === null}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", tab.title);
                setDrag({ id: tab.id, over: null, after: false });
              }}
              onDragOver={(event) => {
                if (!drag) return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                const after = event.clientY > box.top + Math.min(box.height, 34) / 2;
                if (drag.over !== tab.id || drag.after !== after) setDrag({ ...drag, over: tab.id, after });
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (!drag || drag.id === tab.id) return setDrag(null);
                const from = tabs.findIndex((item) => item.id === drag.id);
                let to = index + (drag.after ? 1 : 0);
                if (from < to) to -= 1;
                setDrag(null);
                move(drag.id, to);
              }}
              onDragEnd={() => setDrag(null)}
              className={`${drag?.id === tab.id ? "is-dragging" : ""}${dropping}`}
            >
              <div className={`tab-row${open ? " is-open" : ""}${menu?.id === tab.id ? " has-menu" : ""}`}>
                <button
                  type="button"
                  className={`tab-toggle${expanded ? " is-expanded" : ""}`}
                  aria-label={expanded ? `Hide ${tab.title} outline` : `Show ${tab.title} outline`}
                  aria-expanded={expanded}
                  disabled={!headings.length}
                  onClick={() => toggleOutline(tab.id)}
                >
                  {headings.length ? <ChevronRight size={13} /> : <FileText size={13} />}
                </button>
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
                    onClick={() => !open && router.push(`/d/${tab.id}`)}
                    onDoubleClick={() => !readOnly && setRenaming(tab.id)}
                  >
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
              {expanded && (
                <ul className="tab-outline">
                  {headings.map((entry) => (
                    <li key={entry.pos}>
                      <button
                        type="button"
                        className={`outline-item level-${entry.level}${open && current === entry ? " is-current" : ""}`}
                        onClick={() => openHeading(tab.id, entry.pos)}
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
          { label: "Move up", icon: <ArrowUp size={14} />, disabled: menuIndex <= 0, onSelect: () => menu && move(menu.id, menuIndex - 1) },
          { label: "Move down", icon: <ArrowDown size={14} />, disabled: menuIndex < 0 || menuIndex >= tabs.length - 1, onSelect: () => menu && move(menu.id, menuIndex + 1) },
          { kind: "separator" },
          {
            label: "Delete",
            icon: <Trash2 size={14} />,
            danger: true,
            disabled: tabs.length < 2,
            hint: tabs.length < 2 ? "A document keeps at least one tab" : undefined,
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
