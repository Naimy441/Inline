"use client";

import { useSyncExternalStore } from "react";
import { Store } from "@/lib/client/api";

type Toast = { id: number; message: string; tone: "info" | "error" | "success"; action?: { label: string; run: () => void } };

const toasts = new Store<Toast[]>([]);
let counter = 0;

export function toast(message: string, options: { tone?: Toast["tone"]; action?: Toast["action"]; duration?: number } = {}) {
  const id = ++counter;
  toasts.set((list) => [...list.slice(-3), { id, message, tone: options.tone ?? "info", action: options.action }]);
  setTimeout(() => toasts.set((list) => list.filter((item) => item.id !== id)), options.duration ?? 4000);
}

const noToasts = (): Toast[] => NO_TOASTS;
const NO_TOASTS: Toast[] = [];

export function Toaster() {
  const list = useSyncExternalStore(toasts.subscribe, toasts.get, noToasts);
  return (
    <div className="toaster" role="status" aria-live="polite">
      {list.map((item) => (
        <div key={item.id} className={`toast toast-${item.tone}`}>
          <span>{item.message}</span>
          {item.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                item.action!.run();
                toasts.set((all) => all.filter((entry) => entry.id !== item.id));
              }}
            >
              {item.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
