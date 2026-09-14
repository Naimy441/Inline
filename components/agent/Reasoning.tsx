"use client";

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MdExpandMore, MdPsychology } from "react-icons/md";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/agent/Collapsible";
import { Shimmer } from "@/components/agent/Shimmer";

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  duration?: number;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

function useReasoning() {
  const value = useContext(ReasoningContext);
  if (!value) throw new Error("Reasoning parts must be used inside Reasoning");
  return value;
}

export const Reasoning = memo(function Reasoning({
  isStreaming = false,
  duration,
  children,
}: {
  isStreaming?: boolean;
  duration?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(isStreaming);
  const [elapsed, setElapsed] = useState<number | undefined>(duration);
  const started = useRef<number | null>(isStreaming ? Date.now() : null);
  const streamed = useRef(isStreaming);
  const closedOnce = useRef(false);

  useEffect(() => {
    if (isStreaming) {
      streamed.current = true;
      if (started.current == null) started.current = Date.now();
      setOpen(true);
      closedOnce.current = false;
      return;
    }
    if (started.current != null) {
      setElapsed(Math.max(1, Math.ceil((Date.now() - started.current) / 1000)));
      started.current = null;
    }
    if (streamed.current && !closedOnce.current) {
      const timer = window.setTimeout(() => {
        setOpen(false);
        closedOnce.current = true;
      }, 800);
      return () => window.clearTimeout(timer);
    }
  }, [isStreaming]);

  const value = useMemo(
    () => ({ isStreaming, isOpen: open, duration: duration ?? elapsed }),
    [isStreaming, open, duration, elapsed],
  );

  return (
    <ReasoningContext.Provider value={value}>
      <Collapsible className="agent-reasoning" open={open} onOpenChange={setOpen}>
        {children}
      </Collapsible>
    </ReasoningContext.Provider>
  );
});

export const ReasoningTrigger = memo(function ReasoningTrigger() {
  const { isStreaming, isOpen, duration } = useReasoning();
  const label = isStreaming
    ? "Thinking"
    : duration
      ? `Thought for ${duration}s`
      : "Thought for a few seconds";
  return (
    <CollapsibleTrigger className="agent-reasoning-trigger">
      <MdPsychology aria-hidden="true" />
      {isStreaming ? <Shimmer>{label}…</Shimmer> : <span>{label}</span>}
      <MdExpandMore aria-hidden="true" className={isOpen ? "is-open" : undefined} />
    </CollapsibleTrigger>
  );
});

export const ReasoningContent = memo(function ReasoningContent({ children }: { children: string }) {
  return (
    <CollapsibleContent className="agent-reasoning-body">
      <p>{children}</p>
    </CollapsibleContent>
  );
});
