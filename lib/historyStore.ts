import type { HeaderAlign, PageNumberLocation, StoredComment } from "@/lib/documentStore";
import type { PageLayout } from "@/lib/pagination";

export type HistorySnapshot = {
  id: string;
  at: number;
  label: string;
  title: string;
  html: string;
  headerText: string;
  footerText: string;
  firstHeaderText?: string;
  firstFooterText?: string;
  showHeader: boolean;
  showFooter: boolean;
  showPageNumbers: boolean;
  differentFirstPage?: boolean;
  pageNumberLocation: PageNumberLocation;
  headerAlign: HeaderAlign;
  footerAlign?: HeaderAlign;
  fontFamily: string;
  fontSize: string;
  columns: number;
  lineSpacing: string;
  pageLayout?: PageLayout;
  comments: StoredComment[];
};

const STORAGE_KEY = "inline-history-v1";
const MAX_SNAPSHOTS = 36;

export function loadHistory(): HistorySnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { snapshots?: unknown };
    if (!Array.isArray(parsed.snapshots)) return [];
    return parsed.snapshots.filter(isSnapshot).slice(0, MAX_SNAPSHOTS);
  } catch {
    return [];
  }
}

export function saveHistory(snapshots: HistorySnapshot[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ snapshots: snapshots.slice(0, MAX_SNAPSHOTS) }));
  } catch {
    // Ignore quota.
  }
}

export function pushSnapshot(
  list: HistorySnapshot[],
  next: Omit<HistorySnapshot, "id" | "at">,
): { list: HistorySnapshot[]; snapshot: HistorySnapshot } {
  const last = list[0];
  if (last && last.html === next.html && last.title === next.title) {
    return { list, snapshot: last };
  }
  const snapshot: HistorySnapshot = {
    ...next,
    id: crypto.randomUUID(),
    at: Date.now(),
  };
  return { list: [snapshot, ...list].slice(0, MAX_SNAPSHOTS), snapshot };
}

export function snapshotLabel(kind: "manual" | "agent" | "auto" | "restore") {
  if (kind === "agent") return "Before AI edit";
  if (kind === "manual") return "Saved version";
  if (kind === "restore") return "Before restore";
  return "Autosave";
}

function isSnapshot(value: unknown): value is HistorySnapshot {
  if (!value || typeof value !== "object") return false;
  const row = value as HistorySnapshot;
  return typeof row.id === "string" && typeof row.html === "string" && typeof row.title === "string";
}
