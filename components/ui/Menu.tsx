"use client";

import { Check, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition, type Placement } from "./floating";

export type MenuItem =
  | {
      kind?: "item";
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      checked?: boolean;
      disabled?: boolean;
      danger?: boolean;
      onSelect?: () => void;
      submenu?: MenuItem[];
      hint?: string;
    }
  | { kind: "separator" }
  | { kind: "label"; label: string };

/** Keyboard-navigable dropdown menu. */
export function Menu({
  open,
  onClose,
  anchor,
  items,
  placement = "bottom-start",
  className,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null> | DOMRect | null;
  items: MenuItem[];
  placement?: Placement;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const style = useAnchoredPosition(open, anchor, ref, placement, 4);
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null);
  const selectable = items.map((item, index) => ({ item, index })).filter(({ item }) => (item.kind ?? "item") === "item" && !(item as { disabled?: boolean }).disabled);

  const choose = useCallback(
    (item: MenuItem, element?: HTMLElement | null) => {
      if (item.kind === "separator" || item.kind === "label") return;
      const entry = item;
      if (entry.submenu && element) {
        setSub({ index: items.indexOf(item), rect: element.getBoundingClientRect() });
        return;
      }
      onClose();
      entry.onSelect?.();
    },
    [items, onClose],
  );

  // Reset highlight and submenu whenever the menu closes.
  useEffect(() => {
    if (open) return;
    setActive(-1);
    setSub(null);
  }, [open]);

  // Listeners read the latest props through a ref, so they subscribe once per opening
  // instead of on every render (items and callbacks are new objects each time).
  const latest = useRef({ onClose, anchor, active, selectable, choose, items, sub });
  latest.current = { onClose, anchor, active, selectable, choose, items, sub };

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const { anchor, onClose } = latest.current;
      const target = event.target as HTMLElement;
      if (target.closest?.(".menu")) return;
      if (anchor && "current" in anchor && anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      const { sub, onClose, selectable, active, choose, items } = latest.current;
      if (sub) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const positions = selectable.map((entry) => entry.index);
        if (!positions.length) return;
        const current = positions.indexOf(active);
        const next = event.key === "ArrowDown" ? (current + 1) % positions.length : (current - 1 + positions.length) % positions.length;
        setActive(positions[next]!);
      } else if ((event.key === "Enter" || event.key === "ArrowRight") && active >= 0) {
        event.preventDefault();
        choose(items[active]!, ref.current?.querySelector<HTMLElement>(`[data-index="${active}"]`));
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  const subItem = sub ? (items[sub.index] as { submenu?: MenuItem[] }) : null;
  return createPortal(
    <>
      <div ref={ref} role="menu" className={`menu${className ? ` ${className}` : ""}`} style={{ position: "fixed", ...style }}>
        {items.map((item, index) => {
          if (item.kind === "separator") return <div key={index} className="menu-sep" role="separator" />;
          if (item.kind === "label") return <div key={index} className="menu-label">{item.label}</div>;
          return (
            <button
              key={index}
              type="button"
              role={item.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={item.checked}
              data-index={index}
              className={`menu-item${active === index ? " is-active" : ""}${item.danger ? " is-danger" : ""}`}
              disabled={item.disabled}
              onMouseEnter={(event) => {
                setActive(index);
                if (item.submenu) setSub({ index, rect: event.currentTarget.getBoundingClientRect() });
                else setSub(null);
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => choose(item, event.currentTarget)}
            >
              <span className="menu-icon">{item.checked ? <Check size={14} /> : item.icon}</span>
              <span className="menu-text">
                {item.label}
                {item.hint && <span className="menu-hint">{item.hint}</span>}
              </span>
              {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
              {item.submenu && <ChevronRight size={14} className="menu-chevron" />}
            </button>
          );
        })}
      </div>
      {sub && subItem?.submenu && (
        <Menu open onClose={() => { setSub(null); onClose(); }} anchor={sub.rect} items={subItem.submenu} placement="right-start" className="menu-sub" />
      )}
    </>,
    document.body,
  );
}

/** A trigger button with its dropdown menu. */
export function MenuButton({
  items,
  children,
  className,
  placement,
  label,
}: {
  items: MenuItem[] | (() => MenuItem[]);
  children: ReactNode;
  className?: string;
  placement?: Placement;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        data-tip={label}
        className={`${className ?? "menu-trigger"}${open ? " is-open" : ""}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
      >
        {children}
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={ref} items={open ? (typeof items === "function" ? items() : items) : []} placement={placement} />
    </>
  );
}
