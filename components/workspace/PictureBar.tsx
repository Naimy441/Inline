"use client";

import { NodeSelection, type EditorState } from "prosemirror-state";
import { useLayoutEffect, useRef, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { parseCropToken, pictureCrop, pictureRotate, pictureWrap, type PictureWrap } from "@/lib/doc/picture";
import { setImageAttrs } from "@/lib/editor/commands";

const WRAPS: Array<{ wrap: PictureWrap | null; label: string }> = [
  { wrap: null, label: "In line with text" },
  { wrap: "square", label: "Square" },
  { wrap: "behind", label: "Behind text" },
  { wrap: "front", label: "In front of text" },
];

/**
 * Wrap, crop and rotation for the selected picture. Square lets the following
 * text run beside it; behind and in front lay the picture under or over that text.
 */
export function PictureBar({ session, state }: { session: DocumentSession; state: EditorState | null }) {
  const bar = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  const view = session.view;
  const selection = state?.selection;
  const node = selection instanceof NodeSelection ? selection.node : null;
  const picture = node && (node.type.name === "image" || node.type.name === "inline_image") ? node : null;
  const pos = selection instanceof NodeSelection ? selection.from : null;

  useLayoutEffect(() => {
    if (!view || pos == null || !picture || !view.editable) {
      setBox(null);
      return;
    }
    const place = () => {
      const dom = view.nodeDOM(pos);
      const element = dom instanceof HTMLElement ? dom : null;
      const frame = element?.querySelector(".image-frame") ?? element;
      const rect = frame?.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setBox(null);
        return;
      }
      setBox({ left: rect.left + rect.width / 2, top: Math.max(8, rect.top - 8) });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [view, pos, picture]);

  if (!picture || !box || !view?.editable) return null;
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
        WRAPS.map((item) => (
          <button
            key={item.label}
            type="button"
            aria-pressed={wrap === item.wrap}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              session.run(setImageAttrs({ wrap: item.wrap }));
            }}
          >
            {item.label}
          </button>
        ))}
      {block && <span className="picture-sep" />}
      <label>
        Rotate
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
          ["crop-left", "Crop from left", crop?.l ?? 0],
          ["crop-top", "Crop from top", crop?.t ?? 0],
          ["crop-right", "Crop from right", crop?.r ?? 0],
          ["crop-bottom", "Crop from bottom", crop?.b ?? 0],
        ] as const
      ).map(([name, label, fraction]) => (
        <label key={name}>
          {label.replace("Crop from ", "")}
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
