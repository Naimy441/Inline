"use client";

import { Check, ChevronDown, Image as ImageIcon, X } from "lucide-react";
import { NodeSelection, type EditorState } from "prosemirror-state";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { pictureRotate } from "@/lib/doc/picture";
import { setImageAttrs } from "@/lib/editor/commands";
import { picturePlacement, placePicture, PX_PER_INCH, type PicturePlacement } from "@/lib/editor/pictureEdit";

const PLACEMENTS: Array<{ id: PicturePlacement; label: string }> = [
  { id: "inline", label: "In line" },
  { id: "square", label: "Wrap text" },
  { id: "break", label: "Break text" },
  { id: "behind", label: "Behind text" },
  { id: "front", label: "In front of text" },
];

/**
 * Wrap text and Image options for the selected picture. The old icon row is gone:
 * wrap opens the five-way menu, and image options edits size and rotation.
 */
export function PictureBar({ session, state }: { session: DocumentSession; state: EditorState | null }) {
  const bar = useRef<HTMLDivElement>(null);
  const pressing = useRef(false);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<"wrap" | "options" | null>(null);
  const [section, setSection] = useState(true);
  const [lock, setLock] = useState(true);
  const view = session.view;
  const selection = state?.selection;
  const node = selection instanceof NodeSelection ? selection.node : null;
  const picture = node && (node.type.name === "image" || node.type.name === "inline_image") ? node : null;
  const pos = selection instanceof NodeSelection ? selection.from : null;
  const layoutKey = picture
    ? `${pos}:${picturePlacement(picture)}:${String(picture.attrs.width ?? "")}:${String(picture.attrs.height ?? "")}:${String(picture.attrs.rotate ?? "")}`
    : "";

  useEffect(() => {
    const down = () => {
      pressing.current = true;
    };
    const up = () => {
      pressing.current = false;
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);

  useEffect(() => {
    if (!layoutKey) {
      setOpen(false);
      setMenu(null);
      return;
    }
    if (!pressing.current) {
      setOpen(true);
      return;
    }
    const show = () => setOpen(true);
    window.addEventListener("pointerup", show, { once: true });
    window.addEventListener("pointercancel", show, { once: true });
    return () => {
      window.removeEventListener("pointerup", show);
      window.removeEventListener("pointercancel", show);
    };
  }, [layoutKey]);

  useLayoutEffect(() => {
    if (!view || !layoutKey || !view.editable) {
      setBox(null);
      return;
    }
    const at = Number(layoutKey.split(":")[0]);
    let frame = 0;
    let tries = 0;
    const place = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const dom = view.nodeDOM(at);
      const element = dom instanceof HTMLElement ? dom : null;
      const target = element?.querySelector(".image-frame") ?? element;
      const rect = target?.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        if (tries++ < 8) frame = requestAnimationFrame(place);
        return;
      }
      tries = 0;
      const left = rect.left;
      const top = rect.bottom + 8;
      setBox((current) => (current && Math.abs(current.left - left) < 0.5 && Math.abs(current.top - top) < 0.5 ? current : { left, top }));
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [view, layoutKey]);

  useLayoutEffect(() => {
    const element = bar.current;
    if (!element || !box) return;
    const rect = element.getBoundingClientRect();
    const edge = 8;
    const shiftX = rect.left < edge ? edge - rect.left : rect.right > window.innerWidth - edge ? window.innerWidth - edge - rect.right : 0;
    const shiftY = rect.bottom > window.innerHeight - edge ? window.innerHeight - edge - rect.bottom : rect.top < edge ? edge - rect.top : 0;
    element.style.marginLeft = shiftX ? `${shiftX}px` : "";
    element.style.marginTop = shiftY ? `${shiftY}px` : "";
  }, [box, menu]);

  if (!picture || !box || !open || !view?.editable || pos == null) return null;
  const placement = picturePlacement(picture) ?? "break";
  const measured = measurePicture(view, pos, picture);

  const applyBox = (widthPx: number, heightPx: number) => {
    const width = Math.max(1, Math.round(widthPx));
    const height = Math.max(1, Math.round(heightPx));
    session.run(setImageAttrs({ width, height }));
  };

  const applyWidth = (inches: number) => {
    const widthPx = inches * PX_PER_INCH;
    const ratio = measured.naturalW > 0 ? measured.naturalH / measured.naturalW : measured.heightPx / Math.max(1, measured.widthPx);
    applyBox(widthPx, lock ? widthPx * ratio : measured.heightPx);
  };
  const applyHeight = (inches: number) => {
    const heightPx = inches * PX_PER_INCH;
    const ratio = measured.naturalH > 0 ? measured.naturalW / measured.naturalH : measured.widthPx / Math.max(1, measured.heightPx);
    applyBox(lock ? heightPx * ratio : measured.widthPx, heightPx);
  };
  const applyWidthScale = (percent: number) => {
    const widthPx = (measured.naturalW * percent) / 100;
    const heightPx = lock ? (measured.naturalH * percent) / 100 : measured.heightPx;
    applyBox(widthPx, heightPx);
  };
  const applyHeightScale = (percent: number) => {
    const heightPx = (measured.naturalH * percent) / 100;
    const widthPx = lock ? (measured.naturalW * percent) / 100 : measured.widthPx;
    applyBox(widthPx, heightPx);
  };

  const menuTop = box.top + 40;
  const menuLeft = box.left;

  return (
    <>
      <div
        ref={bar}
        className="picture-bar"
        data-keep-photo=""
        style={{ left: box.left, top: box.top }}
        onMouseDown={(event) => {
          if ((event.target as HTMLElement).closest("input")) return;
          event.preventDefault();
        }}
      >
        <button
          type="button"
          aria-label="Wrap text"
          aria-expanded={menu === "wrap"}
          title="Wrap text"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setMenu((current) => (current === "wrap" ? null : "wrap"));
          }}
        >
          <WrapGlyph kind={placement} />
          <ChevronDown size={14} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Image options"
          aria-expanded={menu === "options"}
          title="Image options"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setMenu((current) => (current === "options" ? null : "options"));
            setSection(true);
          }}
        >
          <ImageIcon size={16} aria-hidden />
        </button>
      </div>
      {menu === "wrap" && (
        <div className="picture-menu" data-keep-photo="" role="menu" aria-label="Wrap text" style={{ left: menuLeft, top: menuTop }} onMouseDown={(event) => event.preventDefault()}>
          {PLACEMENTS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={placement === item.id}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                session.run((editorState, dispatch) => {
                  const tr = placePicture(editorState, item.id);
                  if (!tr) return false;
                  dispatch?.(tr.scrollIntoView());
                  return true;
                });
                setMenu(null);
              }}
            >
              <WrapGlyph kind={item.id} />
              <span>{item.label}</span>
              {placement === item.id ? <Check className="picture-check" size={16} aria-hidden /> : <span className="picture-check" />}
            </button>
          ))}
        </div>
      )}
      {menu === "options" && (
        <div className="picture-options" data-keep-photo="" role="dialog" aria-label="Image options" style={{ left: Math.min(menuLeft, window.innerWidth - 336), top: menuTop }}>
          <div className="picture-options-head">
            <span className="picture-options-title">
              <ImageIcon size={18} aria-hidden />
              Image options
            </span>
            <button type="button" aria-label="Close" onMouseDown={(event) => event.preventDefault()} onClick={() => setMenu(null)}>
              <X size={18} aria-hidden />
            </button>
          </div>
          <button type="button" className="picture-options-section" aria-expanded={section} onMouseDown={(event) => event.preventDefault()} onClick={() => setSection((current) => !current)}>
            <ChevronDown size={16} aria-hidden style={{ transform: section ? undefined : "rotate(-90deg)" }} />
            Size & rotation
          </button>
          {section && (
            <div className="picture-options-card">
              <h3>Size</h3>
              <div className="picture-size-grid">
                <StepField label="Width" value={measured.widthPx / PX_PER_INCH} unit="in" step={0.1} digits={2} onChange={applyWidth} />
                <StepField label="Height" value={measured.heightPx / PX_PER_INCH} unit="in" step={0.1} digits={2} onChange={applyHeight} />
                <StepField label="Width scale" value={scaleOf(measured.widthPx, measured.naturalW)} unit="%" step={1} digits={0} onChange={applyWidthScale} />
                <StepField label="Height scale" value={scaleOf(measured.heightPx, measured.naturalH)} unit="%" step={1} digits={0} onChange={applyHeightScale} />
              </div>
              <label className="picture-lock">
                <input
                  type="checkbox"
                  checked={lock}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setLock(next);
                    if (next && measured.naturalW > 0) applyBox(measured.widthPx, measured.widthPx * (measured.naturalH / measured.naturalW));
                  }}
                />
                Lock aspect ratio
              </label>
              <h3 style={{ marginTop: 16 }}>Rotate</h3>
              <div className="picture-rotate-row">
                <StepField
                  label="Angle"
                  value={pictureRotate(picture.attrs.rotate) ?? 0}
                  unit="°"
                  step={1}
                  digits={0}
                  onChange={(degrees) => session.run(setImageAttrs({ rotate: pictureRotate(degrees) }))}
                />
                <div className="picture-angle-tools">
                  <span>90°</span>
                  <button
                    type="button"
                    className="picture-turn"
                    aria-label="Rotate 90 degrees"
                    title="Rotate 90°"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      session.run(setImageAttrs({ rotate: pictureRotate((pictureRotate(picture.attrs.rotate) ?? 0) + 90) }));
                    }}
                  >
                    <TurnIcon />
                  </button>
                  <button
                    type="button"
                    className="picture-reset"
                    aria-label="Reset size and rotation"
                    title="Reset"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setLock(true);
                      session.run(setImageAttrs({ width: measured.naturalW || null, height: measured.naturalH || null, rotate: null }));
                    }}
                  >
                    <ResetIcon />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function scaleOf(shown: number, natural: number) {
  if (!(natural > 0) || !(shown > 0)) return 100;
  return (shown / natural) * 100;
}

