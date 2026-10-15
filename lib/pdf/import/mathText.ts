import katex from "katex";

/**
 * Equations read back from the glyphs a PDF draws them with. TeX sets math
 * in its own fonts (italic letters in CMMI, symbols in CMSY, big operators
 * in CMEX, blackboard letters in MSBM) and raises or lowers scripts; the
 * letters come through pdf.js's text layer with their font and baseline, so
 * most inline math can be written back as LaTeX. Structures drawn partly
 * with lines (fractions, roots, overlines) are put together from the lines
 * found around them; what can't be read is flagged for Claude to check.
 */

/** A glyph of an equation: its text, font and size, where it sits, and how far its baseline is from the line's (+ down). */
export type MathGlyph = { text: string; font: string; size: number; x: number; right: number; dy: number; bold?: boolean };

/** A structure placed among the glyphs: a fraction, or limits over and under a big operator. */
export type MathPart = { kind: "frac"; x: number; right: number; num: string; den: string; /** Set at full size (\dfrac). */ display?: boolean } | { kind: "tex"; x: number; right: number; tex: string };

/** A rule drawn over glyphs: an overline, or the bar of a root. */
export type MathBar = { x: number; right: number };

export type MathResult = { tex: string; flags: string[] };

const GREEK: Record<string, string> = {
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\varepsilon", ϵ: "\\epsilon", ζ: "\\zeta", η: "\\eta", θ: "\\theta", ϑ: "\\vartheta", ι: "\\iota", κ: "\\kappa", λ: "\\lambda", μ: "\\mu", ν: "\\nu", ξ: "\\xi", π: "\\pi", ϖ: "\\varpi", ρ: "\\rho", ϱ: "\\varrho", σ: "\\sigma", ς: "\\varsigma", τ: "\\tau", υ: "\\upsilon", φ: "\\varphi", ϕ: "\\phi", χ: "\\chi", ψ: "\\psi", ω: "\\omega",
  Γ: "\\Gamma", Δ: "\\Delta", Θ: "\\Theta", Λ: "\\Lambda", Ξ: "\\Xi", Π: "\\Pi", Σ: "\\Sigma", Υ: "\\Upsilon", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega",
};

const SYMBOLS: Record<string, string> = {
  "−": "-", "–": "-", "∗": "*", "×": "\\times", "·": "\\cdot", "⋅": "\\cdot", "÷": "\\div", "±": "\\pm", "∓": "\\mp",
  "≤": "\\leq", "≥": "\\geq", "≠": "\\neq", "≈": "\\approx", "≡": "\\equiv", "∼": "\\sim", "≃": "\\simeq", "≅": "\\cong", "∝": "\\propto", "≪": "\\ll", "≫": "\\gg", "≺": "\\prec", "≻": "\\succ",
  "∈": "\\in", "∉": "\\notin", "∋": "\\ni", "⊂": "\\subset", "⊃": "\\supset", "⊆": "\\subseteq", "⊇": "\\supseteq", "∩": "\\cap", "∪": "\\cup", "∅": "\\emptyset", "∖": "\\setminus",
  "∀": "\\forall", "∃": "\\exists", "¬": "\\neg", "∧": "\\wedge", "∨": "\\vee", "⊕": "\\oplus", "⊗": "\\otimes",
  "→": "\\to", "←": "\\leftarrow", "↔": "\\leftrightarrow", "⇒": "\\Rightarrow", "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow", "↦": "\\mapsto", "↑": "\\uparrow", "↓": "\\downarrow",
  "∞": "\\infty", "∂": "\\partial", "∇": "\\nabla", "ℓ": "\\ell", "ℏ": "\\hbar", "′": "'", "″": "''", "∘": "\\circ", "•": "\\bullet", "†": "\\dagger", "‡": "\\ddagger", "⋆": "\\star",
  "…": "\\ldots", "⋯": "\\cdots", "⋮": "\\vdots", "⋱": "\\ddots",
  "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∮": "\\oint", "⋃": "\\bigcup", "⋂": "\\bigcap",
  "⟨": "\\langle", "⟩": "\\rangle", "⌊": "\\lfloor", "⌋": "\\rfloor", "⌈": "\\lceil", "⌉": "\\rceil", "‖": "\\|", "∥": "\\|", "∣": "|",
  "{": "\\{", "}": "\\}", "%": "\\%", "#": "\\#", "&": "\\&", "$": "\\$", "_": "\\_", "~": "\\sim", "\\": "\\backslash",
  "ℝ": "\\mathbb{R}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}", "ℂ": "\\mathbb{C}", "ℙ": "\\mathbb{P}", "𝔼": "\\mathbb{E}",
  "√": "\\surd",
};

