"use client";

import { parseChatMarkup } from "@/lib/agent/chatMarkup";

export function ChatText({ text, caret }: { text: string; caret?: boolean }) {
  const parts = parseChatMarkup(text);
  return (
    <>
      {parts.map((part, index) => {
        const key = `${part.type}-${index}`;
        if (part.type === "strong") return <strong key={key}>{part.value}</strong>;
        if (part.type === "em") return <em key={key}>{part.value}</em>;
        if (part.type === "code") return <code key={key}>{part.value}</code>;
        return <span key={key}>{part.value}</span>;
      })}
      {caret ? <span className="chat-caret" /> : null}
    </>
  );
}
