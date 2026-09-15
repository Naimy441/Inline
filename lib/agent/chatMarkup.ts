export type ChatMark = {
  type: "text" | "strong" | "em" | "code";
  value: string;
};

const MARK = /(`[^`]+`|\*\*[^*]+\*\*|_[^_\n]+_|\*[^*\n]+\*)/g;

export function parseChatMarkup(text: string): ChatMark[] {
  if (!text) return [];
  const parts: ChatMark[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  MARK.lastIndex = 0;
  while ((match = MARK.exec(text))) {
    if (match.index > last) parts.push({ type: "text", value: cleanMarkers(text.slice(last, match.index)) });
    const token = match[0];
    if (token.startsWith("`")) parts.push({ type: "code", value: token.slice(1, -1) });
    else if (token.startsWith("**")) parts.push({ type: "strong", value: token.slice(2, -2) });
    else parts.push({ type: "em", value: token.slice(1, -1) });
    last = match.index + token.length;
  }
  if (last < text.length) parts.push({ type: "text", value: cleanMarkers(text.slice(last)) });
  return parts.filter((part) => part.value.length > 0);
}

function cleanMarkers(value: string) {
  return value.replace(/\*\*/g, "");
}
