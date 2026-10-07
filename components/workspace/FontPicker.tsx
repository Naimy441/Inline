"use client";

import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "@/components/ui/Popover";
import { ensureFonts, googleFonts, previewFamily, previewFont } from "@/lib/client/fonts";
import { primaryFamily } from "@/lib/doc/fontMetrics";
import { FONT_FAMILIES, googleFontValue, type GoogleFont } from "@/lib/doc/settings";

type Option = { label: string; value: string; google: boolean };

/** Rows drawn at a time; scrolling near the end of the list draws the next batch. */
const PAGE_ROWS = 100;

const STANDARD: Option[] = FONT_FAMILIES.map((font) => ({ label: font.label, value: font.value, google: false }));

/**
 * A font menu with a search box: the standard fonts, then every Google Fonts
 * family (lib/client/fonts.ts), each shown in its own face. A Google font is
 * fetched and kept the first time it is picked.
 */
export function FontPicker({ value, onPick, className, label, children }: { value: string; onPick: (value: string) => void; className: string; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tip={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
      >
        {children}
      </button>
      <Popover open={open} onClose={close} anchor={anchor} className="font-picker" role="dialog">
        {open && (
          <FontList
            value={value}
            onPick={(next) => {
              setOpen(false);
              onPick(next);
              void ensureFonts([next]);
            }}
          />
        )}
      </Popover>
    </>
  );
}

function FontList({ value, onPick }: { value: string; onPick: (value: string) => void }) {
  const [query, setQuery] = useState("");
  const [google, setGoogle] = useState<GoogleFont[] | null>(null);
  const [active, setActive] = useState(0);
  const [shown, setShown] = useState(PAGE_ROWS);
  const list = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const current = primaryFamily(value).toLowerCase();

  // The popover is hidden until it is placed, and a hidden input can't take focus (so not autoFocus).
  useEffect(() => {
    const frame = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let live = true;
    void googleFonts().then((fonts) => live && setGoogle(fonts));
    return () => {
      live = false;
    };
  }, []);

  const { options, start } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const standardNames = new Set(STANDARD.map((option) => primaryFamily(option.value).toLowerCase()));
    const googleOptions = (google ?? []).filter((font) => !standardNames.has(font.family.toLowerCase())).map<Option>((font) => ({ label: font.family, value: googleFontValue(font), google: true }));
    const matches = (option: Option) => !needle || option.label.toLowerCase().includes(needle);
    // The name itself, then names that start with the search, then names that only contain it.
    const rank = (option: Option) => {
      const name = option.label.toLowerCase();
      return name === needle ? 0 : name.startsWith(needle) ? 1 : 2;
    };
    const standard = STANDARD.filter(matches);
    const found = googleOptions.filter(matches).sort((a, b) => rank(a) - rank(b));
    const options = [...standard, ...found];
    // The arrow keys start from the current font, or from the best match once there's a search.
    const start = needle ? 0 : Math.max(0, options.findIndex((option) => primaryFamily(option.value).toLowerCase() === current));
    return { options, start };
  }, [google, query, current]);

  useEffect(() => {
    setActive(start);
    setShown(Math.max(PAGE_ROWS, start + PAGE_ROWS / 2));
  }, [options, start]);

  // The arrow keys can walk past the drawn rows.
  useEffect(() => setShown((count) => (active >= count - 10 ? active + PAGE_ROWS : count)), [active]);

  const rows = useMemo(() => options.slice(0, shown), [options, shown]);

  useEffect(() => {
    const root = list.current;
    const target = end.current;
    if (!root || !target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setShown((count) => count + PAGE_ROWS), { root, rootMargin: "400px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [rows]);

  // Each Google family's name is drawn in its own face once its row scrolls into view.
  useEffect(() => {
    const root = list.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const family = (entry.target as HTMLElement).dataset.preview;
          if (family) previewFont(family);
          observer.unobserve(entry.target);
        }
      },
      { root, rootMargin: "120px 0px" },
    );
    root.querySelectorAll("[data-preview]").forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [rows]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const firstGoogle = rows.findIndex((row) => row.google);
  return (
    <div className="font-picker-body">
      <input
        className="input font-picker-search"
        placeholder="Search fonts"
        aria-label="Search fonts"
        autoComplete="off"
        spellCheck={false}
        ref={search}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((index) => (options.length ? (index + step + options.length) % options.length : 0));
          } else if (event.key === "Enter" && rows[active]) {
            event.preventDefault();
            onPick(rows[active]!.value);
          }
        }}
      />
      <div ref={list} className="font-picker-list" role="listbox" aria-label="Fonts">
        {rows.map((row, index) => (
          <div key={row.value} role="presentation">
            {index === firstGoogle && <div className="menu-label">Google Fonts</div>}
            <button
              type="button"
              role="option"
              aria-selected={primaryFamily(row.value).toLowerCase() === current}
              data-index={index}
              data-preview={row.google ? row.label : undefined}
              className={`menu-item font-picker-item${index === active ? " is-active" : ""}`}
              style={{ fontFamily: row.google ? `"${previewFamily(row.label)}", ${row.value}` : row.value }}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActive(index)}
              onClick={() => onPick(row.value)}
            >
              <span className="menu-icon">{primaryFamily(row.value).toLowerCase() === current && <Check size={14} />}</span>
              <span className="font-picker-name">{row.label}</span>
            </button>
          </div>
        ))}
        {google === null && (
          <div className="font-picker-note">
            <Loader2 size={13} className="spin" /> Loading Google Fonts…
          </div>
        )}
        {google !== null && !google.length && <div className="font-picker-note">Google Fonts can&apos;t be reached right now.</div>}
        {rows.length < options.length && <div ref={end} className="font-picker-note" aria-hidden />}
        {google !== null && !rows.length && <div className="font-picker-note">No fonts match “{query.trim()}”.</div>}
      </div>
    </div>
  );
}
