import { DEFAULT_MODEL } from "@/lib/agent/models";
import type { AgentChat, PendingEdit } from "@/lib/agent/types";

const MAX_CHATS = 40;
const CHAT_KEY_PREFIX = "inline-chats-v2:";

function chatKey(documentId: string) {
  return `${CHAT_KEY_PREFIX}${documentId}`;
}

/** Reserve the chat column before React hydrates so the doc toolbar measures at the right width. */
export const chatLayoutBootScript = `try{var p=new URLSearchParams(location.search).get("doc");if(p){var raw=localStorage.getItem(${JSON.stringify(CHAT_KEY_PREFIX)}+p);var c=raw?JSON.parse(raw):null;if(c&&c.open&&!c.minimized)document.documentElement.dataset.chat="open";else if(c&&c.open&&c.minimized)document.documentElement.dataset.chat="min"}else{delete document.documentElement.dataset.chat}}catch(e){}`;

export type StoredChats = {
  chats: AgentChat[];
  activeId: string;
  open: boolean;
  minimized: boolean;
  drafts: Record<string, string>;
  openIds: string[];
};

const MAX_DRAFT = 20_000;

export function createChat(
  defaults?: Partial<Pick<AgentChat, "mode" | "model" | "thinkingLevel">>,
): AgentChat {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    titled: false,
    createdAt: now,
    updatedAt: now,
    mode: defaults?.mode ?? "agent",
    model: defaults?.model ?? DEFAULT_MODEL,
    thinkingLevel: defaults?.thinkingLevel ?? "medium",
    turns: [],
    tasks: [],
  };
}

export function loadChats(documentId: string): StoredChats | null {
  if (typeof window === "undefined" || !documentId) return null;
  try {
    const raw = window.localStorage.getItem(chatKey(documentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredChats>;
    if (!Array.isArray(parsed.chats) || parsed.chats.length === 0) return null;
    const chats = parsed.chats.filter(isChat);
    if (!chats.length) return null;
    const activeId = chats.some((chat) => chat.id === parsed.activeId) ? (parsed.activeId as string) : chats[0].id;
    const openIds = cleanOpenIds(parsed.openIds, chats, activeId);
    return {
      chats,
      activeId,
      open: Boolean(parsed.open),
      minimized: Boolean(parsed.minimized),
      drafts: cleanDrafts(parsed.drafts, chats),
      openIds,
    };
  } catch {
    return null;
  }
}

export function saveChats(
  documentId: string,
  session: {
    chats: AgentChat[];
    activeId: string;
    open: boolean;
    minimized: boolean;
    drafts?: Record<string, string>;
    openIds?: string[];
  },
) {
  if (typeof window === "undefined" || !documentId) return;
  const trimmed = session.chats
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHATS);
  if (!trimmed.length) return;
  try {
    window.localStorage.setItem(
      chatKey(documentId),
      JSON.stringify({
        chats: trimmed,
        activeId: session.activeId,
        open: session.open,
        minimized: session.minimized,
        drafts: cleanDrafts(session.drafts, trimmed),
        openIds: cleanOpenIds(session.openIds, trimmed, session.activeId),
      }),
    );
  } catch {
    /* Keep the previous backup if storage is full or blocked. */
  }
}

export function clearChats(documentId: string) {
  if (typeof window === "undefined" || !documentId) return;
  window.localStorage.removeItem(chatKey(documentId));
}

export function cleanOpenIds(value: unknown, chats: AgentChat[], activeId: string) {
  const ids = new Set(chats.map((chat) => chat.id));
  const listed = Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && ids.has(id))
    : [];
  const unique = [...new Set(listed)];
  if (ids.has(activeId) && !unique.includes(activeId)) unique.unshift(activeId);
  return unique.length ? unique : chats[0] ? [chats[0].id] : [];
}

export function cleanDrafts(value: unknown, chats: AgentChat[]) {
  const drafts = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const ids = new Set(chats.map((chat) => chat.id));
  const next: Record<string, string> = {};
  for (const [id, text] of Object.entries(drafts)) {
    if (!ids.has(id) || typeof text !== "string") continue;
    const draft = text.slice(0, MAX_DRAFT);
    if (draft.trim()) next[id] = draft;
  }
  return next;
}

export function titleFromPrompt(prompt: string) {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  if (clean.length <= 42) return clean;
  const cut = clean.slice(0, 42);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 18 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

export function cleanChatTitle(value: unknown) {
  if (typeof value !== "string") return undefined;
  const title = value.replace(/\s+/g, " ").trim();
  if (title.length < 2 || title.length > 48) return undefined;
  return title;
}

export function patchChat(chats: AgentChat[], id: string, patch: Partial<AgentChat>): AgentChat[] {
  return chats.map((chat) => {
    if (chat.id !== id) return chat;
    const next: AgentChat = { ...chat, ...patch, updatedAt: Date.now() };
    if ((patch.mode && patch.mode !== chat.mode) || (patch.model && patch.model !== chat.model)) {
      next.continuation = undefined;
    }
    return next;
  });
}

export function setEditStatus(
  chats: AgentChat[],
  editId: string,
  status: PendingEdit["status"],
): AgentChat[] {
  return chats.map((chat) => ({
    ...chat,
    turns: chat.turns.map((turn) => ({
      ...turn,
      edits: turn.edits.map((edit) =>
        edit.id === editId && edit.status === "pending" ? { ...edit, status } : edit,
      ),
    })),
    updatedAt: chat.turns.some((turn) => turn.edits.some((edit) => edit.id === editId))
      ? Date.now()
      : chat.updatedAt,
  }));
}

export function removeTurnsFrom(chats: AgentChat[], chatId: string, turnId: string) {
  return chats.map((chat) => {
    if (chat.id !== chatId) return chat;
    const index = chat.turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) return chat;
    return { ...chat, turns: chat.turns.slice(0, index), continuation: undefined, updatedAt: Date.now() };
  });
}

export function acceptMissingEdits(chats: AgentChat[], liveIds: string[]) {
  const live = new Set(liveIds);
  let next = chats;
  for (const id of pendingEditIds(chats)) {
    if (!live.has(id)) next = setEditStatus(next, id, "accepted");
  }
  return next;
}

export function pendingEditIds(chats: AgentChat[]) {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const chat of chats) {
    for (const turn of chat.turns) {
      for (const edit of turn.edits) {
        if (edit.status !== "pending" || seen.has(edit.id)) continue;
        seen.add(edit.id);
        ids.push(edit.id);
      }
    }
  }
  return ids;
}

function isChat(value: unknown): value is AgentChat {
  if (!value || typeof value !== "object") return false;
  const chat = value as AgentChat;
  if (typeof chat.id !== "string" || typeof chat.title !== "string" || !Array.isArray(chat.turns)) return false;
  if (!Array.isArray(chat.tasks)) chat.tasks = [];
  if (chat.continuation && typeof chat.continuation !== "object") chat.continuation = undefined;
  return true;
}

export function relativeTime(timestamp: number) {
  const delta = Date.now() - timestamp;
  if (delta < 45_000) return "Just now";
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.max(1, Math.round(delta / 3_600_000))}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.max(1, Math.round(delta / 86_400_000))}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
