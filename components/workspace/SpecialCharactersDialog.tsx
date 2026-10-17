"use client";

import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { formatCodePoint, loadSpecialCharacters, type CharacterCatalog, type CharacterSource } from "@/lib/editor/specialCharacters";

const ROW = 56;
const GAP = 4;
const STRIDE = ROW + GAP;
const OVERSCAN = 4;
const ALL_BLOCKS = "*";

function countLabel(count: number) {
  return count.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function VirtualGrid({
  catalog,
  source,
  resetKey,
  onInsert,
  onActive,
}: {
  catalog: CharacterCatalog;
  source: CharacterSource;
  resetKey: string;
  onInsert: (char: string) => void;
  onActive: (cp: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(360);
  const [columns, setColumns] = useState(8);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const nextHeight = el.clientHeight || 360;
      const nextColumns = Math.max(4, Math.min(12, Math.floor((el.clientWidth + GAP) / (78 + GAP))));
      setHeight((current) => (current === nextHeight ? current : nextHeight));
      setColumns((current) => (current === nextColumns ? current : nextColumns));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey]);

  const rowCount = source.count === 0 ? 0 : Math.ceil(source.count / columns);
  const totalHeight = rowCount === 0 ? 0 : rowCount * STRIDE - GAP;
  const startRow = Math.max(0, Math.floor(scrollTop / STRIDE) - OVERSCAN);
  const endRow = Math.min(rowCount, Math.ceil((scrollTop + height) / STRIDE) + OVERSCAN);
  const rows = [];
  for (let row = startRow; row < endRow; row += 1) {
    const cells = [];
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      if (index >= source.count) break;
      const cp = source.at(index);
      const code = formatCodePoint(cp);
      const label = `${catalog.characterName(cp)}, ${code}`;
      cells.push(
        <button
          key={cp}
          type="button"
          className="charmap-cell"
          title={label}
          aria-label={label}
          onMouseEnter={() => onActive(cp)}
          onFocus={() => onActive(cp)}
          onClick={() => onInsert(String.fromCodePoint(cp))}
        >
          <span className="charmap-glyph">{catalog.glyphFor(cp)}</span>
          <span className="charmap-code">{code}</span>
        </button>,
      );
    }
    rows.push(
      <div key={row} className="charmap-row" style={{ top: row * STRIDE }}>
        {cells}
      </div>,
    );
  }

  return (
    <div className="charmap" ref={scroller} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} style={{ "--charmap-columns": String(columns) } as CSSProperties}>
      <div className="charmap-canvas" style={{ height: totalHeight }}>
        {rows}
      </div>
    </div>
  );
}

export function SpecialCharactersDialog({ open, onClose, onInsert }: { open: boolean; onClose: () => void; onInsert: (char: string) => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("Symbol");
  const [block, setBlock] = useState("Arrows");
  const [catalog, setCatalog] = useState<CharacterCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    if (!open || catalog) return;
    let cancelled = false;
    loadSpecialCharacters().then(
      (loaded) => {
        if (!cancelled) setCatalog(loaded);
      },
      () => {
        if (!cancelled) setError("The character catalog did not load.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, catalog]);

  const current = catalog?.categories.find((item) => item.name === category) ?? catalog?.categories[0] ?? null;
  const source = useMemo(() => {
    if (!catalog || !current) return null;
    const q = deferredQuery.trim();
    if (q) return catalog.searchCharacters(q);
    if (block === ALL_BLOCKS) return current.source;
    return current.blocks.find((item) => item.name === block)?.source ?? current.blocks[0]?.source ?? null;
  }, [catalog, current, block, deferredQuery]);

  const resetKey = `${category}\0${block}\0${deferredQuery.trim()}`;
  useEffect(() => {
    if (!source || source.count === 0) setActive(null);
    else setActive(source.at(0));
  }, [source, resetKey]);

  if (!open) return null;
  const activeName = catalog && active != null ? catalog.characterName(active) : "";
  const meta = source
    ? deferredQuery.trim()
      ? `${countLabel(source.count)} ${source.count === 1 ? "match" : "matches"}`
      : `${block === ALL_BLOCKS ? current?.name : block} · ${countLabel(source.count)}`
    : "";

  return (
    <Dialog open={open} onClose={onClose} title="Special characters" width={760} description={catalog ? `Unicode ${catalog.version} · ${countLabel(catalog.count)} assigned characters` : error ? error : "Loading the Unicode catalog…"}>
      <div className="charmap-tools">
        <input
          className="input"
          placeholder="Search by name or code point"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Search characters"
        />
        {catalog && current && (
          <div className="charmap-filters">
            <select
              className="input"
              aria-label="Character category"
              value={current.name}
              onChange={(event) => {
                const next = event.target.value;
                const info = catalog.categories.find((item) => item.name === next);
                setCategory(next);
                setBlock(next === "Symbol" && info?.blocks.some((item) => item.name === "Arrows") ? "Arrows" : (info?.blocks[0]?.name ?? ALL_BLOCKS));
                setQuery("");
              }}
            >
              {catalog.categories.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
            <select
              className="input"
              aria-label="Character block"
              value={current.blocks.some((item) => item.name === block) || block === ALL_BLOCKS ? block : (current.blocks[0]?.name ?? ALL_BLOCKS)}
              onChange={(event) => {
                setBlock(event.target.value);
                setQuery("");
              }}
            >
              <option value={ALL_BLOCKS}>All blocks</option>
              {current.blocks.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="charmap-preview" aria-live="polite">
        {catalog && active != null ? (
          <>
            <span className="charmap-preview-glyph">{catalog.glyphFor(active)}</span>
            <span className="charmap-preview-name">{activeName}</span>
            <span className="charmap-preview-code">{formatCodePoint(active)}</span>
          </>
        ) : (
          <span className="muted">{error ?? (catalog ? "No character selected." : "Loading characters…")}</span>
        )}
      </div>
      {meta && <p className="charmap-meta">{meta}</p>}
      {catalog && source && source.count === 0 && <p className="muted charmap-empty">No characters match “{deferredQuery.trim()}”.</p>}
      {catalog && source && source.count > 0 && <VirtualGrid catalog={catalog} source={source} resetKey={resetKey} onInsert={onInsert} onActive={setActive} />}
    </Dialog>
  );
}
