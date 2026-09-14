"use client";

import type { ReactNode } from "react";

export function Shimmer({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={className ? `chat-shimmer ${className}` : "chat-shimmer"}>{children}</span>;
}