function measurePicture(view: NonNullable<DocumentSession["view"]>, pos: number, node: { attrs: Record<string, unknown> }) {
  const dom = view.nodeDOM(pos);
  const element = dom instanceof HTMLElement ? dom : null;
  const frame = (element?.querySelector(".image-frame") ?? element) as HTMLElement | null;
  const img = element?.querySelector("img") as HTMLImageElement | null;
  const widthPx = frame && frame.offsetWidth > 0 ? frame.offsetWidth : numberOf(node.attrs.width) || img?.naturalWidth || 0;
  const heightPx = frame && frame.offsetHeight > 0 ? frame.offsetHeight : numberOf(node.attrs.height) || img?.naturalHeight || 0;
  return {
    widthPx,
    heightPx,
    naturalW: img?.naturalWidth || widthPx,
    naturalH: img?.naturalHeight || heightPx,
  };
}

function numberOf(value: unknown) {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function StepField({ label, value, unit, step, digits, onChange }: { label: string; value: number; unit: string; step: number; digits: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (digits ? value.toFixed(digits) : String(Math.round(value)));
  const commit = (raw: string) => {
    const next = Number(raw);
    if (Number.isFinite(next)) onChange(next);
  };
  return (
    <label className="picture-field">
      {label}
      <span className="picture-step">
        <input
          aria-label={label}
          inputMode="decimal"
          value={shown}
          onFocus={() => setDraft(digits ? value.toFixed(digits) : String(Math.round(value)))}
          onChange={(event) => {
            setDraft(event.target.value);
            commit(event.target.value);
          }}
          onBlur={() => setDraft(null)}
        />
        <span className="picture-unit">{unit}</span>
        <span className="picture-spins">
          <button
            type="button"
            aria-label={`Increase ${label}`}
            onMouseDown={(event) => {
              event.preventDefault();
              onChange(value + step);
            }}
          >
            <Chevron size={10} />
          </button>
          <button
            type="button"
            aria-label={`Decrease ${label}`}
            onMouseDown={(event) => {
              event.preventDefault();
              onChange(value - step);
            }}
          >
            <Chevron size={10} down />
          </button>
        </span>
      </span>
    </label>
  );
}

function Chevron({ size, down }: { size: number; down?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden style={{ transform: down ? "rotate(180deg)" : undefined }}>
      <path d="M2.5 7.5 6 4l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function WrapGlyph({ kind }: { kind?: PicturePlacement }) {
  const box = kind === "behind" ? "#c4c7c5" : "currentColor";
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      {kind === "inline" || !kind ? (
        <>
          <rect x="1.5" y="3" width="6" height="5" rx="0.6" fill="none" stroke={box} strokeWidth="1.3" />
          <path d="M9.5 4.2h7M1.5 11h15M1.5 14.2h15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </>
      ) : null}
      {kind === "square" ? (
        <>
          <rect x="1.5" y="3" width="6.5" height="8" rx="0.6" fill="none" stroke={box} strokeWidth="1.3" />
          <path d="M10 4.2h6.5M10 7.4h6.5M10 10.6h6.5M1.5 14.2h15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </>
      ) : null}
      {kind === "break" ? (
        <>
          <path d="M1.5 3.2h15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <rect x="5" y="5.5" width="8" height="6" rx="0.6" fill="none" stroke={box} strokeWidth="1.3" />
          <path d="M1.5 14.6h15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </>
      ) : null}
      {kind === "behind" ? (
        <>
          <rect x="4" y="4" width="10" height="8" rx="0.6" fill="none" stroke={box} strokeWidth="1.3" />
          <path d="M1.5 7.2h15M1.5 10.6h15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : null}
      {kind === "front" ? (
        <>
          <path d="M1.5 6.2h15M1.5 11.6h15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <rect x="4.5" y="4" width="9" height="8" rx="0.6" fill="var(--surface, #fff)" stroke={box} strokeWidth="1.3" />
        </>
      ) : null}
    </svg>
  );
}

function TurnIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M14 8.5A5.5 5.5 0 1 1 9.2 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M9 1.2 12.2 3.4 9.4 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="6.2" y="7.2" width="5.2" height="4.2" rx="0.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M4 9a5 5 0 1 0 1.4-3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M4 3.2v3.2h3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
