"use client";

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MdChevronRight } from "react-icons/md";
import { ChatText } from "@/components/agent/ChatText";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/agent/Collapsible";
import { Shimmer } from "@/components/agent/Shimmer";
import { formatThoughtLabel } from "@/lib/agent/timeline";

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  durationSec?: number;
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
  defaultOpen,
  children,
}: {
  isStreaming?: boolean;
  duration?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(isStreaming || Boolean(defaultOpen));
  const [elapsed, setElapsed] = useState<number | undefined>(duration);
  const started = useRef<number | null>(isStreaming ? Date.now() : null);
  const streamed = useRef(isStreaming);

  useEffect(() => {
    if (isStreaming) {
      streamed.current = true;
      if (started.current == null) started.current = Date.now();
      setOpen(true);
      return;
    }
    if (started.current != null) {
      setElapsed(Math.max(0, Math.round((Date.now() - started.current) / 1000)));
      started.current = null;
    }
    if (streamed.current) setOpen(false);
  }, [isStreaming]);

  const durationSec = duration ?? elapsed;
  const value = useMemo(
    () => ({ isStreaming, isOpen: open, durationSec }),
    [isStreaming, open, durationSec],
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
  const { isStreaming, isOpen, durationSec } = useReasoning();
  const label = formatThoughtLabel({ streaming: isStreaming, durationSec });
  return (
    <CollapsibleTrigger className="agent-reasoning-trigger">
      {isStreaming ? <Shimmer>{label}</Shimmer> : <span>{label}</span>}
      <MdChevronRight aria-hidden="true" className={isOpen ? "is-open" : undefined} />
    </CollapsibleTrigger>
  );
});

export const ReasoningContent = memo(function ReasoningContent({ children }: { children: string }) {
  const { isStreaming } = useReasoning();
  return (
    <CollapsibleContent className="agent-reasoning-body">
      <div className="agent-reasoning-stream">
        <ChatText text={children} caret={isStreaming} />
      </div>
    </CollapsibleContent>
  );
});
