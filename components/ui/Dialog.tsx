"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    requestAnimationFrame(() => {
      // Prefer a field over tabs or buttons, so opening a form doesn't land focus on its first tab.
      const first =
        ref.current?.querySelector<HTMLElement>("[autofocus]") ??
        ref.current?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select") ??
        ref.current?.querySelector<HTMLElement>("button:not(.dialog-close)");
      first?.focus();
    });
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <div className="dialog-header">
          <div>
            <h2 className="dialog-title">{title}</h2>
            {description && <p className="dialog-description">{description}</p>}
          </div>
          <button type="button" className="dialog-close icon-btn icon-btn-sm" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {children && <div className="dialog-body">{children}</div>}
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
