"use client";

import { createContext, memo, useContext, useMemo, useState, type ReactNode } from "react";
import { MdExpandMore, MdRoute } from "react-icons/md";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/agent/Collapsible";
import type { AgentStep } from "@/lib/agent/types";

type ChainContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const ChainContext = createContext<ChainContextValue | null>(null);

function useChain() {
  const value = useContext(ChainContext);
  if (!value) throw new Error("ChainOfThought parts must be used inside ChainOfThought");
  return value;
}

export const ChainOfThought = memo(function ChainOfThought({
  defaultOpen = true,
  children,
}: {
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <ChainContext.Provider value={value}>
      <Collapsible className="agent-cot" open={open} onOpenChange={setOpen}>
        {children}
      </Collapsible>
    </ChainContext.Provider>
  );
});

export const ChainOfThoughtHeader = memo(function ChainOfThoughtHeader({ children }: { children?: ReactNode }) {
  const { open } = useChain();
  return (
    <CollapsibleTrigger className="agent-cot-trigger">
      <MdRoute aria-hidden="true" />
      <span>{children ?? "Working"}</span>
      <MdExpandMore aria-hidden="true" className={open ? "is-open" : undefined} />
    </CollapsibleTrigger>
  );
});

export const ChainOfThoughtContent = memo(function ChainOfThoughtContent({ children }: { children: ReactNode }) {
  return <CollapsibleContent className="agent-cot-steps">{children}</CollapsibleContent>;
});

export const ChainOfThoughtStep = memo(function ChainOfThoughtStep({
  label,
  description,
  status = "complete",
  hits,
}: {
  label: ReactNode;
  description?: ReactNode;
  status?: AgentStep["status"];
  hits?: string[];
}) {
  return (
    <div className={`agent-cot-step is-${status}`}>
      <div>
        <div className="agent-cot-label">{label}</div>
        {description ? <div className="agent-cot-detail">{description}</div> : null}
        {hits?.length ? (
          <div className="agent-cot-hits">
            {hits.map((hit) => (
              <span key={hit}>{hit}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function stepsFromLive(input: {
  phase: string;
  tools: string[];
  editCount: number;
  hasMessage: boolean;
}): AgentStep[] {
  const steps: AgentStep[] = [];
  input.tools.forEach((name, index) => {
    const last = index === input.tools.length - 1 && !input.editCount && !input.hasMessage;
    steps.push({
      id: `tool-${name}-${index}`,
      name,
      title: name.replace(/_/g, " "),
      status: last ? "active" : "complete",
    });
  });
  if (input.editCount) {
    steps.push({
      id: "edits",
      title: `Edited the document`,
      detail: `${input.editCount} ${input.editCount === 1 ? "change" : "changes"}`,
      status: input.hasMessage ? "complete" : "active",
    });
  }
  if (!steps.length && (input.phase === "Working" || input.phase === "Thinking" || input.phase === "Planning" || input.phase === "Checking")) {
    steps.push({ id: "phase", title: input.phase, status: "active" });
  }
  return steps;
}