/** Accents drawn as their own glyph over a letter. */
const ACCENTS: Record<string, string> = { "ˆ": "\\hat", "^": "\\hat", "˜": "\\tilde", "~": "\\tilde", "¯": "\\bar", "ˉ": "\\bar", "˙": "\\dot", "¨": "\\ddot", "˘": "\\breve", "ˇ": "\\check", "´": "\\acute", "`": "\\grave", "⃗": "\\vec", "→": "\\vec" };

const BIG_OPERATORS = /[∑∏∫∮⋃⋂]/;

/** One glyph as LaTeX, in its font. */
/**
 * Letters some PDF writers re-encode wrongly in TeX's math fonts (Apple's
 * PDF tools among them, when annotating): what they come through as, and
 * what they are.
 */
const MISREAD: Array<[RegExp, string, string]> = [
  [/^cmmi/i, "⇡", "\\pi"],
  [/^cmsy/i, "⇠", "\\sim"],
  [/^cmex/i, "✓", "\\Big("],
  [/^cmex/i, "◆", "\\Big)"],
];

function glyphTex(char: string, font: string, flags: Set<string>): { tex: string; letter: "roman" | "math" | "none" } {
  const misread = MISREAD.find(([pattern, seen]) => pattern.test(font) && seen === char);
  if (misread) {
    flags.add("letters the PDF misnames");
    return { tex: misread[2], letter: "none" };
  }
  if (/^msbm|^msam/i.test(font) && /[A-Za-z]/.test(char)) return { tex: `\\mathbb{${char}}`, letter: "none" };
  if (/^cmsy|^cmbsy/i.test(font) && /[A-Z]/.test(char)) return { tex: `\\mathcal{${char}}`, letter: "none" };
  if (/^eufm/i.test(font) && /[A-Za-z]/.test(char)) return { tex: `\\mathfrak{${char}}`, letter: "none" };
  if (/^rsfs/i.test(font) && /[A-Za-z]/.test(char)) return { tex: `\\mathscr{${char}}`, letter: "none" };
  if (/[A-Za-z]/.test(char)) return { tex: char, letter: /^(cmmi|lmmath|stixmath|cmbsy)/i.test(font) ? "math" : "roman" };
  if (/[0-9.,;:!?()[\]|/+=<>'*-]/.test(char)) return { tex: char === "<" ? "<" : char, letter: "none" };
  const greek = GREEK[char];
  if (greek) return { tex: greek, letter: "none" };
  const symbol = SYMBOLS[char];
  if (symbol) {
    if (BIG_OPERATORS.test(char) && /^cmex/i.test(font)) flags.add("a big operator");
    return { tex: symbol, letter: "none" };
  }
  if (/\s/.test(char)) return { tex: "", letter: "none" };
  flags.add(`a symbol it couldn't read ("${char}")`);
  return { tex: char, letter: "none" };
}

type Level = "base" | "sup" | "sub";

/**
 * LaTeX for the glyphs of one equation (in order across the line), with any
 * fractions placed among them and the rules drawn over them. `base` is the
 * size of the line's text: smaller glyphs above or below the baseline are
 * scripts.
 */
export function mathTex(glyphs: MathGlyph[], base: number, parts: MathPart[] = [], bars: MathBar[] = []): MathResult {
  const flags = new Set<string>();
  type Item = { kind: "glyph"; glyph: MathGlyph } | { kind: "part"; part: MathPart };
  const items: Item[] = [...glyphs.map((glyph) => ({ kind: "glyph" as const, glyph })), ...parts.map((part) => ({ kind: "part" as const, part }))].sort((a, b) => (a.kind === "glyph" ? a.glyph.x : a.part.x) - (b.kind === "glyph" ? b.glyph.x : b.part.x));

  // Accents over a letter: the glyph overlapping it.
  const accentOf = new Map<MathGlyph, string>();
  const skip = new Set<MathGlyph>();
  items.forEach((item, index) => {
    if (item.kind !== "glyph") return;
    const accent = ACCENTS[item.glyph.text];
    if (!accent || item.glyph.text.length !== 1) return;
    // An arrow at full size on the baseline is an arrow, not an accent.
    if ((item.glyph.text === "→" || item.glyph.text === "~" || item.glyph.text === "^") && Math.abs(item.glyph.dy) < base * 0.25) return;
    const neighbours = [items[index - 1], items[index + 1]].filter((other): other is Item & { kind: "glyph" } => other?.kind === "glyph" && /[\p{L}\d]/u.test(other.glyph.text));
    const target = neighbours.find((other) => other.glyph.x < item.glyph.right - 0.3 && other.glyph.right > item.glyph.x + 0.3);
    if (!target) return;
    accentOf.set(target.glyph, accent);
    skip.add(item.glyph);
  });

  const levelOf = (glyph: MathGlyph): Level => {
    if (glyph.dy < -base * 0.2) return "sup";
    if (glyph.dy > base * 0.12 && glyph.size < base * 0.92) return "sub";
    if (glyph.dy > base * 0.25) return "sub";
    return "base";
  };

  // Glyphs under a bar: an overline, or a root's argument when the bar starts at a root sign.
  const barOf = (glyph: MathGlyph) => bars.find((bar) => glyph.x >= bar.x - 0.5 && glyph.right <= bar.right + 0.8);

  let out = "";
  let roman = "";
  let romanBold = false;
  let script: { level: Level; text: string } | null = null;
  const flushScript = () => {
    if (!script) return;
    out += `${script.level === "sup" ? "^" : "_"}{${script.text}}`;
    script = null;
  };
  let openBar: MathBar | null = null;
  let barText = "";
  let barIsRoot = false;
  const emit = (tex: string, level: Level) => {
    if (level === "base") {
      flushScript();
      if (openBar) barText += tex;
      else out += tex;
    } else {
      if (script && script.level !== level) flushScript();
      script ??= { level, text: "" };
      script.text += tex;
    }
  };
  const flushRoman = () => {
    if (!roman) return;
    const text = roman;
    roman = "";
    emit(`\\math${romanBold ? "bf" : "rm"}{${text}}`, "base");
  };
  const closeBar = () => {
    if (!openBar) return;
    // A script after the bar belongs to what's under it: \overline{X}_{n}.
    const pending = script;
    script = null;
    out += barIsRoot ? `\\sqrt{${barText}}` : `\\overline{${barText}}`;
    openBar = null;
    barText = "";
    script = pending;
    flushScript();
  };

  for (const item of items) {
    if (item.kind === "part") {
      flushRoman();
      closeBar();
      const part = item.part;
      emit(part.kind === "frac" ? `\\${part.display ? "d" : ""}frac{${part.num}}{${part.den}}` : part.tex, "base");
      if (part.kind === "frac") flags.add("a fraction");
      continue;
    }
    const glyph = item.glyph;
    if (skip.has(glyph)) continue;
    const level = levelOf(glyph);
    for (const char of glyph.text) {
      if (/\s/.test(char)) continue;
      // A root sign: what's under the bar that starts at its right edge goes under the root.
      if (char === "√") {
        flushRoman();
        closeBar();
        const bar = bars.find((candidate) => Math.abs(candidate.x - glyph.right) < 2.5);
        flags.add("a root");
        if (bar) {
          openBar = bar;
          barIsRoot = true;
          continue;
        }
        emit("\\surd ", level);
        continue;
      }
      const bar = level === "base" ? barOf(glyph) : null;
      if (openBar && bar !== openBar && level === "base") {
        flushRoman();
        closeBar();
      }
      if (bar && !openBar) {
        flushRoman();
        openBar = bar;
        barIsRoot = false;
        flags.add("an overline");
      }
      const { tex, letter } = glyphTex(char, glyph.font, flags);
      const accent = accentOf.get(glyph);
      if (letter === "roman" && level === "base" && !accent) {
        if (roman && romanBold !== Boolean(glyph.bold)) flushRoman();
        roman += tex;
        romanBold = Boolean(glyph.bold);
        continue;
      }
      flushRoman();
      const body = letter === "roman" ? `\\mathrm{${tex}}` : glyph.bold && letter === "math" ? `\\boldsymbol{${tex}}` : tex;
      const wrapped = accent ? `${accent}{${body}}` : body;
      // Commands followed by a letter need a space between them.
      emit(/\\[a-zA-Z]+$/.test(wrapped) ? `${wrapped} ` : wrapped, level);
    }
  }
  flushRoman();
  closeBar();
  flushScript();
  const tex = out
    .replace(/(\\cdot\s*){3}/g, "\\cdots ")
    .replace(/\.{2,3}/g, "\\ldots ")
    .replace(/ +(?=[^a-zA-Z]|$)/g, "")
    .replace(/\\mathrm\{([A-Za-z]{2,})\}(?=\()/g, "\\operatorname{$1}")
    .trim();
  // TeX that doesn't typeset is no use as a draft: the equation is flagged, to be placed as a picture or written by Claude.
  if (tex && !typesets(tex)) flags.add("TeX that doesn't typeset");
  return { tex, flags: [...flags] };
}

function typesets(tex: string) {
  try {
    katex.renderToString(tex, { throwOnError: true, displayMode: false, strict: "ignore" });
    return true;
  } catch {
    return false;
  }
}
