import { DEFAULT_MODEL } from "@/lib/agent/models";
import type { AgentChat, PendingEdit } from "@/lib/agent/types";

const STORAGE_KEY = "inline-chats-v1";
const MAX_CHATS = 40;

export type StoredChats = {
  chats: AgentChat[];
  activeId: string;
  open: boolean;
  minimized: boolean;
  drafts: Record<string, string>;
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
  };
}

export function loadChats(): StoredChats | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredChats>;
    if (!Array.isArray(parsed.chats) || parsed.chats.length === 0) return null;
    const chats = parsed.chats.filter(isChat);
    if (!chats.length) return null;
    const activeId = chats.some((chat) => chat.id === parsed.activeId) ? (parsed.activeId as string) : chats[0].id;
    return {
      chats,
      activeId,
      open: Boolean(parsed.open),
      minimized: Boolean(parsed.minimized),
      drafts: cleanDrafts(parsed.drafts, chats),
    };
  } catch {
    return null;
  }
}

export function saveChats(session: {
  chats: AgentChat[];
  activeId: string;
  open: boolean;
  minimized: boolean;
  drafts?: Record<string, string>;
}) {
  if (typeof window === "undefined") return;
  const trimmed = session.chats
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHATS);
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      chats: trimmed,
      activeId: session.activeId,
      open: session.open,
      minimized: session.minimized,
      drafts: cleanDrafts(session.drafts, trimmed),
    }),
  );
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
  return chats.map((chat) => (chat.id === id ? { ...chat, ...patch, updatedAt: Date.now() } : chat));
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
  return typeof chat.id === "string" && typeof chat.title === "string" && Array.isArray(chat.turns);
}

export function relativeTime(timestamp: number) {
  const delta = Date.now() - timestamp;
  if (delta < 45_000) return "Just now";
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.max(1, Math.round(delta / 3_600_000))}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.max(1, Math.round(delta / 86_400_000))}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
