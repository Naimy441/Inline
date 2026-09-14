"use client";

import { MdCheckCircle, MdExpandMore, MdRadioButtonUnchecked, MdTimelapse } from "react-icons/md";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/agent/Collapsible";
import type { AgentTask } from "@/lib/agent/types";

function statusIcon(status: AgentTask["status"]) {
  if (status === "done") return <MdCheckCircle aria-hidden="true" />;
  if (status === "in_progress") return <MdTimelapse aria-hidden="true" />;
  return <MdRadioButtonUnchecked aria-hidden="true" />;
}

export function TaskPanel({
  tasks,
  onToggle,
}: {
  tasks: AgentTask[];
  onToggle: (id: string) => void;
}) {
  if (!tasks.length) return null;
  const done = tasks.filter((task) => task.status === "done").length;
  return (
    <Collapsible className="agent-tasks" defaultOpen>
      <CollapsibleTrigger className="agent-tasks-trigger">
        <span>Tasks</span>
        <em>
          {done}/{tasks.length}
        </em>
        <MdExpandMore aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="agent-tasks-list">
        {tasks.map((task) => (
          <div key={task.id} className={`agent-task${task.status === "done" ? " is-done" : ""}`}>
            <button
              type="button"
              className="agent-task-check"
              aria-pressed={task.status === "done"}
              onClick={() => onToggle(task.id)}
            >
              {statusIcon(task.status)}
            </button>
            <span>
              <strong>{task.title}</strong>
              {task.kind ? <em>{task.kind}</em> : null}
            </span>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
