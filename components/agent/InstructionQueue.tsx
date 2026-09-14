"use client";

import { MdClose, MdExpandMore } from "react-icons/md";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/agent/Collapsible";
import type { AgentQueueItem } from "@/lib/agent/types";

export function InstructionQueue({
  items,
  onCancel,
}: {
  items: AgentQueueItem[];
  onCancel: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <Collapsible className="agent-queue" defaultOpen>
      <CollapsibleTrigger className="agent-queue-trigger">
        <span>Up next</span>
        <em>{items.length}</em>
        <MdExpandMore aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="agent-queue-list">
          {items.map((item) => (
            <li key={item.id} className="agent-queue-item">
              <span>{item.prompt}</span>
              {item.selection ? <small>{item.selection}</small> : null}
              <button type="button" aria-label={`Remove queued instruction`} onClick={() => onCancel(item.id)}>
                <MdClose aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
