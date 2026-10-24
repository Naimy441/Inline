"use client";

import { Check, ChevronRight, CloudOff, Download, History, ListTree, Loader2, MessageSquare, Moon, MoreHorizontal, PanelRight, Sparkles, Sun } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { EditorState } from "prosemirror-state";
import type { SelectionContext } from "@/lib/agent/types";
import { api, patch, post, uploadFile } from "@/lib/client/api";
import { DocumentSession, geometryFor, type ClientCommand, type DocumentUiState, type EditorMode } from "@/lib/client/documentSession";
import { useTheme } from "@/lib/client/theme";
import { useShortcut } from "@/lib/client/platform";
import { docPlainText, docWordCount, followedDocumentTitle, wordCount } from "@/lib/doc/editing";
import { cleanTitle, type DocComment, type DocumentMeta } from "@/lib/doc/settings";
import { clipboardLink, insertImage, insertText, silentClipboardText } from "@/lib/editor/commands";
import { AgentPanel, type AgentPanelHandle } from "@/components/agent/AgentPanel";
import { Spark } from "@/components/agent/Activity";
import { PanelResizer } from "@/components/ui/PanelResizer";
import { loadServerPlatform, revealOnDisk } from "@/lib/client/fileManager";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ConfirmHost } from "@/components/ui/Confirm";
import { MenuButton, type MenuItem } from "@/components/ui/Menu";
import { toast, Toaster } from "@/components/ui/Toast";
import { InlineLogo } from "@/components/ui/Logo";
import { CommentsPanel } from "@/components/workspace/CommentsPanel";
import { CommentMargin, marginFits } from "@/components/workspace/CommentMargin";
import { FindBar } from "@/components/workspace/FindBar";
import { DraftBanner, DraftPreview } from "@/components/workspace/DraftBar";
import { HistoryPanel, VersionPreview, type VersionSummary } from "@/components/workspace/HistoryPanel";
import { prefetchVersions } from "@/lib/client/versions";
import { acquireChat, releaseChat, rememberChat, rememberedChat } from "@/lib/client/chatSession";
import { addTab, rememberedRoot, takeScroll, useTabs } from "@/lib/client/tabs";
import { documentMenus, MenuBar, type MenuActions } from "@/components/workspace/MenuBar";
import { OutlinePanel } from "@/components/workspace/OutlinePanel";
import { PageCanvas } from "@/components/workspace/PageCanvas";
import { PageSetupDialog } from "@/components/workspace/PageSetupDialog";
import { ReviewBar } from "@/components/workspace/ReviewBar";
import { EDITOR_MODES, modeMenuItems } from "@/components/workspace/modes";
import { COMPACT_QUERY, isCompact, useMediaQuery, useVisualViewportVars } from "@/lib/client/viewport";
import { DEFAULT_PREFERENCES, loadPreferences, preferences, setPreference } from "@/lib/client/preferences";
import { anchorAt, clampAboveLock, clampZoom, commentFitReserve, fitScale, pinchBox, pinchTransform, placeOnAxis, scrollForAnchor, stepPinch, touchDistance, touchMidpoint, zoomFromPinch, zoomFromWheel, type PinchFrame, type ZoomAnchor } from "@/lib/client/zoom";
import { PictureBar } from "@/components/workspace/PictureBar";
import { SelectionBubble } from "@/components/workspace/SelectionBubble";
import { ShortcutsDialog } from "@/components/workspace/ShortcutsDialog";
import { ContextMenu } from "@/components/workspace/ContextMenu";
import { AgentLocator, OfflineNotice, PdfImportNotice } from "@/components/workspace/CanvasNotices";
import { SpecialCharactersDialog } from "@/components/workspace/SpecialCharactersDialog";
import { StyleDialog } from "@/components/workspace/StyleDialog";
import { Toolbar } from "@/components/workspace/Toolbar";

type Panel = "agent" | "comments" | "history" | null;
type Zoom = number | "fit";

const PANEL_KEY = "inline-panel";
const PANEL_WIDTH_KEY = "inline-panel-width";
// A new key, so the "fit" default that older builds stored does not override the 100% start.
const ZOOM_KEY = "inline-zoom-lock";
const OUTLINE_KEY = "inline-outline";
const FOCUS_KEY = "inline-focus-mode";

