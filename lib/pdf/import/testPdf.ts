/**
 * PDFs written by hand for tests (lib/pdf/import/analyze.test.ts and the
 * browser tests in e2e/pdf-import.spec.ts): each page's content stream as
 * given, Helvetica as the font, and optional annotations.
 */

export function buildTestPdf(pages: Array<{ content: string; annots?: string[] }>, extraFonts: Record<string, string> = {}) {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const stream = (text: string, dict = "") => `<< ${dict} /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`;
  const catalog = add("");
  const pagesId = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const gstate = add("<< /Type /ExtGState /ca 0.35 /CA 0.35 >>");
  // Other fonts by name (not embedded: pdf.js stands one in, keeping the name).
  const extra = Object.entries(extraFonts).map(([key, base]) => `/${key} ${add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 255 /Widths [333 ${Array(223).fill(500).join(" ")}] >>`)} 0 R`).join(" ");
  const kids: number[] = [];
  for (const page of pages) {
    const content = add(stream(page.content));
    const annots = (page.annots ?? []).map((annot) => add(annot));
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R ${extra} >> /ExtGState << /GS1 ${gstate} 0 R >> >>${annots.length ? ` /Annots [${annots.map((id) => `${id} 0 R`).join(" ")}]` : ""} >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}


/** A page of lecture notes (a heading, a paragraph, a boxed question) with a pen stroke drawn over it after its text. */
export function annotatedTestPdf() {
  const content = [
    "BT /F2 16 Tf 72 700 Td (Normal approximation) Tj ET",
    "BT /F1 12 Tf 72 670 Td (Binomial distributions look like bell curves when n is large.) Tj ET",
    "BT /F1 12 Tf 72 654 Td (The normal curve gives a good approximation to them.) Tj ET",
    "BT /F2 12 Tf 76 610 Td (Question:) Tj ET",
    "BT /F1 12 Tf 76 594 Td (What is the probability of more than sixty heads?) Tj ET",
    "0 0 0 RG 0.4 w 70 586 m 540 586 l 540 624 l 70 624 l h S",
    "0 0.44 1 rg 100 500 m 110 520 120 480 130 500 c 140 520 150 480 160 500 c 170 520 180 480 190 500 c 190 503 l 180 483 170 523 160 503 c 150 483 140 523 130 503 c 120 483 110 523 100 503 c h f",
  ].join("\n");
  return buildTestPdf([{ content }]);
}

/**
 * Two pages of made-up course notes set as LaTeX sets them (Computer Modern
 * by name), with what the import has to rebuild: a running header in three
 * parts of two sizes with a rule under it, page numbers, a contents line
 * with a right tab, a section heading, a justified paragraph with inline
 * math and a subscript, numbered items with hanging indents and lettered
 * sub-items, a bullet, a fraction, a framed question under a label, and a
 * displayed equation.
 */
export function featureTestPdf() {
  // Every letter of these fonts is half an em wide and a space a third, as TeX's word space is, so where lines end is known.
  const text = (font: string, size: number, x: number, y: number, value: string) => `BT /${font} ${size} Tf 0 Tw ${x} ${y} Td (${value.replace(/([()\\])/g, "\\$1")}) Tj ET`;
  /** A line set to reach from x to the right margin (540), its spaces stretched as TeX stretches them. */
  const justified = (x: number, y: number, value: string) => {
    const spaces = value.split(" ").length - 1;
    const natural = ((value.length - spaces) * 0.5 + spaces / 3) * 11.96;
    return `BT /R12 11.96 Tf ${(540 - x - natural) / spaces} Tw ${x} ${y} Td (${value}) Tj ET`;
  };
  const header = (page: number) => [
    text("R10", 9.96, 72, 747, "Course 101, Fall Term"),
    text("R12", 11.96, 240, 747, "Week 1: Sample Notes"),
    text("R10", 9.96, 475, 747, "DEPT 100/200"),
    "0 0 0 RG 0.4 w 72 743 m 540 743 l S",
    text("R10", 9.96, 303, 40, String(page)),
  ];
  const page1 = [
    ...header(1),
    text("BX12", 14.35, 72, 700, "1"),
    text("BX12", 14.35, 93.5, 700, "Sample Section"),
    text("R12", 11.96, 72, 676, "Questions"),
    text("R10", 9.96, 535, 676, "1"),
    // A justified paragraph with inline math: X, and T with a lowered A.
    justified(72, 650, "The first line of a justified paragraph runs across to the right"),
    text("R12", 11.96, 72, 636, "margin, and so does the second: let"),
    text("MI12", 11.96, 287, 636, "X"),
    text("R12", 11.96, 297, 636, "be a value and"),
    text("MI12", 11.96, 389, 636, "T"),
    text("MI8", 7.97, 395, 634.2, "A"),
    text("R12", 11.96, 540 - (18 * 0.5 + 5 / 3) * 11.96, 636, "a time, as in the notes"),
    text("R12", 11.96, 72, 622, "above. The last line stops short."),
    // A numbered item with a hanging indent, a lettered part, a bullet.
    text("R12", 11.96, 82, 596, "1."),
    justified(96, 596, "The first item is long enough to run over onto a second"),
    text("R12", 11.96, 96, 582, "line, which starts where its text does."),
    text("R12", 11.96, 106, 562, "(a)"),
    text("R12", 11.96, 128, 562, "A lettered part of the item."),
    "BT /R12 11.96 Tf 96 542 Td (\\225) Tj ET",
    text("R12", 11.96, 108, 542, "A bulleted point."),
    // A fraction: numerator over denominator with a bar, in a line of text.
    text("R12", 11.96, 72, 516, "Find"),
    text("MI12", 11.96, 104, 523, "a"),
    "0 0 0 RG 0.4 w 103 515.5 m 112 515.5 l S",
    text("MI12", 11.96, 104, 506, "b"),
    text("R12", 11.96, 114, 516, "."),
    // A framed question under a label.
    text("BX12", 11.96, 72, 480, "Question:"),
    "0 0 0 RG 0.4 w 72 444 m 540 444 l 540 474 l 72 474 l h S",
    text("R12", 11.96, 76, 463, "What is the chance of more than sixty heads?"),
    text("R12", 11.96, 76, 449, "Explain your answer."),
    // A displayed equation, centered.
    text("BB10", 11.96, 262, 410, "P"),
    text("R12", 11.96, 270, 410, "("),
    text("MI12", 11.96, 276, 410, "X"),
    text("R12", 11.96, 286, 410, "="),
    text("MI12", 11.96, 296, 410, "k"),
    text("R12", 11.96, 304, 410, ") ="),
    text("MI12", 11.96, 334, 410, "p"),
  ];
  const page2 = [...header(2), text("R12", 11.96, 72, 700, "The second page holds one more short paragraph.")];
  return buildTestPdf([{ content: page1.join("\n") }, { content: page2.join("\n") }], { R10: "CMR10", R12: "CMR12", BX12: "CMBX12", MI12: "CMMI12", MI8: "CMMI8", BB10: "MSBM10" });
}
