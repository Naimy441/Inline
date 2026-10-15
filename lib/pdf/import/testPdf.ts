/**
 * PDFs written by hand for tests (lib/pdf/import/analyze.test.ts and the
 * browser tests in e2e/pdf-import.spec.ts): each page's content stream as
 * given, Helvetica as the font, and optional annotations.
 */

export function buildTestPdf(pages: Array<{ content: string; annots?: string[] }>) {
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
  const kids: number[] = [];
  for (const page of pages) {
    const content = add(stream(page.content));
    const annots = (page.annots ?? []).map((annot) => add(annot));
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> /ExtGState << /GS1 ${gstate} 0 R >> >>${annots.length ? ` /Annots [${annots.map((id) => `${id} 0 R`).join(" ")}]` : ""} >>`,
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