function readStored<T>(key: string, fallback: T, parse: (raw: string) => T | null): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function Workspace({ documentId }: { documentId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const initialAsk = search.get("ask");
  const agentRef = useRef<AgentPanelHandle>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const { dark, toggle: toggleTheme } = useTheme();
  const keys = useShortcut();

  const [panel, setPanelState] = useState<Panel>("agent");
  const [panelWidth, setPanelWidth] = useState(420);
  const [zoom, setZoomState] = useState<Zoom>(1);
  /** Scale above the toolbar lock while a pinch or ctrl+scroll is zoomed in. Null on the lock. */
  const [lift, setLift] = useState<number | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const canvasRef = useRef<HTMLElement>(null);
  /** Screen point to hold still across the next zoom commit. */
  const zoomAnchor = useRef<ZoomAnchor | null>(null);
  /** Latest scale, updated synchronously so a burst of pinch events compounds. */
  const zoomNow = useRef(1);
  /** Scale React has committed. A pinch previews ahead of this and must not be overwritten by a render. */
  const committedZoom = useRef(1);
  /** A pinch is painting its own transform; renders must not snap it back to the committed scale. */
  const gestureActive = useRef(false);
  const livePinch = useRef<(PinchFrame & { stack: HTMLElement }) | null>(null);
  const pinchOrigin = useRef({ x: 0, y: 0 });
  const pinchSettle = useRef(0);
  /** Returning to the lock scrolls back to the top of the centered page. A resize while already there does not. */
  const centerScroll = useRef(false);
  // Below this width, or when they don't fit beside the title, the menu bar and labelled buttons fold into a "More" menu.
  const titlebarRef = useRef<HTMLElement>(null);
  const narrow = useMediaQuery(COMPACT_QUERY);
  const tabs = useTabs(documentId);
  const openTab = tabs && tabs.length > 1 ? tabs.find((tab) => tab.id === documentId) : undefined;
  const crowded = useCrowdedTitlebar(titlebarRef, narrow, openTab?.title ?? "");
  const compact = narrow || crowded;
  useVisualViewportVars();
  const [outline, setOutline] = useState(false);
  const [find, setFind] = useState<{ replace: boolean } | null>(null);
  const [linkEditing, setLinkEditing] = useState(false);
  const [linkSession, setLinkSession] = useState(0);
  const [linkPrefill, setLinkPrefill] = useState<string | null>(null);
  const linkGeneration = useRef(0);
  const [prompting, setPrompting] = useState(false);
  // ⌘K owns links. A URL already on the clipboard is read only when that read stays silent.
  const openLinkEditor = useCallback((readClipboard: boolean) => {
    const generation = ++linkGeneration.current;
    setLinkPrefill(null);
    setLinkSession((n) => n + 1);
    setLinkEditing(true);
    if (!readClipboard) return;
    void silentClipboardText()
      .then((raw) => {
        if (raw == null || linkGeneration.current !== generation) return;
        if (clipboardLink(raw)) setLinkPrefill(raw.trim());
      })
      .catch(() => undefined);
  }, []);
  /** The text a new comment is being written about. */
  const [draftComment, setDraftComment] = useState<{ from: number; to: number } | null>(null);
  /** A saved version shown in place of the document, from version history. */
  const [versionShown, setVersionShown] = useState<VersionSummary | null>(null);
  const [draftPreview, setDraftPreview] = useState(false);
  const [setup, setSetup] = useState<{ tab: "page" | "text" | "header" } | null>(null);
  const [styleEditor, setStyleEditor] = useState<{ id: string | null } | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [counting, setCounting] = useState(false);
  const [charmap, setCharmap] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const focusRef = useRef(false);
  focusRef.current = focusMode;
  // The inline ⌘⇧K prompt is open: start Claude Code while the user types.
  useEffect(() => {
    if (prompting && !focusMode) agentRef.current?.warm();
  }, [prompting, focusMode]);

  // Before the first paint, so a panel kept closed doesn't flash open.
  useLayoutEffect(() => {
    const focusOn = readStored(FOCUS_KEY, false, (raw) => raw === "1");
    setFocusMode(focusOn);
    // On phones and tablets a panel covers the document, so it only opens when asked for.
    if (isCompact()) setPanelState(initialAsk && !focusOn ? "agent" : null);
    else {
      // "none" is the choice to keep panels closed, so it can't parse to null (which means "not stored").
      const stored = readStored<Panel | "none">(PANEL_KEY, "agent", (raw) => (["none", "agent", "comments", "history"].includes(raw) ? (raw as Panel | "none") : null));
      const next = stored === "none" ? null : stored;
      if (focusOn && next === "agent") store(PANEL_KEY, "none");
      setPanelState(focusOn && next === "agent" ? null : next);
    }
    setPanelWidth(readStored(PANEL_WIDTH_KEY, 420, (raw) => (Number(raw) >= 320 ? Math.min(760, Number(raw)) : null)));
    // Desktop windows start at 100%. Phones and tablets have no room for a whole page, so they start in Fit.
    setZoomState(readStored<Zoom>(ZOOM_KEY, isCompact() ? "fit" : 1, (raw) => (raw === "fit" ? "fit" : Number(raw) >= 0.5 && Number(raw) <= 2 ? Number(raw) : null)));
    setOutline(!isCompact() && readStored(OUTLINE_KEY, false, (raw) => raw === "1"));
  }, []);

  const setPanel = useCallback((next: Panel | ((current: Panel) => Panel)) => {
    setPanelState((current) => {
      let value = typeof next === "function" ? next(current) : next;
      // Focus mode keeps the chat closed even if a shortcut or stored panel asks for it.
      if (focusRef.current && value === "agent") value = current === "agent" ? null : current;
      store(PANEL_KEY, value ?? "none");
      return value;
    });
  }, []);

  const toggleOutline = useCallback(
    () =>
      setOutline((value) => {
        store(OUTLINE_KEY, value ? "0" : "1");
        return !value;
      }),
    [],
  );

  // "Fit" tracks the canvas. Opening or closing a panel changes that width, so the lock moves with it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setCanvasWidth(canvas.clientWidth));
    observer.observe(canvas);
    setCanvasWidth(canvas.clientWidth);
    return () => observer.disconnect();
  }, []);

  const commandHandler = useRef<(command: ClientCommand) => void>(() => undefined);
  const keyHandler = useRef<(name: "link" | "find" | "replace" | "comment" | "askClaude" | "askClaudeInline") => boolean>(() => false);

  const session = useMemo(
    () =>
      new DocumentSession(documentId, {
        onCommand: (command) => commandHandler.current(command),
        onKeyCommand: (name) => keyHandler.current(name),
      }),
    [documentId],
  );

  const ui = useWorkspaceUi(session);
  // Warm version history once the document is open, so the panel opens with its list.
  const ready = ui.status === "ready";
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    api<{ draft: { updatedAt: number; words: number } | null }>(`/api/documents/${documentId}/draft`)
      .then((result) => {
        if (!cancelled) session.ui.set((current) => ({ ...current, draft: result.draft }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ready, documentId, session]);
  useEffect(() => {
    if (!ui.draft) setDraftPreview(false);
  }, [ui.draft]);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => prefetchVersions(documentId), 2500);
    return () => clearTimeout(timer);
  }, [ready, documentId]);
  // A heading picked in another tab's outline.
  useEffect(() => {
    if (!ready) return;
    const pos = takeScroll(documentId);
    // After the pages are laid out, so the heading is where it will stay.
    if (pos === null) return;
    const timer = setTimeout(() => session.scrollTo(pos, pos, "start"), 120);
    return () => clearTimeout(timer);
  }, [ready, documentId, session]);
  const prefs = useSyncExternalStore(preferences.subscribe, preferences.get, () => DEFAULT_PREFERENCES);
  useEffect(() => {
    loadPreferences();
  }, []);
  const meta = ui.meta;
  // A document's tabs share one Claude chat, kept under the first tab's id.
  const [rememberedChatKey] = useState(() => (typeof window === "undefined" ? documentId : rememberedRoot(documentId)));
  const chatKey = meta ? (meta.parentId ?? meta.id) : rememberedChatKey;
  // Keep the document's chat open while the panel is closed, so opening it shows the chat at once.
  useEffect(() => {
    const chatId = rememberedChat(chatKey);
    if (!chatId) return;
    const chat = acquireChat(chatId);
    return () => releaseChat(chat);
  }, [chatKey]);

  // A PDF being converted shows Claude's conversion chat in a browser that has no chat open for the document yet.
  const conversionChat = meta?.pdfImport?.status === "converting" ? meta.pdfImport.chatId : undefined;
  useEffect(() => {
    if (!conversionChat || rememberedChat(chatKey)) return;
    rememberChat(chatKey, conversionChat);
    agentRef.current?.openChat(conversionChat);
  }, [conversionChat, chatKey]);

  const canvasPad = canvasWidth && canvasWidth < 900 ? 16 : 40;
  const geometry = geometryFor(meta);
  const pageWidth = geometry.pageWidth;
  const shownPanel: Panel = focusMode && panel === "agent" ? null : panel;
  // The resize observer reports the canvas after paint. Measuring here, before
  // paint, lets Fit follow a panel opening or closing in the same frame.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) setCanvasWidth(canvas.clientWidth);
  }, [shownPanel, outline, focusMode]);
  const commentsBeside = shownPanel == null && (draftComment != null || ui.comments.some((comment) => !comment.resolved));
  // Half an inch of background on each side, in whatever width the panels have left.
  // Floating comments take a column out of that width so Fit still leaves them room.
  const baseFit = fitScale(canvasWidth, pageWidth);
  const lifted = zoom === "fit" && lift != null && lift > baseFit + 0.0005;
  const commentReserve = zoom === "fit" && !lifted && commentsBeside ? commentFitReserve(canvasWidth, pageWidth) : 0;
  const fitZoom = commentReserve > 0 ? fitScale(Math.max(0, canvasWidth - commentReserve), pageWidth) : baseFit;
  const lockZoom = zoom === "fit" ? fitZoom : zoom;
  const raised = lift != null && lift > lockZoom + 0.0005 ? lift : null;
  const effectiveZoom = raised ?? lockZoom;
  committedZoom.current = effectiveZoom;
  if (!gestureActive.current) zoomNow.current = effectiveZoom;
  const floorRef = useRef(lockZoom);
  floorRef.current = lockZoom;

  const dropGesture = () => {
    const live = livePinch.current;
    gestureActive.current = false;
    livePinch.current = null;
    if (pinchSettle.current) {
      clearTimeout(pinchSettle.current);
      pinchSettle.current = 0;
    }
    return live;
  };

  // The toolbar sets the lock and returns to the centered layout at that zoom.
  const setZoom = (value: Zoom) => {
    const live = dropGesture();
    if (live) {
      zoomNow.current = committedZoom.current;
      live.stack.style.transform = committedZoom.current === 1 ? "" : `scale(${committedZoom.current})`;
    }
    zoomAnchor.current = null;
    centerScroll.current = true;
    setLift(null);
    const stored: Zoom = value === "fit" ? "fit" : clampZoom(value);
    setZoomState(stored);
    store(ZOOM_KEY, String(stored));
  };

  // A pinch above the lock keeps the pointer still. Reaching the lock clears it.
  const raiseZoom = (value: number, visual: { left: number; top: number; width: number; height: number }, origin: { x: number; y: number }) => {
    zoomAnchor.current = anchorAt(visual, origin.x, origin.y);
    setLift(value);
  };
  const releaseToLock = () => {
    zoomAnchor.current = null;
    centerScroll.current = true;
    setLift(null);
  };
  const raiseRef = useRef(raiseZoom);
  const releaseRef = useRef(releaseToLock);
  raiseRef.current = raiseZoom;
  releaseRef.current = releaseToLock;

  // After the scaled frame is in the DOM, hold the pointer still while zoomed past
  // the lock. On the lock, clear that and return to the centered layout.
  // PageCanvas calls this in its own layout effect, which runs before comments measure.
  const zoomCommit = useRef<(() => void) | null>(null);
  zoomCommit.current = () => {
    const live = livePinch.current;
    if (gestureActive.current && live?.stack.isConnected) {
      live.stack.style.transformOrigin = "0 0";
      live.stack.style.transform = pinchTransform(live);
      return;
    }
    const anchor = zoomAnchor.current;
    const canvas = canvasRef.current;
    zoomNow.current = effectiveZoom;
    zoomAnchor.current = null;
    if (!canvas) return;
    const frame = canvas.querySelector(".page-stack-frame");
    const wrap = canvas.querySelector(".page-stack-wrap");
    if (!(frame instanceof HTMLElement) || !(wrap instanceof HTMLElement)) return;
    if (wrap.classList.contains("is-flow")) {
      if (!anchor) return;
      const next = scrollForAnchor(canvas, frame.getBoundingClientRect(), anchor);
      canvas.scrollLeft = next.scrollLeft;
      canvas.scrollTop = next.scrollTop;
      return;
    }
    const pad = Number.parseFloat(canvas.style.getPropertyValue("--canvas-pad")) || 40;
    const padRight = pad + (canvas.classList.contains("with-comments") ? 296 : 0);
    const padTop = 28;
    const padBottom = 120;
    if (!raised || !anchor) {
      wrap.classList.remove("is-anchored");
      wrap.style.paddingLeft = "";
      wrap.style.paddingRight = "";
      wrap.style.paddingTop = "";
      wrap.style.paddingBottom = "";
      const pan = placeOnAxis({
        canvas: canvas.clientWidth,
        page: frame.offsetWidth,
        padStart: pad,
        padEnd: padRight,
        pageStart: (canvas.clientWidth - frame.offsetWidth) / 2,
        center: true,
      });
      if (Math.abs(pan.padStart - pad) >= 0.5) wrap.style.paddingLeft = `${pan.padStart}px`;
      if (Math.abs(pan.padEnd - padRight) >= 0.5) wrap.style.paddingRight = `${pan.padEnd}px`;
      void wrap.offsetWidth;
      canvas.scrollLeft = pan.scroll;
      if (centerScroll.current) canvas.scrollTop = 0;
      centerScroll.current = false;
      return;
    }
    const box = canvas.getBoundingClientRect();
    const pageLeft = anchor.clientX - box.left - canvas.clientLeft - anchor.fx * frame.offsetWidth;
    const pageTop = anchor.clientY - box.top - canvas.clientTop - anchor.fy * frame.offsetHeight;
    const x = placeOnAxis({ canvas: canvas.clientWidth, page: frame.offsetWidth, padStart: pad, padEnd: padRight, pageStart: pageLeft, center: false });
    const y = placeOnAxis({ canvas: canvas.clientHeight, page: frame.offsetHeight, padStart: padTop, padEnd: padBottom, pageStart: pageTop, center: false });
    wrap.classList.add("is-anchored");
    wrap.style.paddingLeft = `${x.padStart}px`;
    wrap.style.paddingRight = `${x.padEnd}px`;
    wrap.style.paddingTop = `${y.padStart}px`;
    wrap.style.paddingBottom = `${y.padEnd}px`;
    // Padding changes the scroll size. Read it before assigning, or the new offset is clamped to the old range.
    void wrap.offsetWidth;
    canvas.scrollLeft = x.scroll;
    canvas.scrollTop = y.scroll;
  };

  // Pinch and ctrl+wheel zoom the page. A plain wheel keeps scrolling it.
  // The scale is written on the page stack inside the event. Waiting for React
  // would re-render the workspace and only paint on a later frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let pinch: { distance: number; zoom: number } | null = null;
    let gestureZoom = 0;

    const paint = (frame: PinchFrame & { stack: HTMLElement }) => {
      frame.stack.style.transformOrigin = "0 0";
      frame.stack.style.transform = pinchTransform(frame);
    };

    const begin = () => {
      const existing = livePinch.current;
      if (existing) return existing;
      const stack = canvas.querySelector(".page-stack");
      if (!(stack instanceof HTMLElement) || !stack.offsetWidth) return null;
      const rect = stack.getBoundingClientRect();
      const frame: PinchFrame & { stack: HTMLElement } = {
        stack,
        left: rect.left,
        top: rect.top,
        width: stack.offsetWidth,
        height: stack.offsetHeight,
        tx: 0,
        ty: 0,
        scale: zoomNow.current,
      };
      livePinch.current = frame;
      gestureActive.current = true;
      return frame;
    };

    const commit = () => {
      if (pinchSettle.current) {
        clearTimeout(pinchSettle.current);
        pinchSettle.current = 0;
      }
      const frame = livePinch.current;
      if (!frame) return;
      const value = clampAboveLock(frame.scale, floorRef.current);
      const visual = pinchBox(frame);
      const origin = pinchOrigin.current;
      livePinch.current = null;
      gestureActive.current = false;
      if (value <= floorRef.current + 0.0005) {
        frame.stack.style.transform = floorRef.current === 1 ? "" : `scale(${floorRef.current})`;
        zoomNow.current = floorRef.current;
        flushSync(() => releaseRef.current());
        return;
      }
      if (Math.abs(value - committedZoom.current) < 0.0005) {
        frame.stack.style.transform = committedZoom.current === 1 ? "" : `scale(${committedZoom.current})`;
        zoomNow.current = committedZoom.current;
        return;
      }
      // Measure the anchor against the preview, then let React catch the scroll size up
      // before paint, so the page doesn't jump when the live translate is dropped.
      zoomNow.current = committedZoom.current;
      flushSync(() => raiseRef.current(value, visual, origin));
    };

    const settle = () => {
      if (pinchSettle.current) clearTimeout(pinchSettle.current);
      pinchSettle.current = window.setTimeout(commit, 80);
    };

    const apply = (next: number, origin: { x: number; y: number }) => {
      const value = clampAboveLock(next, floorRef.current);
      if (Math.abs(value - zoomNow.current) < 0.0005) return;
      pinchOrigin.current = origin;
      if (value <= floorRef.current + 0.0005) {
        const frame = livePinch.current;
        livePinch.current = null;
        gestureActive.current = false;
        if (pinchSettle.current) {
          clearTimeout(pinchSettle.current);
          pinchSettle.current = 0;
        }
        if (frame) frame.stack.style.transform = floorRef.current === 1 ? "" : `scale(${floorRef.current})`;
        zoomNow.current = floorRef.current;
        flushSync(() => releaseRef.current());
        return;
      }
      const frame = begin();
      if (!frame) {
        flushSync(() => raiseRef.current(value, { left: origin.x, top: origin.y, width: 0, height: 0 }, origin));
        return;
      }
      const stepped = stepPinch(frame, origin, value);
      frame.tx = stepped.tx;
      frame.ty = stepped.ty;
      frame.scale = stepped.scale;
      paint(frame);
      zoomNow.current = value;
    };

    const onWheel = (event: WheelEvent) => {
      // Trackpad pinch arrives as a wheel with ctrlKey set. Plain scrolling must not zoom.
      if (!event.ctrlKey || event.altKey || gestureZoom || pinch) return;
      if (!event.cancelable) return;
      event.preventDefault();
      apply(zoomFromWheel(zoomNow.current, event.deltaY, event.deltaMode), { x: event.clientX, y: event.clientY });
      settle();
    };

    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureZoom = zoomNow.current;
    };
    const onGestureChange = (event: Event) => {
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      event.preventDefault();
      // A finger pinch is handled from the touch points; Safari also emits gesture events for it.
      if (pinch || !gestureZoom || !gesture.scale) return;
      const box = canvas.getBoundingClientRect();
      apply(zoomFromPinch(gestureZoom, 1, gesture.scale), {
        x: gesture.clientX ?? box.left + box.width / 2,
        y: gesture.clientY ?? box.top + box.height / 2,
      });
      settle();
    };
    const onGestureEnd = () => {
      const fromGesture = gestureZoom !== 0 && !pinch;
      gestureZoom = 0;
      if (fromGesture) commit();
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      pinch = { distance: touchDistance(Array.from(event.touches)), zoom: zoomNow.current };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return;
      if (event.cancelable) event.preventDefault();
      const fingers = Array.from(event.touches);
      apply(zoomFromPinch(pinch.zoom, pinch.distance, touchDistance(fingers)), touchMidpoint(fingers));
      settle();
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length >= 2) return;
      const wasPinch = pinch !== null;
      pinch = null;
      if (wasPinch) commit();
    };

    canvas.addEventListener("wheel", onWheel, { passive: false, capture: true });
    canvas.addEventListener("gesturestart", onGestureStart as EventListener, { passive: false });
    canvas.addEventListener("gesturechange", onGestureChange as EventListener, { passive: false });
    canvas.addEventListener("gestureend", onGestureEnd);
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);
    canvas.addEventListener("touchcancel", onTouchEnd);
    return () => {
      if (pinchSettle.current) clearTimeout(pinchSettle.current);
      canvas.removeEventListener("wheel", onWheel, { capture: true });
      canvas.removeEventListener("gesturestart", onGestureStart as EventListener);
      canvas.removeEventListener("gesturechange", onGestureChange as EventListener);
      canvas.removeEventListener("gestureend", onGestureEnd);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  // Edits that couldn't be merged after the server's copy changed (e.g. a server restart).
  const unmerged = ui.unmerged;
  useEffect(() => {
    if (!unmerged) return;
    toast(`${unmerged.steps === 1 ? "An edit" : "Some edits"} couldn't be merged with the server's copy. Save them as a new document?`, {
      tone: "error",
      duration: 30_000,
      action: {
        label: "Save copy",
        run: () =>
          void session
            .recoverUnmerged()
            .then((id) => id && toast("Saved your edits as a new document.", { action: { label: "Open", run: () => router.push(`/d/${id}`) } }))
            .catch(() => toast("Couldn't save the recovered edits.", { tone: "error" })),
      },
    });
  }, [unmerged, session, router]);

  const askClaude = useCallback(
    (prompt?: string) => {
      if (focusRef.current) return;
      const selection: SelectionContext | null = session.selection();
      // Focus the composer in the same tick when the panel is already open, so
      // keystrokes typed right after the shortcut never land in the document.
      if (agentRef.current) {
        agentRef.current.ask(selection, prompt);
        return;
      }
      session.view?.dom.blur();
      setPanel("agent");
      requestAnimationFrame(() => agentRef.current?.ask(selection, prompt));
    },
    [session, setPanel],
  );

  /** The inline ⌘⇧K prompt: sends straight to Claude about the selection, or the cursor when nothing is selected. */
  const inlineAsk = useCallback(
    (text: string, only?: SelectionContext) => {
      if (focusRef.current) return;
      const view = session.view;
      const selection: SelectionContext | null =
        only ??
        session.selection() ?? (view ? { documentId: session.id, text: "", from: view.state.selection.from, to: view.state.selection.from } : null);
      const deliver = (tries: number) => {
        if (agentRef.current) void agentRef.current.send(selection, text).catch(() => toast("Couldn't send that message.", { tone: "error" }));
        else if (tries > 0) requestAnimationFrame(() => deliver(tries - 1));
      };
      setPanel("agent");
      deliver(60);
    },
    [session, setPanel],
  );

  /** Spelling and grammar for the selection, or the paragraph at the cursor (⌘⌥X). */
  const checkSpelling = useCallback(() => {
    const view = session.view;
    if (!view) return;
    let selection = session.selection();
    if (!selection) {
      const { $from } = view.state.selection;
      const from = $from.start();
      const to = $from.end();
      const text = view.state.doc.textBetween(from, to, "\n");
      if (!text.trim()) {
        toast("Put the cursor in a paragraph or select some text to check.");
        return;
      }
      selection = { documentId: session.id, text, from, to };
    }
    inlineAsk("Fix spelling, grammar and punctuation in the selected text only. Don't change the meaning, voice or wording beyond what's needed. If it's already correct, say so and don't edit.", selection);
  }, [session, inlineAsk]);

  const startComment = useCallback(() => {
    if (!session.view || session.view.state.selection.empty) {
      toast("Select the text you want to comment on.");
      return;
    }
    const { from, to } = session.view.state.selection;
    // With no side panel open and room beside the page, the comment is written in the margin next to its text.
    const sidePanel = focusRef.current && panel === "agent" ? null : panel;
    const canvas = canvasRef.current;
    // Fit can shrink to make the column. The page is still full width on this frame, so the live rect would say no.
    const beside =
      sidePanel === null &&
      (marginFits(canvas) ||
        (zoom === "fit" &&
          !(lift != null && lift > fitScale(canvas?.clientWidth ?? 0, pageWidth) + 0.0005) &&
          canvas != null &&
          commentFitReserve(canvas.clientWidth, pageWidth) > 0));
    // Paint the field before this shortcut returns. The next key is already waiting,
    // and it has to land in the comment, not replace the selected text.
    flushSync(() => {
      if (!beside) setPanel("comments");
      setDraftComment({ from, to });
    });
    document.querySelector<HTMLTextAreaElement>(".comment-card.is-draft .comment-input")?.focus({ preventScroll: true });
    session.setCommentDraft({ from, to });
  }, [session, setPanel, panel, zoom, lift, pageWidth]);
  const endDraft = useCallback(() => {
    setDraftComment(null);
    session.setCommentDraft(null);
  }, [session]);
  const askAboutComment = useCallback(
    (comment: DocComment) => {
      if (focusRef.current) return;
      setPanel("agent");
      requestAnimationFrame(() =>
        agentRef.current?.ask(null, `Address this comment (id ${comment.id}) on “${comment.quote}”: ${comment.body}\nThen reply to the comment saying what you changed and resolve it.`),
      );
    },
    [setPanel],
  );

  keyHandler.current = (name) => {
    if (name === "find" || name === "replace") setFind({ replace: name === "replace" });
    else if (name === "link") openLinkEditor(true);
    else if (name === "comment") startComment();
    else if (name === "askClaude" && !focusRef.current) askClaude();
    else if (name === "askClaudeInline" && !focusRef.current && session.ui.get().mode !== "viewing") {
      setLinkEditing(false);
      setPrompting(true);
    }
    return true;
  };

  const [exporting, setExporting] = useState<{ format: "docx" | "md" | "html" | "txt"; scope: "all" | "tab" } | null>(null);
  const download = useCallback(
    async (format: "docx" | "pdf" | "md" | "html" | "txt", changes?: "with" | "without", scope: "all" | "tab" = "all") => {
      // A document with tabs downloads all of them, in order, unless asked for the open tab only.
      const others = scope === "all" && tabs && tabs.length > 1 ? tabs.map((tab) => tab.id) : null;
      if (format !== "pdf" && !changes && session.ui.get().hunks.length) {
        setExporting({ format, scope });
        return;
      }
      if (format === "pdf") {
        const addTabs = others ? (await import("@/components/workspace/exportTabs")).withOtherTabs(documentId, others) : undefined;
        await session.exportPdf(addTabs).catch((error: Error) => toast(`Couldn't export the PDF: ${error.message}`, { tone: "error" }));
        return;
      }
      await session.whenSaved();
      const link = document.createElement("a");
      link.href = `/api/documents/${documentId}/export?format=${format}${changes === "without" ? "&changes=without" : ""}${others ? "&tabs=all" : ""}`;
      link.download = "";
      document.body.append(link);
      link.click();
      link.remove();
    },
    [session, documentId, tabs],
  );

  commandHandler.current = (command) => {
    if (command.kind === "print") void session.print();
    else if (command.kind === "export_pdf") void download("pdf", undefined, command.tabs ?? "tab");
    else if (command.kind === "download") {
      const link = document.createElement("a");
      link.href = command.url;
      link.download = command.filename;
      document.body.append(link);
      link.click();
      link.remove();
    } else if (command.kind === "open_document" && command.documentId !== documentId && !focusRef.current) {
      toast("Your assistant opened another document.", { action: { label: "Open", run: () => router.push(`/d/${command.documentId}`) } });
    } else if (command.kind === "scroll_to") session.followEdit(command.from, command.to);
    else if (command.kind === "render_pages") void session.answerRender(command).catch(() => undefined);
    else if (command.kind === "measure_fit") void session.answerFit(command).catch(() => undefined);
  };

  // App-level shortcuts that work even when the editor isn't focused.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modKey = event.metaKey || event.ctrlKey;
      if (!modKey) return;
      const key = event.key.toLowerCase();
      // Mode shortcuts match Google Docs; event.code because Alt changes event.key on macOS.
      const modeByCode: Record<string, EditorMode> = { KeyZ: "editing", KeyX: "suggesting", KeyC: "viewing" };
      if (event.altKey && event.shiftKey && modeByCode[event.code]) {
        event.preventDefault();
        void session.setMode(modeByCode[event.code]!);
        return;
      }
      if (event.shiftKey && !event.altKey && event.code === "KeyP") {
        event.preventDefault();
        session.setShowInvisibles(!preferences.get().showInvisibles);
        return;
      }
      // Links own ⌘K. Edit with AI inline — the selection sent from the document — is ⌘⇧K.
      if (key === "k" && event.shiftKey && !event.altKey && session.view?.hasFocus() && session.ui.get().mode !== "viewing") {
        if (focusRef.current) return;
        event.preventDefault();
        setPrompting(true);
        return;
      }
      if (event.altKey && !event.shiftKey && event.code === "KeyX" && session.view?.hasFocus() && session.ui.get().mode !== "viewing") {
        if (focusRef.current) return;
        event.preventDefault();
        checkSpelling();
        return;
      }
      if (key === "j" && !event.shiftKey && !event.altKey) {
        if (focusRef.current) return;
        event.preventDefault();
        setPanel((current) => (current === "agent" ? null : "agent"));
      } else if (key === "l" && !event.shiftKey && !event.altKey) {
        if (focusRef.current) return;
        event.preventDefault();
        askClaude();
      } else if (key === "/") {
        event.preventDefault();
        setShortcuts(true);
      } else if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        void session.print();
      } else if (key === "f" && !event.shiftKey && !(event.target as HTMLElement).closest?.(".agent-panel")) {
        event.preventDefault();
        setFind({ replace: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [askClaude, checkSpelling, setPanel, session]);

  const insertImageFile = async (file: File) => {
    try {
      const uploaded = await uploadFile(file);
      if (uploaded.kind !== "image") {
        toast("That file isn't an image.", { tone: "error" });
        return;
      }
      session.run(insertImage(uploaded.url, file.name.replace(/\.[^.]+$/, "")));
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't upload the image.", { tone: "error" });
    }
  };

  // For the File menu's "Show in Finder" label; read when the menu opens, so nothing re-renders.
  useEffect(() => void loadServerPlatform(), []);

  const actions: MenuActions = {
    newDocument: async () => {
      const { document } = await post<{ document: { meta: DocumentMeta } }>("/api/documents", {});
      router.push(`/d/${document.meta.id}`);
    },
    goHome: () => router.push("/"),
    duplicate: async () => {
      await session.whenSaved();
      const { document } = await post<{ document: { meta: DocumentMeta } }>(`/api/documents/${documentId}/duplicate`);
      toast(`Created "${document.meta.title}".`, { action: { label: "Open", run: () => router.push(`/d/${document.meta.id}`) } });
    },
    download: (format) => void download(format),
    print: () => void session.print(),
    reveal: () => void session.whenSaved().then(() => revealOnDisk({ documentId })),
    pageSetup: (tab = "page") => setSetup({ tab }),
    editStyle: (styleId) => setStyleEditor({ id: styleId }),
    settings: meta?.settings,
    history: () => setPanel("history"),
    trash: async () => {
      await patch(`/api/documents/${documentId}`, { trashed: true });
      router.push("/");
    },
    find: (replace) => setFind({ replace }),
    link: () => openLinkEditor(true),
    comment: startComment,
    image: () => imageInput.current?.click(),
    zoom: setZoom,
    zoomFit: zoom === "fit" && raised == null,
    toggleTheme,
    dark,
    toggleOutline,
    addTab: () =>
      void addTab(documentId)
        .then((id) => router.push(`/d/${id}`))
        .catch((error: Error) => toast(error.message, { tone: "error" })),
    toggleAgent: () => {
      if (focusRef.current) return;
      setPanel((current) => (current === "agent" ? null : "agent"));
    },
    shortcuts: () => setShortcuts(true),
    connectClaudeCode: async () => {
      try {
        const { command } = await api<{ command: string }>("/api/mcp/connect");
        await navigator.clipboard.writeText(command);
        toast("Copied. Paste the command in a terminal to let Claude Code work in your Inline documents.", { tone: "success", duration: 8000 });
      } catch {
        toast("Couldn't copy the command. Open /api/mcp/connect to see it.", { tone: "error" });
      }
    },
    wordCount: () => setCounting(true),
    specialCharacters: () => setCharmap(true),
    notice: (message) => toast(message),
    paste: (plain) => void session.paste(plain).catch((error: Error) => toast(error.message, { tone: "error" })),
    clipboard: (action) => {
      if (!session.clipboard(action)) toast(`Select some text to ${action}.`);
    },
    fitWidth: () => setZoom("fit"),
    fullScreen: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen?.().catch(() => toast("Full screen isn't available here."));
    },
    focusMode,
    toggleFocusMode: () => {
      const next = !focusMode;
      focusRef.current = next;
      setFocusMode(next);
      store(FOCUS_KEY, next ? "1" : "0");
      if (next) {
        setPrompting(false);
        setPanel((current) => (current === "agent" ? null : current));
      }
      toast(next ? "Focus mode on. AI tools stay hidden until you turn it off in View." : "Focus mode off.");
    },
    mode: ui.mode,
    setMode: (mode) => void session.setMode(mode),
    showInvisibles: prefs.showInvisibles,
    toggleInvisibles: () => session.setShowInvisibles(!prefs.showInvisibles),
    spellcheck: prefs.spellcheck,
    toggleSpellcheck: () => session.setSpellcheck(!prefs.spellcheck),
    substitutions: prefs.substitutions,
    toggleSubstitutions: () => {
      setPreference("substitutions", !prefs.substitutions);
      toast(prefs.substitutions ? "Automatic substitutions off." : "Automatic substitutions on.");
    },
    devOptions: prefs.devOptions,
    toggleDevOptions: () => {
      const next = !prefs.devOptions;
      setPreference("devOptions", next);
      toast(next ? "Developer options on. Copy actions appear in AI chats." : "Developer options off.");
    },
    pdfAnnotations: meta?.pdfImport?.inkPages.length ? meta.pdfImport.showAnnotations : null,
    togglePdfAnnotations: () => void togglePdfAnnotations(),
    convertPdf: meta?.pdfImport && meta.pdfImport.status !== "done" && !focusMode ? () => void convertPdf() : null,
    checkSpelling,
    ask: (prompt) => {
      if (focusRef.current) return;
      setPanel("agent");
      requestAnimationFrame(() => agentRef.current?.ask(null, prompt));
    },
  };

  if (ui.status === "error" || ui.status === "deleted") {
    return (
      <div className="workspace-error">
        <InlineLogo size={32} />
        <h1>{ui.status === "deleted" ? "This document was deleted" : "Couldn't open this document"}</h1>
        <p>{ui.error ?? "It may have been moved to the trash or deleted in another window."}</p>
        <button type="button" className="btn btn-primary btn-md" onClick={() => router.push("/")}>
          <span className="btn-label">Back to documents</span>
        </button>
      </div>
    );
  }

  const openComments = ui.comments.filter((comment) => !comment.resolved).length;
  // With the chat closed, the counters float in the margin to the right of the text.
  const textInsetRight = (() => {
    if (!canvasWidth) return 200;
    const pageLeft = Math.max(canvasPad, (canvasWidth - pageWidth * effectiveZoom) / 2);
    return pageLeft + geometry.marginRight * effectiveZoom;
  })();
  const working = Boolean(ui.activity && ui.activity.status !== "idle");
  const chatOpen = shownPanel === "agent";

  /** Show a chat in the AI chat panel (the one converting an imported PDF). */
  const openChat = (chatId: string) => {
    if (focusRef.current) return;
    rememberChat(chatKey, chatId);
    setPanel("agent");
    requestAnimationFrame(() => agentRef.current?.openChat(chatId));
  };

  /** Start Claude on the pages of an imported PDF that are still pictures. */
  const convertPdf = async () => {
    try {
      const { chatId } = await post<{ chatId: string }>(`/api/documents/${documentId}/pdf`, {});
      openChat(chatId);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't start the conversion.", { tone: "error" });
    }
  };

  const togglePdfAnnotations = async () => {
    const show = !meta?.pdfImport?.showAnnotations;
    try {
      await patch(`/api/documents/${documentId}/pdf`, { showAnnotations: show });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't change the annotations.", { tone: "error" });
    }
  };
  const formats = (scope: "all" | "tab"): MenuItem[] => [
    { label: "Word (.docx)", onSelect: () => void download("docx", undefined, scope) },
    { label: "PDF (.pdf)", onSelect: () => void download("pdf", undefined, scope) },
    { label: "Markdown (.md)", onSelect: () => void download("md", undefined, scope) },
    { label: "Web page (.html)", onSelect: () => void download("html", undefined, scope) },
    { label: "Plain text (.txt)", onSelect: () => void download("txt", undefined, scope) },
  ];
  const downloads: MenuItem[] =
    tabs && tabs.length > 1
      ? [{ kind: "label", label: `All ${tabs.length} tabs` }, ...formats("all"), { kind: "separator" }, { label: "This tab only", submenu: formats("tab") }]
      : formats("all");
  // Phones fold the title bar's buttons and the menu bar into one menu.
  const moreItems = (): MenuItem[] => [
    { label: "Mode", hint: EDITOR_MODES[ui.mode].label, icon: EDITOR_MODES[ui.mode].icon(16), submenu: modeMenuItems(ui.mode, (mode) => void session.setMode(mode)) },
    { label: "Download", icon: <Download size={16} />, submenu: downloads },
    { label: "Version history", icon: <History size={16} />, onSelect: () => setPanel("history") },
    { label: "Dark theme", icon: <Moon size={16} />, checked: dark, onSelect: toggleTheme },
    { kind: "separator" },
    ...Object.entries(documentMenus(session, actions, effectiveZoom, ui.hunks.length)).map(([name, items]) => ({ label: name, submenu: items })),
  ];

  return (
    <div className={`workspace${shownPanel ? " has-panel" : ""}${focusMode ? " is-focus" : ""} is-${ui.mode}`} style={{ ["--panel-width" as string]: `${panelWidth}px` }}>
      <header ref={titlebarRef} className={`titlebar${compact ? " is-compact" : ""}`}>
        <button type="button" className="home-btn" aria-label="All documents" data-tip="All documents" onClick={() => router.push("/")}>
          <InlineLogo />
        </button>
        <div className="title-stack">
          <div className="title-line">
            <TitleInput meta={meta} session={session} onRename={(title) => void session.updateMeta({ title })} />
            {meta?.kind === "canvas" && <span className="canvas-kind-badge">Canvas</span>}
            {openTab && <TabHeading title={openTab.title} />}
          </div>
          <MenuBar session={session} actions={actions} zoom={effectiveZoom} hunks={ui.hunks.length} />
        </div>
        <div className="titlebar-status">
          <LiveSyncStatus session={session} compact={compact} />
        </div>
        {compact ? (
          <div className="titlebar-actions">
            <IconButton label="Tabs & outline" active={outline} onClick={toggleOutline}>
              <ListTree size={16} />
            </IconButton>
            <IconButton label="Comments" active={panel === "comments"} onClick={() => setPanel((current) => (current === "comments" ? null : "comments"))}>
              <MessageSquare size={16} />
              {openComments > 0 && <span className="badge">{openComments}</span>}
            </IconButton>
            {!focusMode && (
              <IconButton label="AI chat" className={`claude-toggle${panel === "agent" ? " is-active" : ""}${working ? " is-working" : ""}`} onClick={() => setPanel((current) => (current === "agent" ? null : "agent"))}>
                <Sparkles size={16} />
              </IconButton>
            )}
            <MenuButton className="icon-btn icon-btn-md" label="More options" title={meta?.title ?? "Document"} placement="bottom-end" items={moreItems}>
              <MoreHorizontal size={16} />
            </MenuButton>
          </div>
        ) : (
          <div className="titlebar-actions">
            <IconButton label={dark ? "Light theme" : "Dark theme"} onClick={toggleTheme}>
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </IconButton>
            <IconButton label="Version history" active={panel === "history"} onPointerEnter={() => prefetchVersions(documentId)} onClick={() => setPanel((current) => (current === "history" ? null : "history"))}>
              <History size={16} />
            </IconButton>
            <IconButton label="Tabs & outline" active={outline} onClick={toggleOutline}>
              <ListTree size={16} />
            </IconButton>
            <IconButton label="Comments" active={panel === "comments"} onClick={() => setPanel((current) => (current === "comments" ? null : "comments"))}>
              <MessageSquare size={16} />
              {openComments > 0 && <span className="badge">{openComments}</span>}
            </IconButton>
            {!focusMode && (
              <button
                type="button"
                className={`btn btn-md claude-toggle claude-toggle-text${panel === "agent" ? " is-active" : ""}`}
                onClick={() => setPanel((current) => (current === "agent" ? null : "agent"))}
                aria-pressed={panel === "agent"}
                data-tip={`${panel === "agent" ? "Close" : "Open"} AI chat  ${keys("⌘J")}`}
              >
                {/* With the panel closed, the button is where Claude shows it is working. */}
                {working && panel !== "agent" ? <Spark size={15} /> : <PanelRight size={15} />}
                <span className="btn-label">AI chat</span>
              </button>
            )}
            <MenuButton className="btn btn-secondary btn-md export-btn" label="Download" placement="bottom-end" items={downloads}>
              <Download size={15} />
              <span className="btn-label">Export</span>
            </MenuButton>
          </div>
        )}
      </header>

      <WithEditorState session={session}>
        {(state) => (
      <Toolbar
        session={session}
        state={state}
        meta={meta}
        zoom={effectiveZoom}
        zoomFit={zoom === "fit" && raised == null}
        zoomRaised={raised != null}
        onZoom={setZoom}
        onLink={() => openLinkEditor(true)}
        onComment={startComment}
        onImage={() => imageInput.current?.click()}
        onEditStyle={(styleId) => setStyleEditor({ id: styleId })}
        mode={ui.mode}
      />
        )}
      </WithEditorState>
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void insertImageFile(file);
          event.target.value = "";
        }}
      />

      <div className="workspace-body">
        {outline && (
          <>
            <div className="tabs-backdrop" onClick={toggleOutline} aria-hidden />
            <WithEditorState session={session}>{(state) => <OutlinePanel session={session} state={state} meta={meta} readOnly={ui.mode === "viewing"} onClose={toggleOutline} />}</WithEditorState>
          </>
        )}
        <div className="canvas-frame" style={{ ["--text-inset-right" as string]: `${textInsetRight}px` }}>
        <main
          ref={canvasRef}
          className={`canvas${(versionShown && shownPanel === "history") || draftPreview ? " is-previewing" : ""}${commentsBeside && (commentReserve > 0 || marginFits(canvasRef.current)) ? " with-comments" : ""}`}
          style={{ ["--canvas-pad" as string]: `${canvasPad}px` }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onPasteCapture={(event) => {
            if (!(event.target as HTMLElement).closest?.(".doc-content")) return;
            const data = event.clipboardData;
            const image = Array.from(data.files).find((item) => item.type.startsWith("image/"));
            // A screenshot or copied image file: upload it. Pasted HTML is left to the editor.
            if (image && !data.types.includes("text/html")) {
              event.preventDefault();
              event.stopPropagation();
              void insertImageFile(image);
              return;
            }
            if (data.types.includes("text/html") && data.getData("text/html").includes("data:image/")) {
              setTimeout(() => void session.uploadInlineImages(), 0);
            }
          }}
          onDrop={(event) => {
            const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/"));
            if (!file) return;
            event.preventDefault();
            void insertImageFile(file);
          }}
        >
          {find && <WithEditorState session={session}>{(state) => <FindBar session={session} state={state} replace={find.replace} onClose={() => setFind(null)} />}</WithEditorState>}
          <div className="canvas-notices">
            <OfflineNotice offline={ui.status === "ready" && (ui.connection === "reconnecting" || ui.sync === "error")} />
            {meta?.pdfImport && !focusMode && (
              <PdfImportNotice
                pdf={meta.pdfImport}
                working={working}
                chatOpen={shownPanel === "agent"}
                onConvert={() => void convertPdf()}
                onShowChat={() => {
                  if (meta.pdfImport?.chatId) openChat(meta.pdfImport.chatId);
                }}
                onToggleAnnotations={() => void togglePdfAnnotations()}
              />
            )}
          </div>
          <WithEditorState session={session}>{(state) => <AgentLocator canvas={canvasRef} state={state} active={working && !focusMode} label={ui.activity?.label ?? ""} />}</WithEditorState>
          {ui.status === "loading" && (
            <div className="canvas-loading">
              <Loader2 size={18} className="spin" />
            </div>
          )}
          {ui.draft && !versionShown && (
            <DraftBanner session={session} words={ui.draft.words} previewing={draftPreview} onPreview={() => setDraftPreview((current) => !current)} onClosePreview={() => setDraftPreview(false)} />
          )}
          {versionShown && shownPanel === "history" && <VersionPreview key={versionShown.id} session={session} version={versionShown} onClose={() => setVersionShown(null)} />}
          {draftPreview && ui.draft && !versionShown && <DraftPreview session={session} />}
          <div className="page-stack-slot">
            <PageCanvas session={session} meta={meta} pages={ui.pages} zoom={effectiveZoom} printing={ui.printing} flow={false} zoomCommit={zoomCommit} />
          </div>
          {!shownPanel && (
            <WithEditorState session={session}>
              {(state) => <CommentMargin session={session} state={state} canvas={canvasRef} comments={ui.comments} active={ui.activeComment} draft={draftComment} onDraftDone={endDraft} onAskClaude={askAboutComment} hideAskClaude={focusMode} />}
            </WithEditorState>
          )}
          <ReviewBar session={session} hunks={ui.hunks} hideClaude={focusMode} />
          <WithEditorState session={session}>{(state) => <SelectionBubble session={session} state={state} linkEditing={linkEditing} linkSession={linkSession} linkPrefill={linkPrefill} onLinkEditing={(open) => (open ? openLinkEditor(false) : setLinkEditing(false))} prompting={prompting && !focusMode} onPrompting={setPrompting} onInlineAsk={inlineAsk} hideAi={focusMode} />}</WithEditorState>
          <WithEditorState session={session}>{(state) => <PictureBar session={session} state={state} />}</WithEditorState>
        </main>
        <footer className="status-corner">
          {!chatOpen && <DocCounts session={session} pages={ui.pages} fallbackWords={meta?.wordCount ?? 0} onWords={() => setCounting(true)} />}
          {ui.mode !== "editing" && (
            <button type="button" className={`status-item status-mode is-${ui.mode}`} onClick={() => void session.setMode("editing")} data-tip="Back to editing">
              {EDITOR_MODES[ui.mode].icon(13)} {EDITOR_MODES[ui.mode].label}
            </button>
          )}
        </footer>
        </div>

        {shownPanel && (
          <div className="panel-shell">
            <PanelResizer
              width={panelWidth}
              onResize={(value) => {
                setPanelWidth(value);
                store(PANEL_WIDTH_KEY, String(value));
              }}
            />
            {shownPanel === "agent" && (
              <AgentPanel
                key={chatKey}
                ref={agentRef}
                documentId={documentId}
                chatKey={chatKey}
                hunks={ui.hunks}
                initialPrompt={initialAsk}
                documentCounts={chatOpen ? <DocCounts session={session} pages={ui.pages} fallbackWords={meta?.wordCount ?? 0} onWords={() => setCounting(true)} variant="meta" /> : undefined}
                onClose={() => setPanel(null)}
                onReview={(action, ids) => {
                  if (action === "next") session.gotoChange(1, ids);
                  else void session.review(action, ids);
                }}
              />
            )}
            {shownPanel === "comments" && (
              <CommentsPanel
                session={session}
                comments={ui.comments}
                active={ui.activeComment}
                draft={draftComment}
                onDraftDone={endDraft}
                onClose={() => setPanel(null)}
                onAskClaude={askAboutComment}
                hideAskClaude={focusMode}
              />
            )}
            {shownPanel === "history" && <HistoryPanel session={session} selected={versionShown} onSelect={setVersionShown} onClose={() => setPanel(null)} hideAi={focusMode} />}
          </div>
        )}
      </div>

      <PageSetupDialog open={Boolean(setup)} initialTab={setup?.tab} session={session} settings={meta?.settings} onClose={() => setSetup(null)} />
      <StyleDialog open={styleEditor !== null} styleId={styleEditor?.id ?? null} session={session} settings={meta?.settings} onClose={() => setStyleEditor(null)} />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} hideAi={focusMode} />
      <Dialog
        open={exporting !== null}
        onClose={() => setExporting(null)}
        title="Download with pending changes?"
        description={`${ui.hunks.length} change${ui.hunks.length === 1 ? " is" : "s are"} still waiting for review.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setExporting(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                const { format, scope } = exporting!;
                setExporting(null);
                void download(format, "without", scope);
              }}
            >
              Without them
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const { format, scope } = exporting!;
                setExporting(null);
                void download(format, "with", scope);
              }}
            >
              Include them
            </Button>
          </>
        }
      >
        <p>Include the pending changes as they appear now, or download the text as it was before them. Nothing in the document changes either way.</p>
      </Dialog>
      <SpecialCharactersDialog
        open={charmap}
        onClose={() => setCharmap(false)}
        onInsert={(char) => {
          session.run(insertText(char));
        }}
      />
      <ContextMenu session={session} hideClaude={focusMode} readOnly={ui.mode === "viewing"} onAsk={askClaude} onComment={startComment} onLink={() => openLinkEditor(true)} />
      <WordCountDialog open={counting} onClose={() => setCounting(false)} session={session} />
      <Toaster />
      <ConfirmHost />
    </div>
  );
}

function countLabel(count: number, singular: string) {
  return `${count.toLocaleString()} ${count === 1 ? singular : `${singular}s`}`;
}

/** The document's word and page counts. One item is singular. */
function DocCounts({ session, pages, fallbackWords, onWords, variant = "corner" }: { session: DocumentSession; pages: number; fallbackWords: number; onWords: () => void; variant?: "corner" | "meta" }) {
  const words = (
    <WithEditorState session={session}>{(state) => <>{countLabel(state ? docWordCount(state.doc) : fallbackWords, "word")}</>}</WithEditorState>
  );
  const pagesLabel = countLabel(pages, "page");
  if (variant === "meta") {
    return (
      <span className="msg-meta-counts">
        <button type="button" className="msg-meta-count" onClick={onWords}>
          {words}
        </button>
        <span className="msg-meta-count">{pagesLabel}</span>
      </span>
    );
  }
  return (
    <>
      <button type="button" className="status-item" onClick={onWords}>
        {words}
      </button>
      <span className="status-item">{pagesLabel}</span>
    </>
  );
}

/**
 * Renders its children with the live editor state. Only this subtree re-renders
 * on a keystroke or selection change, not the whole workspace.
 */
function WithEditorState({ session, children }: { session: DocumentSession; children: (state: EditorState | null) => ReactNode }) {
  const state = useSyncExternalStore(session.editor.subscribe, session.editor.get, session.editor.get);
  return <>{children(state)}</>;
}

function TitleInput({ meta, session, onRename }: { meta: DocumentMeta | null; session: DocumentSession; onRename: (title: string) => void }) {
  const editorState = useSyncExternalStore(session.editor.subscribe, session.editor.get, session.editor.get);
  // The name the user just typed, shown until the server agrees they named the document.
  const [pinned, setPinned] = useState<string | null>(null);
  useEffect(() => {
    if (pinned != null && meta?.autoTitle === false) setPinned(null);
  }, [meta, pinned]);
  // Follow the first line as it is typed. A name the user set stays put, including while that save is still on its way.
  const live = pinned == null && meta?.autoTitle && editorState ? (followedDocumentTitle(editorState.doc) ?? "Untitled document") : null;
  const shown = live ?? pinned ?? meta?.title ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? shown;
  useLayoutEffect(() => {
    if (draft == null && shown) document.title = `${shown} · Inline`;
  }, [draft, shown]);
  return (
    <span className="title-fit">
      {/* Sizes the field to the text. The input paints over it and can shrink when the bar is tight. */}
      <span className="title-sizer" data-value={value || "\u00a0"} aria-hidden="true" />
      <input
        className="title-input"
        aria-label="Document title"
        autoComplete="off"
        value={value}
        onFocus={(event) => {
          setDraft(shown);
          event.target.select();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft?.trim() ? cleanTitle(draft) : "";
          if (next && next !== shown) {
            setPinned(next);
            onRename(next);
          }
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") {
            setDraft(null);
            requestAnimationFrame(() => (event.target as HTMLInputElement).blur());
          }
        }}
      />
    </span>
  );
}

/** The open tab's name, beside the document title, when the document has more than one tab. */
function TabHeading({ title }: { title: string }) {
  return (
    <span className="title-tab">
      <ChevronRight size={15} className="title-tab-sep" aria-hidden="true" />
      <span className="sr-only">Tab </span>
      <span className="title-tab-name">{title}</span>
    </span>
  );
}

/**
 * The session's UI state, except that saving/saved flips don't count as a
 * change: they happen with every burst of typing and would re-render the whole
 * workspace. LiveSyncStatus shows them on its own.
 */
function useWorkspaceUi(session: DocumentSession) {
  const last = useRef<{ full: DocumentUiState; view: DocumentUiState } | null>(null);
  const get = useCallback(() => {
    const full = session.ui.get();
    const previous = last.current;
    if (previous && (previous.full === full || sameButSaving(previous.full, full))) {
      previous.full = full;
      return previous.view;
    }
    last.current = { full, view: full };
    return full;
  }, [session]);
  return useSyncExternalStore(session.ui.subscribe, get, get);
}

function sameButSaving(a: DocumentUiState, b: DocumentUiState) {
  for (const key of Object.keys(b) as Array<keyof DocumentUiState>) {
    if (key === "sync") {
      if ((a.sync === "error") !== (b.sync === "error")) return false;
    } else if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

/** Narrowest the title gets before the title bar folds into its compact layout. */
const MIN_TITLE_WIDTH = 120;
/** Extra room needed to unfold again, so a width near the edge doesn't flip back and forth. */
const UNFOLD_SLACK = 24;

/**
 * Whether the title bar's full layout (title, menus, buttons) is wider than the bar. The full
 * layout's width is measured while it's shown and remembered while the compact one is.
 */
function useCrowdedTitlebar(ref: RefObject<HTMLElement | null>, narrow: boolean, tabTitle: string) {
  const [crowded, setCrowded] = useState(false);
  const fullWidth = useRef(0);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar || narrow) return;
    const check = () => {
      const stack = bar.querySelector<HTMLElement>(".title-stack");
      const menubar = bar.querySelector<HTMLElement>(".menubar");
      const status = bar.querySelector<HTMLElement>(".titlebar-status");
      const sync = status?.firstElementChild as HTMLElement | null | undefined;
      const actions = bar.querySelector<HTMLElement>(".titlebar-actions");
      if (!crowded && stack && menubar && status && sync && actions) {
        // The title shrinks to its text (and no narrower than MIN_TITLE_WIDTH). The tab name stays.
        const padRight = Number.parseFloat(getComputedStyle(bar).paddingRight) || 0;
        const used = actions.getBoundingClientRect().right + padRight - bar.getBoundingClientRect().left;
        const stackGap = Number.parseFloat(getComputedStyle(stack).columnGap) || 0;
        const titleLine = stack.querySelector<HTMLElement>(".title-line");
        const lineGap = titleLine ? Number.parseFloat(getComputedStyle(titleLine).columnGap) || 0 : 0;
        const sizer = stack.querySelector<HTMLElement>(".title-sizer");
        const tab = stack.querySelector<HTMLElement>(".title-tab");
        const badge = stack.querySelector<HTMLElement>(".canvas-kind-badge");
        const natural = (el: HTMLElement) => el.scrollWidth + el.offsetWidth - el.clientWidth;
        const reservedTitle = Math.min(MIN_TITLE_WIDTH, sizer ? natural(sizer) : MIN_TITLE_WIDTH);
        const badgeWidth = badge ? lineGap + natural(badge) : 0;
        const tabWidth = tab ? lineGap + natural(tab) : 0;
        fullWidth.current = used - stack.offsetWidth + reservedTitle + badgeWidth + tabWidth + stackGap + menubar.offsetWidth - (status.clientWidth - sync.offsetWidth);
      }
      const width = bar.clientWidth;
      const next = crowded ? width < fullWidth.current + UNFOLD_SLACK : width < fullWidth.current;
      if (next !== crowded) setCrowded(next);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(bar);
    const stack = bar.querySelector<HTMLElement>(".title-stack");
    if (stack) observer.observe(stack);
    return () => observer.disconnect();
  }, [ref, narrow, crowded, tabTitle]);
  return crowded && !narrow;
}

function LiveSyncStatus({ session, compact }: { session: DocumentSession; compact?: boolean }) {
  const sync = useSyncExternalStore(session.ui.subscribe, () => session.ui.get().sync, () => session.ui.get().sync);
  const connection = useSyncExternalStore(session.ui.subscribe, () => session.ui.get().connection, () => session.ui.get().connection);
  return <SyncStatus sync={sync} connection={connection} compact={compact} />;
}

function SyncStatus({ sync, connection, compact }: { sync: "saved" | "saving" | "error"; connection: "connecting" | "live" | "reconnecting"; compact?: boolean }) {
  // Phones show only the icon; the label stays available to screen readers.
  const label = (text: string) => <span className={compact ? "sr-only" : undefined}>{text}</span>;
  if (connection === "reconnecting" || sync === "error") {
    return (
      <span className="sync-status is-warning" title="Changes are kept locally and will sync when the connection is back.">
        <CloudOff size={13} /> {label("Offline")}
      </span>
    );
  }
  if (sync === "saving") {
    return (
      <span className="sync-status">
        <Loader2 size={13} className="spin" /> {label("Saving…")}
      </span>
    );
  }
  return (
    <span className="sync-status">
      <Check size={13} /> {label("Saved")}
    </span>
  );
}

function WordCountDialog({ open, onClose, session }: { open: boolean; onClose: () => void; session: DocumentSession }) {
  return (
    <Dialog open={open} onClose={onClose} title="Word count" width={420}>
      {open && <WordCountTable session={session} />}
    </Dialog>
  );
}

function WordCountTable({ session }: { session: DocumentSession }) {
  const state = session.view?.state;
  const text = state ? docPlainText(state.doc) : "";
  const selectionText = state && !state.selection.empty ? state.doc.textBetween(state.selection.from, state.selection.to, "\n") : "";
  const stats = (value: string) => ({
    words: wordCount(value),
    characters: value.replace(/\n/g, "").length,
    noSpaces: value.replace(/\s/g, "").length,
  });
  const all = stats(text);
  const selected = selectionText ? stats(selectionText) : null;
  const rows: Array<[string, number, number | undefined]> = [
    ["Words", all.words, selected?.words],
    ["Characters", all.characters, selected?.characters],
    ["Characters without spaces", all.noSpaces, selected?.noSpaces],
    ["Reading time (min)", Math.max(1, Math.round(all.words / 238)), undefined],
  ];
  return (
    <table className="stats-table">
      <thead>
        <tr>
          <th />
          <th>Document</th>
          {selected && <th>Selection</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, value, selection]) => (
          <tr key={label}>
            <td>{label}</td>
            <td>{value.toLocaleString()}</td>
            {selected && <td>{selection?.toLocaleString() ?? ""}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}


