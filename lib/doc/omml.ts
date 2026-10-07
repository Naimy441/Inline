import katex from "katex";

/**
 * LaTeX to Office Math (OMML), so equations in a .docx export are real Word
 * equations. KaTeX turns the LaTeX into MathML; the MathML elements KaTeX
 * produces map onto OMML's (fractions, scripts, radicals, accents, matrices).
 */

type MathNode = { tag: string; attrs: Record<string, string>; children: MathNode[]; text: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string) {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, name: string) =>
    name[0] === "#" ? String.fromCodePoint(name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : (ENTITIES[name] ?? whole),
  );
}

/** A minimal parser for KaTeX's MathML, which is well-formed and has no comments or CDATA. */
function parseMathml(source: string): MathNode | null {
  const root: MathNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  for (const match of source.matchAll(/<(\/?)([\w:-]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1]!;
    if (match[5] !== undefined) {
      top.text += decode(match[5]);
      continue;
    }
    if (match[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of (match[3] ?? "").matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[attr[1]!] = decode(attr[2]!);
    const node: MathNode = { tag: match[2]!, attrs, children: [], text: "" };
    top.children.push(node);
    if (!match[4]) stack.push(node);
  }
  const find = (node: MathNode): MathNode | null => (node.tag === "math" ? node : node.children.map(find).find(Boolean) ?? null);
  return find(root);
}

function xml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const FONT = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>';

function run(text: string, plain: boolean) {
  if (!text) return "";
  return `<m:r>${plain ? '<m:rPr><m:sty m:val="p"/></m:rPr>' : ""}${FONT}<m:t xml:space="preserve">${xml(text)}</m:t></m:r>`;
}

const ACCENTS = new Set(["^", "ˆ", "~", "˜", "¯", "‾", "→", "˙", "¨", "ˇ", "˘", "´", "`"]);

function convert(node: MathNode): string {
  const kids = node.children;
  const all = () => kids.map(convert).join("");
  const arg = (index: number) => (kids[index] ? convert(kids[index]!) : "");
  switch (node.tag) {
    case "mi":
      // A single-letter identifier is italic in math; longer ones (sin, log) and \mathrm are upright.
      return run(node.text, node.attrs.mathvariant === "normal" || [...node.text].length > 1);
    case "mn":
    case "mo":
    case "mtext":
    case "ms":
      return run(node.text, true);
    case "mspace":
      return "";
    case "msup":
      return `<m:sSup><m:e>${arg(0)}</m:e><m:sup>${arg(1)}</m:sup></m:sSup>`;
    case "msub":
      return `<m:sSub><m:e>${arg(0)}</m:e><m:sub>${arg(1)}</m:sub></m:sSub>`;
    case "msubsup":
      return `<m:sSubSup><m:e>${arg(0)}</m:e><m:sub>${arg(1)}</m:sub><m:sup>${arg(2)}</m:sup></m:sSubSup>`;
    case "mfrac":
      return `<m:f>${/^0/.test(node.attrs.linethickness ?? "") ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : ""}<m:num>${arg(0)}</m:num><m:den>${arg(1)}</m:den></m:f>`;
    case "msqrt":
      return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${all()}</m:e></m:rad>`;
    case "mroot":
      return `<m:rad><m:deg>${arg(1)}</m:deg><m:e>${arg(0)}</m:e></m:rad>`;
    case "mover": {
      const mark = kids[1]?.tag === "mo" ? kids[1].text : "";
      if (node.attrs.accent === "true" && ACCENTS.has(mark)) return `<m:acc><m:accPr><m:chr m:val="${xml(mark)}"/></m:accPr><m:e>${arg(0)}</m:e></m:acc>`;
      return `<m:limUpp><m:e>${arg(0)}</m:e><m:lim>${arg(1)}</m:lim></m:limUpp>`;
    }
    case "munder":
      return `<m:limLow><m:e>${arg(0)}</m:e><m:lim>${arg(1)}</m:lim></m:limLow>`;
    case "munderover":
      return `<m:limUpp><m:e><m:limLow><m:e>${arg(0)}</m:e><m:lim>${arg(1)}</m:lim></m:limLow></m:e><m:lim>${arg(2)}</m:lim></m:limUpp>`;
    case "mtable":
      return `<m:m>${kids.map((row) => `<m:mr>${row.children.map((cell) => `<m:e>${convert(cell)}</m:e>`).join("")}</m:mr>`).join("")}</m:m>`;
    case "semantics":
      return arg(0);
    case "annotation":
    case "annotation-xml":
      return "";
    default:
      // mrow, mstyle, mpadded, mphantom, mtd, mtr and anything else: their content.
      return all() + run(node.text.trim(), true);
  }
}

/** An equation as OMML: <m:oMath> to sit among a paragraph's runs, or a displayed <m:oMathPara>. */
export function latexToOmml(tex: string, display: boolean): string {
  let mathml: string;
  try {
    mathml = katex.renderToString(tex, { output: "mathml", displayMode: display, throwOnError: true });
  } catch {
    // Not valid LaTeX: keep the source as plain text in an equation.
    const math = `<m:oMath>${run(tex, true)}</m:oMath>`;
    return display ? `<m:oMathPara>${math}</m:oMathPara>` : math;
  }
  const root = parseMathml(mathml);
  const math = `<m:oMath>${root ? root.children.map(convert).join("") : run(tex, true)}</m:oMath>`;
  return display ? `<m:oMathPara>${math}</m:oMathPara>` : math;
}

export const OMML_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/math";
