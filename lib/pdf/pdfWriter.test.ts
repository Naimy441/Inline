import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildPdf, winAnsiBytes, type PdfDocumentModel } from "./pdfWriter";

const LETTER = { width: 612, height: 792 };

function latin1(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("latin1");
}

function twoPageModel(): PdfDocumentModel {
  return {
    title: "Quarterly – Report",
    pages: [
      {
        ...LETTER,
        items: [
          { kind: "rect", x: 72, y: 72, width: 100, height: 14, fill: [1, 1, 0] },
          { kind: "text", x: 72, y: 84, text: "First page (draft) \\ notes", font: "Helvetica", size: 11, color: [0, 0, 0] },
          { kind: "line", x1: 72, y1: 86, x2: 172, y2: 86, width: 0.7, color: [0, 0, 0] },
          { kind: "link", x: 72, y: 72, width: 100, height: 14, uri: "https://example.com/a(b)" },
        ],
      },
      {
        ...LETTER,
        items: [
          { kind: "text", x: 72, y: 84, text: "Second page", font: "Times-Bold", size: 14, color: [0.2, 0.4, 0.6] },
          { kind: "image", x: 72, y: 120, width: 144, height: 72, jpeg: new Uint8Array([0xff, 0xd8, 0x00, 0x0a, 0xff, 0xd9]), pixelWidth: 2, pixelHeight: 1 },
        ],
      },
    ],
  };
}

describe("buildPdf", () => {
  it("writes a parseable file whose xref offsets point at each object", () => {
    const bytes = buildPdf(twoPageModel());
    const text = latin1(bytes);
    assert.ok(text.startsWith("%PDF-1.4\n"));
    assert.ok(text.trimEnd().endsWith("%%EOF"));

    const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF/)![1]);
    assert.equal(text.slice(startxref, startxref + 4), "xref");

    const [, count] = text.slice(startxref).match(/xref\n0 (\d+)\n/)!;
    const entries = text.slice(startxref).split("\n").slice(3, 2 + Number(count));
    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      assert.equal(text.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`);
    });
    assert.match(text, new RegExp(`/Size ${count} `));
  });

  it("lays out pages with their size, fonts, links and images", () => {
    const text = latin1(buildPdf(twoPageModel()));
    assert.match(text, /\/Type \/Pages \/Kids \[\d+ 0 R \d+ 0 R\] \/Count 2/);
    assert.equal(text.match(/\/MediaBox \[0 0 612 792\]/g)?.length, 2);
    assert.match(text, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/);
    assert.match(text, /\/BaseFont \/Times-Bold /);
    // Top-left y = 84 becomes 792 - 84 in PDF space.
    assert.match(text, /1 0 0 1 72 708 Tm \(First page \\\(draft\\\) \\\\ notes\) Tj/);
    assert.match(text, /0\.2 0\.4 0\.6 rg/);
    assert.match(text, /1 1 0 rg 72 706 100 14 re f/);
    assert.match(text, /\/Subtype \/Link \/Rect \[72 706 172 720\].*\/URI \(https:\/\/example\.com\/a\\\(b\\\)\)/);
    assert.match(text, /\/Subtype \/Image \/Width 2 \/Height 1 .*\/Filter \/DCTDecode \/Length 6 >>/);
    assert.match(text, /q 144 0 0 72 72 600 cm \/Im\d+ Do Q/);
    assert.match(text, /\/Title <FEFF0051007500610072007400650072006C0079002020130020005200650070006F00720074>/);
  });

  it("declares content stream lengths that match the stream bytes", () => {
    const text = latin1(buildPdf(twoPageModel()));
    for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = match.index! + match[0].length;
      assert.equal(text.slice(start + Number(match[1]), start + Number(match[1]) + "\nendstream".length), "\nendstream");
    }
  });

  it("round-trips text page by page through a real PDF reader", (t) => {
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    } catch {
      t.skip("pdftotext is not installed");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "inline-pdf-"));
    const file = join(dir, "doc.pdf");
    const model = twoPageModel();
    model.pages[0].items.push({ kind: "text", x: 72, y: 110, text: "Café “quoted” — €5", font: "Times-Roman", size: 11, color: [0, 0, 0] });
    writeFileSync(file, buildPdf(model));
    const page = (n: number) => execFileSync("pdftotext", ["-f", String(n), "-l", String(n), file, "-"], { encoding: "utf8" });
    assert.match(page(1), /First page \(draft\) \\ notes/);
    assert.match(page(1), /Café “quoted” — €5/);
    assert.doesNotMatch(page(1), /Second page/);
    assert.match(page(2), /Second page/);
  });
});

describe("winAnsiBytes", () => {
  it("maps Latin-1 directly and typographic punctuation into the 0x80 block", () => {
    assert.deepEqual(winAnsiBytes("é"), [0xe9]);
    assert.deepEqual(winAnsiBytes("“”‘’–—•…€™"), [0x93, 0x94, 0x91, 0x92, 0x96, 0x97, 0x95, 0x85, 0x80, 0x99]);
  });

  it("degrades characters outside WinAnsi instead of dropping them", () => {
    assert.deepEqual(winAnsiBytes("→"), [0x2d, 0x3e]);
    assert.deepEqual(winAnsiBytes("ő"), [0x6f]);
    assert.deepEqual(winAnsiBytes("中"), [0x3f]);
    assert.deepEqual(winAnsiBytes("a\u2009b"), [0x61, 0x20, 0x62]);
  });
});
