"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

type CollapsibleContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const CollapsibleContext = createContext<CollapsibleContextValue | null>(null);

export function useCollapsible() {
  const value = useContext(CollapsibleContext);
  if (!value) throw new Error("Collapsible parts must be used inside Collapsible");
  return value;
}

export function Collapsible({
  open,
  defaultOpen = false,
  onOpenChange,
  className,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  const [internal, setInternal] = useState(defaultOpen);
  const isOpen = open ?? internal;
  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternal(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange],
  );
  const value = useMemo(() => ({ open: isOpen, setOpen }), [isOpen, setOpen]);
  return (
    <CollapsibleContext.Provider value={value}>
      <div className={className} data-open={isOpen || undefined}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

export function CollapsibleTrigger({
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { open, setOpen } = useCollapsible();
  return (
    <button
      type="button"
      className={className}
      aria-expanded={open}
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) setOpen(!open);
      }}
    >
      {children}
    </button>
  );
}

export function CollapsibleContent({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { open } = useCollapsible();
  if (!open) return null;
  return (
    <div className={className} data-state="open">
      {children}
    </div>
  );
}
