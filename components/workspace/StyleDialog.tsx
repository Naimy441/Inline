"use client";

import { useEffect, useRef, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { currentStyleId, replaceStyleUses } from "@/lib/editor/commands";
import { FONT_FAMILIES, type DocumentSettings } from "@/lib/doc/settings";
import {
  activeTheme,
  dropStyle,
  findStyle,
  isBuiltinStyle,
  newStyleId,
  resolveStyle,
  styleIdFromName,
  resolvedColorHex,
  resolvedFontFamily,
  stylesOf,
  stylesToStore,
  wouldCycle,
  type ColorRef,
  type FontRef,
  type ParagraphStyle,
  type ThemeColor,
} from "@/lib/doc/styles";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";

const THEME_COLORS: Array<{ value: ThemeColor; label: string }> = [
  { value: "text", label: "Theme text" },
  { value: "accent1", label: "Accent 1" },
  { value: "accent2", label: "Accent 2" },
  { value: "accent3", label: "Accent 3" },
  { value: "accent4", label: "Accent 4" },
  { value: "accent5", label: "Accent 5" },
  { value: "accent6", label: "Accent 6" },
];

function fontValue(font: FontRef | null) {
  if (!font) return "";
  return "theme" in font ? `theme:${font.theme}` : font.family;
}

function fontFrom(value: string): FontRef | null {
  if (value === "theme:body" || value === "theme:heading") return { theme: value.slice(6) as "body" | "heading" };
  if (!value) return null;
  return { family: value };
}

function colorValue(color: ColorRef | null) {
  if (!color) return "";
  return "theme" in color ? `theme:${color.theme}` : "hex";
}

function colorFrom(value: string, hex: string): ColorRef | null {
  if (!value) return null;
  if (value.startsWith("theme:")) return { theme: value.slice(6) as ThemeColor };
  return /^#[0-9a-f]{6}$/i.test(hex) ? { hex: hex.toLowerCase() } : null;
}

const blank = (id: string, basedOn: string, next: string): ParagraphStyle => ({
  id,
  name: "New style",
  basedOn,
  next,
  font: null,
  size: null,
  spaceBefore: null,
  spaceAfter: null,
  lineHeight: null,
  color: null,
  italic: null,
});

/**
 * Create or change a named paragraph style. Saving writes the stylesheet;
 * every paragraph that uses the style, and every style based on it, picks
 * the new definition up from there.
 */
export function StyleDialog({
  open,
  styleId,
  session,
  settings,
  onClose,
}: {
  open: boolean;
  /** Null starts a new style. */
  styleId: string | null;
  session: DocumentSession;
  settings: DocumentSettings | undefined;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ParagraphStyle>(() => blank("Snew", "Normal", "Normal"));
  const [hex, setHex] = useState("#202124");
  const [saving, setSaving] = useState(false);
  const creating = !styleId;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Start from the saved style when the dialog opens. Later saves (the document
  // autosaving, or this dialog itself) must not wipe what is being typed.
  useEffect(() => {
    if (!open) return;
    const currentSettings = settingsRef.current;
    if (!currentSettings) return;
    const sheet = stylesOf(currentSettings);
    if (styleId) {
      const found = findStyle(sheet, styleId);
      if (found) {
        setDraft({ ...found });
        if (found.color && "hex" in found.color) setHex(found.color.hex);
      }
      return;
    }
    const current = session.view ? currentStyleId(session.view.state) : null;
    const base = current && findStyle(sheet, current) ? current : "Normal";
    setDraft(blank(newStyleId(), base, resolveStyle(sheet, base)?.next ?? "Normal"));
    setHex("#202124");
  }, [open, styleId, session]);

  if (!settings) return null;
  const sheet = stylesOf(settings);
  const theme = activeTheme(settings);
  const resolved = resolveStyle([...sheet.filter((item) => item.id !== draft.id), draft], draft.id);
  const preview = resolved
    ? {
        fontFamily: resolvedFontFamily(resolved.font, theme) ?? undefined,
        color: resolvedColorHex(resolved.color, theme) ?? undefined,
        fontStyle: resolved.italic ? ("italic" as const) : undefined,
        fontSize: `${Math.min(resolved.size ?? settings.fontSize, 28)}pt`,
        lineHeight: resolved.lineHeight ?? undefined,
      }
    : undefined;
  const set = (patch: Partial<ParagraphStyle>) => setDraft((value) => ({ ...value, ...patch }));
  const number = (key: "size" | "spaceBefore" | "spaceAfter" | "lineHeight", min: number, max: number) => (raw: string) => {
    if (!raw.trim()) {
      set({ [key]: null });
      return;
    }
    const n = Number(raw);
    if (Number.isFinite(n)) set({ [key]: Math.min(max, Math.max(min, Math.round(n * 100) / 100)) });
  };

  const save = async () => {
    const name = draft.name.trim();
    if (!name) {
      toast("Give the style a name.", { tone: "error" });
      return;
    }
    const taken = new Set(sheet.map((item) => item.id));
    const id = creating ? (styleIdFromName(name, taken) ?? draft.id) : draft.id;
    const next = [...sheet.filter((item) => item.id !== draft.id && item.id !== id), { ...draft, id, name }];
    if (wouldCycle(next, draft.id, draft.basedOn)) {
      toast("A style can't be based on itself.", { tone: "error" });
      return;
    }
    setSaving(true);
    try {
      const stored = stylesToStore(next);
      await session.updateMeta({ settings: { ...settings, styles: stored ?? null } as unknown as Record<string, unknown> });
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't save the style.", { tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (isBuiltinStyle(draft.id)) return;
    const fallback = draft.basedOn ?? "Normal";
    session.run(replaceStyleUses(draft.id, fallback, sheet));
    setSaving(true);
    try {
      const stored = stylesToStore(dropStyle(sheet, draft.id));
      await session.updateMeta({ settings: { ...settings, styles: stored ?? null } as unknown as Record<string, unknown> });
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't delete the style.", { tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={creating ? "New style" : "Modify style"}
      description="A style is shared. Changing it updates every paragraph that uses it, and every style based on it. Formatting you set on one paragraph stays on that paragraph."
      width={520}
      footer={
        <>
          {!creating && !isBuiltinStyle(draft.id) && (
            <Button variant="ghost" disabled={saving} onClick={() => void remove()}>
              Delete
            </Button>
          )}
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field span-2">
          Name
          <input className="input" autoFocus value={draft.name} onChange={(event) => set({ name: event.target.value })} />
        </label>
        <label className="field">
          Based on
          <select className="input" value={draft.basedOn ?? ""} onChange={(event) => set({ basedOn: event.target.value || null })}>
            <option value="">None</option>
            {sheet
              .filter((item) => item.id !== draft.id)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          Next paragraph
          <select className="input" value={draft.next ?? ""} onChange={(event) => set({ next: event.target.value || null })}>
            {sheet.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Font
          <select className="input" value={fontValue(draft.font)} onChange={(event) => set({ font: fontFrom(event.target.value) })}>
            <option value="">Inherit</option>
            <option value="theme:body">Theme body</option>
            <option value="theme:heading">Theme heading</option>
            {FONT_FAMILIES.map((font) => (
              <option key={font.value} value={font.value}>
                {font.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Size
          <input className="input" inputMode="decimal" placeholder="Inherit" aria-label="Size" value={draft.size ?? ""} onChange={(event) => number("size", 1, 96)(event.target.value)} />
        </label>
        <label className="field">
          Space before
          <input className="input" inputMode="decimal" placeholder="Inherit" value={draft.spaceBefore ?? ""} onChange={(event) => number("spaceBefore", 0, 200)(event.target.value)} />
        </label>
        <label className="field">
          Space after
          <input className="input" inputMode="decimal" placeholder="Inherit" value={draft.spaceAfter ?? ""} onChange={(event) => number("spaceAfter", 0, 200)(event.target.value)} />
        </label>
        <label className="field">
          Line spacing
          <input className="input" inputMode="decimal" placeholder="Inherit" value={draft.lineHeight ?? ""} onChange={(event) => number("lineHeight", 0.8, 4)(event.target.value)} />
        </label>
        <label className="field">
          Italic
          <select className="input" value={draft.italic == null ? "" : draft.italic ? "yes" : "no"} onChange={(event) => set({ italic: event.target.value === "" ? null : event.target.value === "yes" })}>
            <option value="">Inherit</option>
            <option value="yes">Italic</option>
            <option value="no">Roman</option>
          </select>
        </label>
        <label className="field">
          Color
          <select className="input" value={colorValue(draft.color)} onChange={(event) => set({ color: colorFrom(event.target.value, hex) })}>
            <option value="">Inherit</option>
            {THEME_COLORS.map((color) => (
              <option key={color.value} value={`theme:${color.value}`}>
                {color.label}
              </option>
            ))}
            <option value="hex">Custom</option>
          </select>
        </label>
        {draft.color && "hex" in draft.color && (
          <label className="field">
            Custom color
            <input className="input" type="color" value={hex} onChange={(event) => { setHex(event.target.value); set({ color: { hex: event.target.value } }); }} />
          </label>
        )}
        <div className="span-2" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", background: theme.colors.background }}>
          <div style={preview}>The quick brown fox jumps over the lazy dog.</div>
        </div>
      </div>
    </Dialog>
  );
}
