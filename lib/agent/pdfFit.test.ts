import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { schema } from "@/lib/doc/schema";
import type { LiveDocument } from "@/lib/server/hub";
import type { PageRange } from "@/lib/server/pdfImports";
import { describeFit, pageFit } from "./pdfTools";

const doc = { meta: { settings: { pageSetup: { paperSize: "letter", orientation: "portrait", margins: { top: 0.5, bottom: 0.5, left: 1, right: 1 } } } } } as unknown as LiveDocument;
const paragraph = (id: string, text: string, spaceBefore: number | null = null) => schema.node("paragraph", { id, spaceBefore }, text ? [schema.text(text)] : []);
const range = { page: 1, from: 0, to: 10, nodes: [paragraph("a", "First"), paragraph("b", "Second"), paragraph("c", "a = Set(a)", 6)] } as unknown as PageRange;

describe("how a page's blocks fit", () => {
  it("says where they run on a page they fit on, and how far past the margin the last ends", () => {
    const fit = pageFit(doc, range, { page: 0, png: new Uint8Array(), span: { first: 0, last: 0 }, blocks: [{ id: "a", top: 40, bottom: 400 }, { id: "c", top: 410, bottom: 760 }] })!;
    assert.deepEqual({ count: fit.count, area: fit.area, extent: fit.extent, over: fit.over, past: fit.past }, { count: 1, area: { top: 36, bottom: 756 }, extent: { top: 40, bottom: 760 }, over: null, past: 4 });
    assert.match(describeFit(fit), /ends 4\.0 pt below the bottom margin/);
  });

  it("says how much too tall a page that runs over is, and the first block that didn't fit", () => {
    const fit = pageFit(doc, range, {
      page: 0,
      png: new Uint8Array(),
      span: { first: 0, last: 1 },
      spanBlocks: [
        { page: 0, blocks: [{ id: "a", top: 40, bottom: 400 }, { id: "b", top: 400, bottom: 740 }] },
        { page: 1, blocks: [{ id: "c", top: 36, bottom: 60 }, { id: "next-page", top: 70, bottom: 90 }] },
      ],
    })!;
    // 704 pt on the first page, 24 on the next and the 6 above c: 14 more than the 720 there is.
    assert.deepEqual(fit.over, { points: 14, block: "a = Set(a)" });
    assert.match(describeFit(fit), /about 14 pt too tall .*"a = Set\(a\)"/);
  });
});
