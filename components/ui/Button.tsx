"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useShortcut } from "@/lib/client/platform";

/**
 * Firefox restores a button's enabled state from before a reload, which the server's HTML (and
 * so hydration) doesn't expect. React's types leave out autocomplete on buttons; browsers honour it.
 */
const NO_RESTORE = { autoComplete: "off" } as ButtonHTMLAttributes<HTMLButtonElement>;

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; icon?: ReactNode; loading?: boolean }
>(function Button({ variant = "secondary", size = "md", icon, loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...NO_RESTORE}
      className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ""}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden /> : icon}
      {children != null && <span className="btn-label">{children}</span>}
    </button>
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; active?: boolean; size?: "sm" | "md" | "lg" }
>(function IconButton({ label, shortcut, active, size = "md", className, children, ...rest }, ref) {
  const keys = useShortcut();
  return (
    <button
      ref={ref}
      type="button"
      {...NO_RESTORE}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      data-tip={shortcut ? `${label}  ${keys(shortcut)}` : label}
      className={`icon-btn icon-btn-${size}${active ? " is-active" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden />;
}

/** A shortcut written in Mac notation ("⌘L"), shown for the user's platform. */
export function Shortcut({ keys }: { keys: string }) {
  const format = useShortcut();
  return <>{format(keys)}</>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
