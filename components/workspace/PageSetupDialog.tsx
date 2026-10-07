"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { primaryFamily } from "@/lib/doc/fontMetrics";
import { FontPicker } from "@/components/workspace/FontPicker";
import { DEFAULT_SETTINGS, FONT_FAMILIES, PAPER_SIZES, type DocumentSettings } from "@/lib/doc/settings";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";

type Tab = "page" | "text" | "header";

export function PageSetupDialog({
  open,
  initialTab = "page",
  session,
  settings,
  onClose,
}: {
  open: boolean;
  initialTab?: Tab;
  session: DocumentSession;
  settings: DocumentSettings | undefined;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [draft, setDraft] = useState<DocumentSettings>(settings ?? DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);

  // Start from the saved settings each time the dialog opens; later meta updates
  // (Claude renaming the document, say) must not wipe what the user is editing.
  useEffect(() => {
    if (open) {
      setDraft(settings ?? DEFAULT_SETTINGS);
      setTab(initialTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const page = draft.pageSetup;
  const hf = draft.headerFooter;
  const pn = draft.pageNumbers;
  const set = (patch: Partial<DocumentSettings>) => setDraft((value) => ({ ...value, ...patch }));
  const setPage = (patch: Partial<DocumentSettings["pageSetup"]>) => set({ pageSetup: { ...page, ...patch } });
  const setMargin = (key: keyof DocumentSettings["pageSetup"]["margins"], value: number) => setPage({ margins: { ...page.margins, [key]: value } });
  const setHf = (patch: Partial<DocumentSettings["headerFooter"]>) => set({ headerFooter: { ...hf, ...patch } });
  const setPn = (patch: Partial<DocumentSettings["pageNumbers"]>) => set({ pageNumbers: { ...pn, ...patch } });

  const save = async () => {
    setSaving(true);
    try {
      await session.updateMeta({ settings: draft as unknown as Record<string, unknown> });
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't save page setup.", { tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Document setup"
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={() => setDraft(DEFAULT_SETTINGS)}>
            Reset to defaults
          </Button>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Apply
          </Button>
        </>
      }
    >
      <div className="segmented tabs" role="tablist">
        {(
          [
            ["page", "Page"],
            ["text", "Text"],
            ["header", "Header & footer"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "is-active" : ""} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "page" && (
        <div className="form-grid">
          <label className="field">
            <span>Paper size</span>
            <select className="input" value={page.paperSize} onChange={(event) => setPage({ paperSize: event.target.value as DocumentSettings["pageSetup"]["paperSize"] })}>
              {Object.entries(PAPER_SIZES).map(([key, paper]) => (
                <option key={key} value={key}>
                  {paper.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Orientation</span>
            <select className="input" value={page.orientation} onChange={(event) => setPage({ orientation: event.target.value as "portrait" | "landscape" })}>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
          {(["top", "bottom", "left", "right"] as const).map((key) => (
            <label key={key} className="field">
              <span>{key[0]!.toUpperCase() + key.slice(1)} margin (in)</span>
              <input className="input" type="number" min={0} max={3} step={0.05} value={page.margins[key]} onChange={(event) => setMargin(key, Number(event.target.value))} />
            </label>
          ))}
        </div>
      )}

      {tab === "text" && (
        <div className="form-grid">
          <div className="field span-2">
            <span>Default font</span>
            <FontPicker className="input font-picker-field" label="Default font" value={draft.fontFamily} onPick={(fontFamily) => set({ fontFamily })}>
              <span style={{ fontFamily: draft.fontFamily }}>{FONT_FAMILIES.find((font) => font.value === draft.fontFamily)?.label ?? primaryFamily(draft.fontFamily)}</span>
              <ChevronDown size={14} />
            </FontPicker>
          </div>
          <label className="field">
            <span>Font size (pt)</span>
            <input className="input" type="number" min={6} max={96} step={0.5} value={draft.fontSize} onChange={(event) => set({ fontSize: Number(event.target.value) })} />
          </label>
          <label className="field">
            <span>Line spacing</span>
            <select className="input" value={String(draft.lineSpacing)} onChange={(event) => set({ lineSpacing: Number(event.target.value) })}>
              {["1", "1.15", "1.5", "2", "2.5", "3"].map((value) => (
                <option key={value} value={value}>
                  {value === "1" ? "Single" : value === "2" ? "Double" : value}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Space after paragraphs (pt)</span>
            <input className="input" type="number" min={0} max={72} step={1} value={draft.paragraphSpacing} onChange={(event) => set({ paragraphSpacing: Number(event.target.value) })} />
          </label>
        </div>
      )}

      {tab === "header" && (
        <div className="form-grid">
          <label className="field span-2">
            <span>Header</span>
            <input className="input" value={hf.header} placeholder="e.g. {title}" onChange={(event) => setHf({ header: event.target.value })} />
          </label>
          <label className="field">
            <span>Header alignment</span>
            <AlignSelect value={hf.headerAlign} onChange={(value) => setHf({ headerAlign: value })} />
          </label>
          <span />
          <label className="field span-2">
            <span>Footer</span>
            <input className="input" value={hf.footer} placeholder="e.g. Confidential" onChange={(event) => setHf({ footer: event.target.value })} />
          </label>
          <label className="field">
            <span>Footer alignment</span>
            <AlignSelect value={hf.footerAlign} onChange={(value) => setHf({ footerAlign: value })} />
          </label>
          <span />
          <label className="check span-2">
            <input type="checkbox" checked={hf.differentFirstPage} onChange={(event) => setHf({ differentFirstPage: event.target.checked })} />
            Different first page
          </label>
          {hf.differentFirstPage && (
            <>
              <label className="field">
                <span>First page header</span>
                <input className="input" value={hf.firstHeader} onChange={(event) => setHf({ firstHeader: event.target.value })} />
              </label>
              <label className="field">
                <span>First page footer</span>
                <input className="input" value={hf.firstFooter} onChange={(event) => setHf({ firstFooter: event.target.value })} />
              </label>
            </>
          )}
          <div className="form-divider span-2" />
          <label className="check span-2">
            <input type="checkbox" checked={pn.enabled} onChange={(event) => setPn({ enabled: event.target.checked })} />
            Page numbers
          </label>
          {pn.enabled && (
            <>
              <label className="field">
                <span>Position</span>
                <select className="input" value={pn.position} onChange={(event) => setPn({ position: event.target.value as "header" | "footer" })}>
                  <option value="footer">Footer</option>
                  <option value="header">Header</option>
                </select>
              </label>
              <label className="field">
                <span>Alignment</span>
                <AlignSelect value={pn.align} onChange={(value) => setPn({ align: value })} />
              </label>
              <label className="check span-2">
                <input type="checkbox" checked={pn.skipFirst} onChange={(event) => setPn({ skipFirst: event.target.checked })} />
                Hide the number on the first page
              </label>
            </>
          )}
          <p className="form-help span-2">
            Use <code>{"{page}"}</code>, <code>{"{pages}"}</code>, <code>{"{title}"}</code> and <code>{"{date}"}</code> in headers and footers.
          </p>
        </div>
      )}
    </Dialog>
  );
}

function AlignSelect({ value, onChange }: { value: "left" | "center" | "right"; onChange: (value: "left" | "center" | "right") => void }) {
  return (
    <select className="input" value={value} onChange={(event) => onChange(event.target.value as "left" | "center" | "right")}>
      <option value="left">Left</option>
      <option value="center">Center</option>
      <option value="right">Right</option>
    </select>
  );
}
