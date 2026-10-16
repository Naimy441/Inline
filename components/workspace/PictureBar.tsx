"use client";

import { BringToFront, RotateCw, SendToBack, Type, WrapText, type LucideIcon } from "lucide-react";
import { NodeSelection, type EditorState } from "prosemirror-state";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { parseCropToken, pictureCrop, pictureRotate, pictureWrap, type PictureWrap } from "@/lib/doc/picture";
import { setImageAttrs } from "@/lib/editor/commands";

const WRAPS: Array<{ wrap: PictureWrap | null; label: string; icon: LucideIcon }> = [
  { wrap: null, label: "In line with text", icon: Type },
  { wrap: "square", label: "Square", icon: WrapText },
  { wrap: "behind", label: "Behind text", icon: SendToBack },
  { wrap: "front", label: "In front of text", icon: BringToFront },
];

/**
 * Wrap, crop and rotation for the selected picture. Square lets the following
 * text run beside it; behind and in front lay the picture under or over that text.
 */
export function PictureBar({ session, state }: { session: DocumentSession; state: EditorState | null }) {
  const bar = useRef<HTMLDivElement>(null);
  const pressing = useRef(false);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  // The bar must not open under the press that selects the picture, or that
  // press ends on the bar and the picture loses its selection.
  const [open, setOpen] = useState(false);
  const view = session.view;
  const selection = state?.selection;
  const node = selection instanceof NodeSelection ? selection.node : null;
  const picture = node && (node.type.name === "image" || node.type.name === "inline_image") ? node : null;
  const pos = selection instanceof NodeSelection ? selection.from : null;
  // Attrs that move the picture, not the node object (that changes on every untouched transaction).
  const layoutKey = picture
    ? `${pos}:${String(picture.attrs.wrap ?? "")}:${String(picture.attrs.align ?? "")}:${String(picture.attrs.width ?? "")}:${String(picture.attrs.rotate ?? "")}:${picture.attrs.crop ? "1" : ""}`
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
        // A layout pass can report an empty box for a frame. Keep the last position and try again.
        if (tries++ < 8) frame = requestAnimationFrame(place);
        return;
      }
      tries = 0;
      const left = rect.left + rect.width / 2;
      const top = Math.max(8, rect.top - 8);
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

  // The bar is centred on the picture, which sits on the left of the page, so pull it back on screen.
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const edge = 8;
    const shiftX = rect.left < edge ? edge - rect.left : rect.right > window.innerWidth - edge ? window.innerWidth - edge - rect.right : 0;
    const shiftY = rect.top < edge ? edge - rect.top : 0;
    const currentX = Number.parseFloat(element.style.marginLeft) || 0;
    const currentY = Number.parseFloat(element.style.marginTop) || 0;
    if (shiftX) element.style.marginLeft = `${currentX + shiftX}px`;
    if (shiftY) element.style.marginTop = `${currentY + shiftY}px`;
  }, [box]);

  if (!picture || !box || !open || !view?.editable) return null;
  const block = picture.type.name === "image";
  const wrap = pictureWrap(picture.attrs.wrap);
  const crop = pictureCrop(picture.attrs.crop);
  const rotate = pictureRotate(picture.attrs.rotate);
  const percent = (fraction: number) => String(Math.round(fraction * 1000) / 10);

  const applyCrop = () => {
    const root = bar.current;
    if (!root) return;
    const read = (name: string) => root.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value ?? "0";
    const raw = [read("crop-left"), read("crop-top"), read("crop-right"), read("crop-bottom")].join(",");
    const next = parseCropToken(raw);
    const attempted = raw.split(",").some((part) => Number(part) !== 0);
    if (attempted && !next) return;
    if (cropTokenSame(crop, next)) return;
    session.run(setImageAttrs({ crop: next }));
  };

  return (
    <div
      ref={bar}
      className="picture-bar"
      data-keep-photo=""
      style={{ left: box.left, top: box.top }}
      onMouseDown={(event) => {
        // Keep the picture selected, but let a field take the caret.
        if ((event.target as HTMLElement).closest("input")) return;
        event.preventDefault();
      }}
    >
      {block &&
        WRAPS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              aria-label={item.label}
              title={item.label}
              aria-pressed={wrap === item.wrap}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                session.run(setImageAttrs({ wrap: item.wrap }));
              }}
            >
              <Icon size={15} aria-hidden />
            </button>
          );
        })}
      {block && <span className="picture-sep" />}
      <label title="Rotate">
        <RotateCw size={14} aria-hidden />
        <input
          aria-label="Rotate"
          name="rotate"
          type="number"
          step="1"
          value={rotate ?? 0}
          onChange={(event) => {
            const value = event.target.value;
            session.run(setImageAttrs({ rotate: value.trim() === "" ? null : pictureRotate(value) }));
          }}
        />
      </label>
      <span className="picture-sep" />
      {(
        [
          ["crop-left", "Crop from left", "L", crop?.l ?? 0],
          ["crop-top", "Crop from top", "T", crop?.t ?? 0],
          ["crop-right", "Crop from right", "R", crop?.r ?? 0],
          ["crop-bottom", "Crop from bottom", "B", crop?.b ?? 0],
        ] as const
      ).map(([name, label, letter, fraction]) => (
        <label key={name} title={label}>
          {letter}
          <input aria-label={label} name={name} inputMode="decimal" defaultValue={percent(fraction)} key={`${name}-${percent(fraction)}`} onBlur={applyCrop} />
        </label>
      ))}
    </div>
  );
}

function cropTokenSame(current: ReturnType<typeof pictureCrop>, next: ReturnType<typeof pictureCrop>) {
  if (!current && !next) return true;
  if (!current || !next) return false;
  return current.l === next.l && current.t === next.t && current.r === next.r && current.b === next.b;
}
