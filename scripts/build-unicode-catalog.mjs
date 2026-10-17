/**
 * Build the special-character catalog from the Unicode Character Database.
 *
 * The dialog searches and browses this file. It is the Name property of
 * every assigned character in Unicode 18.0.0 (controls, surrogates, private
 * use, and noncharacters have no character name and are left out).
 *
 * Usage: node scripts/build-unicode-catalog.mjs
 * Reads the UCD from UNICODE_UCD, or downloads 18.0.0 into node_modules/.cache.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "18.0.0";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "unicode", "catalog.json");
const CACHE = process.env.UNICODE_UCD || path.join(ROOT, "node_modules", ".cache", `unicode-${VERSION}`);

const FILES = {
  UnicodeData: `https://www.unicode.org/Public/${VERSION}/ucd/UnicodeData.txt`,
  Blocks: `https://www.unicode.org/Public/${VERSION}/ucd/Blocks.txt`,
  Scripts: `https://www.unicode.org/Public/${VERSION}/ucd/Scripts.txt`,
  DerivedName: `https://www.unicode.org/Public/${VERSION}/ucd/extracted/DerivedName.txt`,
};

/** Google Docs groups letters by script family, and everything else by general category. */
const CATEGORY_ORDER = [
  "Symbol",
  "Punctuation",
  "Number",
  "Format & Whitespace",
  "Modifier",
  "Latin",
  "Other European Scripts",
  "American Scripts",
  "African Scripts",
  "Middle Eastern Scripts",
  "South Asian Scripts",
  "Southeast Asian Scripts",
  "Hangul",
  "Other East Asian Scripts",
  "Han",
  "Other",
];

const SCRIPT_CATEGORY = new Map([
  ["Latin", "Latin"],
  ["Hangul", "Hangul"],
  ["Han", "Han"],
  ["Seal", "Han"],
  ["Armenian", "Other European Scripts"],
  ["Carian", "Other European Scripts"],
  ["Caucasian_Albanian", "Other European Scripts"],
  ["Coptic", "Other European Scripts"],
  ["Cypriot", "Other European Scripts"],
  ["Cypro_Minoan", "Other European Scripts"],
  ["Cyrillic", "Other European Scripts"],
  ["Elbasan", "Other European Scripts"],
  ["Georgian", "Other European Scripts"],
  ["Glagolitic", "Other European Scripts"],
  ["Gothic", "Other European Scripts"],
  ["Greek", "Other European Scripts"],
  ["Linear_A", "Other European Scripts"],
  ["Linear_B", "Other European Scripts"],
  ["Lycian", "Other European Scripts"],
  ["Lydian", "Other European Scripts"],
  ["Ogham", "Other European Scripts"],
  ["Old_Hungarian", "Other European Scripts"],
  ["Old_Italic", "Other European Scripts"],
  ["Old_Permic", "Other European Scripts"],
  ["Runic", "Other European Scripts"],
  ["Shavian", "Other European Scripts"],
  ["Sidetic", "Other European Scripts"],
  ["Todhri", "Other European Scripts"],
  ["Vithkuqi", "Other European Scripts"],
  ["Canadian_Aboriginal", "American Scripts"],
  ["Cherokee", "American Scripts"],
  ["Deseret", "American Scripts"],
  ["Osage", "American Scripts"],
  ["Adlam", "African Scripts"],
  ["Bamum", "African Scripts"],
  ["Bassa_Vah", "African Scripts"],
  ["Beria_Erfe", "African Scripts"],
  ["Egyptian_Hieroglyphs", "African Scripts"],
  ["Ethiopic", "African Scripts"],
  ["Garay", "African Scripts"],
  ["Medefaidrin", "African Scripts"],
  ["Mende_Kikakui", "African Scripts"],
  ["Meroitic_Cursive", "African Scripts"],
  ["Meroitic_Hieroglyphs", "African Scripts"],
  ["Nko", "African Scripts"],
  ["Osmanya", "African Scripts"],
  ["Tifinagh", "African Scripts"],
  ["Vai", "African Scripts"],
  ["Anatolian_Hieroglyphs", "Middle Eastern Scripts"],
  ["Arabic", "Middle Eastern Scripts"],
  ["Avestan", "Middle Eastern Scripts"],
  ["Chorasmian", "Middle Eastern Scripts"],
  ["Cuneiform", "Middle Eastern Scripts"],
  ["Elymaic", "Middle Eastern Scripts"],
  ["Hatran", "Middle Eastern Scripts"],
  ["Hebrew", "Middle Eastern Scripts"],
  ["Imperial_Aramaic", "Middle Eastern Scripts"],
  ["Inscriptional_Pahlavi", "Middle Eastern Scripts"],
  ["Inscriptional_Parthian", "Middle Eastern Scripts"],
  ["Mandaic", "Middle Eastern Scripts"],
  ["Manichaean", "Middle Eastern Scripts"],
  ["Nabataean", "Middle Eastern Scripts"],
  ["Old_North_Arabian", "Middle Eastern Scripts"],
  ["Old_Persian", "Middle Eastern Scripts"],
  ["Old_Sogdian", "Middle Eastern Scripts"],
  ["Old_South_Arabian", "Middle Eastern Scripts"],
  ["Palmyrene", "Middle Eastern Scripts"],
  ["Phoenician", "Middle Eastern Scripts"],
  ["Proto_Cuneiform", "Middle Eastern Scripts"],
  ["Psalter_Pahlavi", "Middle Eastern Scripts"],
  ["Samaritan", "Middle Eastern Scripts"],
  ["Sogdian", "Middle Eastern Scripts"],
  ["Syriac", "Middle Eastern Scripts"],
  ["Ugaritic", "Middle Eastern Scripts"],
  ["Yezidi", "Middle Eastern Scripts"],
  ["Ahom", "South Asian Scripts"],
  ["Bengali", "South Asian Scripts"],
  ["Bhaiksuki", "South Asian Scripts"],
  ["Brahmi", "South Asian Scripts"],
  ["Chakma", "South Asian Scripts"],
  ["Devanagari", "South Asian Scripts"],
  ["Dives_Akuru", "South Asian Scripts"],
  ["Dogra", "South Asian Scripts"],
  ["Grantha", "South Asian Scripts"],
  ["Gujarati", "South Asian Scripts"],
  ["Gunjala_Gondi", "South Asian Scripts"],
  ["Gurmukhi", "South Asian Scripts"],
  ["Gurung_Khema", "South Asian Scripts"],
  ["Kaithi", "South Asian Scripts"],
  ["Kannada", "South Asian Scripts"],
  ["Kharoshthi", "South Asian Scripts"],
  ["Khojki", "South Asian Scripts"],
  ["Khudawadi", "South Asian Scripts"],
  ["Kirat_Rai", "South Asian Scripts"],
  ["Lepcha", "South Asian Scripts"],
  ["Limbu", "South Asian Scripts"],
  ["Mahajani", "South Asian Scripts"],
  ["Malayalam", "South Asian Scripts"],
  ["Marchen", "South Asian Scripts"],
  ["Masaram_Gondi", "South Asian Scripts"],
  ["Meetei_Mayek", "South Asian Scripts"],
  ["Modi", "South Asian Scripts"],
  ["Mro", "South Asian Scripts"],
  ["Multani", "South Asian Scripts"],
  ["Nag_Mundari", "South Asian Scripts"],
  ["Nandinagari", "South Asian Scripts"],
  ["Newa", "South Asian Scripts"],
  ["Ol_Chiki", "South Asian Scripts"],
  ["Ol_Onal", "South Asian Scripts"],
  ["Oriya", "South Asian Scripts"],
  ["Saurashtra", "South Asian Scripts"],
  ["Sharada", "South Asian Scripts"],
  ["Siddham", "South Asian Scripts"],
  ["Sinhala", "South Asian Scripts"],
  ["Sora_Sompeng", "South Asian Scripts"],
  ["Sunuwar", "South Asian Scripts"],
  ["Syloti_Nagri", "South Asian Scripts"],
  ["Takri", "South Asian Scripts"],
  ["Tamil", "South Asian Scripts"],
  ["Tangsa", "South Asian Scripts"],
  ["Telugu", "South Asian Scripts"],
  ["Thaana", "South Asian Scripts"],
  ["Tibetan", "South Asian Scripts"],
  ["Tirhuta", "South Asian Scripts"],
  ["Tolong_Siki", "South Asian Scripts"],
  ["Toto", "South Asian Scripts"],
  ["Tulu_Tigalari", "South Asian Scripts"],
  ["Wancho", "South Asian Scripts"],
  ["Warang_Citi", "South Asian Scripts"],
  ["Balinese", "Southeast Asian Scripts"],
  ["Batak", "Southeast Asian Scripts"],
  ["Buginese", "Southeast Asian Scripts"],
  ["Buhid", "Southeast Asian Scripts"],
  ["Cham", "Southeast Asian Scripts"],
  ["Hanifi_Rohingya", "Southeast Asian Scripts"],
  ["Hanunoo", "Southeast Asian Scripts"],
  ["Javanese", "Southeast Asian Scripts"],
  ["Kawi", "Southeast Asian Scripts"],
  ["Kayah_Li", "Southeast Asian Scripts"],
  ["Khmer", "Southeast Asian Scripts"],
  ["Lao", "Southeast Asian Scripts"],
  ["Makasar", "Southeast Asian Scripts"],
  ["Myanmar", "Southeast Asian Scripts"],
  ["New_Tai_Lue", "Southeast Asian Scripts"],
  ["Nyiakeng_Puachue_Hmong", "Southeast Asian Scripts"],
  ["Pahawh_Hmong", "Southeast Asian Scripts"],
  ["Pau_Cin_Hau", "Southeast Asian Scripts"],
  ["Rejang", "Southeast Asian Scripts"],
  ["Sundanese", "Southeast Asian Scripts"],
  ["Tagalog", "Southeast Asian Scripts"],
  ["Tagbanwa", "Southeast Asian Scripts"],
  ["Tai_Le", "Southeast Asian Scripts"],
  ["Tai_Tham", "Southeast Asian Scripts"],
  ["Tai_Viet", "Southeast Asian Scripts"],
  ["Tai_Yo", "Southeast Asian Scripts"],
  ["Thai", "Southeast Asian Scripts"],
  ["Bopomofo", "Other East Asian Scripts"],
  ["Hiragana", "Other East Asian Scripts"],
  ["Jurchen", "Other East Asian Scripts"],
  ["Katakana", "Other East Asian Scripts"],
  ["Khitan_Small_Script", "Other East Asian Scripts"],
  ["Lisu", "Other East Asian Scripts"],
  ["Miao", "Other East Asian Scripts"],
  ["Nushu", "Other East Asian Scripts"],
  ["Tangut", "Other East Asian Scripts"],
  ["Yi", "Other East Asian Scripts"],
  ["Duployan", "Other"],
  ["Mongolian", "Other"],
  ["Old_Turkic", "Other"],
  ["Old_Uyghur", "Other"],
  ["Phags_Pa", "Other"],
  ["Soyombo", "Other"],
  ["Zanabazar_Square", "Other"],
]);

// Choseong ieung (U+110B) contributes an empty short name. Trailing ieung is "NG", in HANGUL_T.
const HANGUL_L = ["G", "GG", "N", "D", "DD", "R", "M", "B", "BB", "S", "SS", "", "J", "JJ", "C", "K", "T", "P", "H"];
const HANGUL_V = ["A", "AE", "YA", "YAE", "EO", "E", "YEO", "YE", "O", "WA", "WAE", "OE", "YO", "U", "WEO", "WE", "WI", "YU", "EU", "YI", "I"];
const HANGUL_T = ["", "G", "GG", "GS", "N", "NJ", "NH", "D", "L", "LG", "LM", "LB", "LS", "LT", "LP", "LH", "M", "B", "BS", "S", "SS", "NG", "J", "C", "K", "T", "P", "H"];

function hangulName(cp) {
  const index = cp - 0xac00;
  const l = Math.floor(index / 588);
  const v = Math.floor((index % 588) / 28);
  const t = index % 28;
  return `HANGUL SYLLABLE ${HANGUL_L[l]}${HANGUL_V[v]}${HANGUL_T[t]}`;
}

async function ensureUcd() {
  await mkdir(CACHE, { recursive: true });
  const texts = {};
  for (const [name, url] of Object.entries(FILES)) {
    const file = path.join(CACHE, `${name}.txt`);
    try {
      texts[name] = await readFile(file, "utf8");
    } catch {
      console.log(`downloading ${url}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      texts[name] = await response.text();
      await writeFile(file, texts[name]);
    }
  }
  return texts;
}

function dataLines(text) {
  return text.split(/\n/).filter((line) => line && !line.startsWith("#"));
}

function parseRanges(text, valueOf) {
  const ranges = [];
  for (const line of dataLines(text)) {
    const semi = line.indexOf(";");
    if (semi < 0) continue;
    const span = line.slice(0, semi).trim();
    const rest = line.slice(semi + 1).trim();
    const value = valueOf(rest);
    const [startText, endText] = span.split("..");
    ranges.push({ start: Number.parseInt(startText, 16), end: Number.parseInt(endText ?? startText, 16), value });
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

function lookup(ranges, cp) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (cp < range.start) hi = mid - 1;
    else if (cp > range.end) lo = mid + 1;
    else return range.value;
  }
  return undefined;
}

function generalCategories(text) {
  const ranges = [];
  let open = null;
  for (const line of dataLines(text)) {
    const fields = line.split(";");
    const cp = Number.parseInt(fields[0], 16);
    const name = fields[1];
    const gc = fields[2];
    if (name.endsWith(", First>")) {
      open = { start: cp, gc };
      continue;
    }
    if (name.endsWith(", Last>")) {
      if (!open) throw new Error(`UnicodeData Last without First at ${fields[0]}`);
      ranges.push({ start: open.start, end: cp, value: open.gc });
      open = null;
      continue;
    }
    ranges.push({ start: cp, end: cp, value: gc });
  }
  if (open) throw new Error("UnicodeData ended inside a range");
  return ranges;
}

function classify(gc, script) {
  if (gc.startsWith("P")) return "Punctuation";
  if (gc.startsWith("N")) return "Number";
  if (gc === "Zs" || gc === "Zl" || gc === "Zp" || gc === "Cf") return "Format & Whitespace";
  if (gc === "Mn" || gc === "Mc" || gc === "Me" || gc === "Sk" || gc === "Lm") return "Modifier";
  if (gc === "Sm" || gc === "Sc" || gc === "So" || script === "Braille" || script === "SignWriting") return "Symbol";
  if (gc === "Lu" || gc === "Ll" || gc === "Lt" || gc === "Lo") {
    // A letter with no script of its own (the micro sign, for one) sits with the other letterlike symbols.
    if (script === "Common" || script === "Inherited") return "Symbol";
    const category = SCRIPT_CATEGORY.get(script);
    if (!category) throw new Error(`no category for letter script ${script} (${gc})`);
    return category;
  }
  throw new Error(`unclassified ${gc} ${script}`);
}

function coalesce(cps) {
  const runs = [];
  for (const cp of cps) {
    const last = runs[runs.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else runs.push([cp, cp]);
  }
  return runs;
}

function u32Base64(values) {
  const bytes = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i += 1) bytes.writeUInt32LE(values[i], i * 4);
  return bytes.toString("base64");
}

function u16Base64(values) {
  const bytes = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i += 1) bytes.writeUInt16LE(values[i], i * 2);
  return bytes.toString("base64");
}

const ucd = await ensureUcd();
const blocks = parseRanges(ucd.Blocks, (rest) => rest.split("#")[0].trim());
const scripts = parseRanges(ucd.Scripts, (rest) => rest.split("#")[0].trim());
const categories = generalCategories(ucd.UnicodeData);

/** @type {Map<string, Map<string, number[]>>} */
const grouped = new Map(CATEGORY_ORDER.map((name) => [name, new Map()]));
const combining = [];
const explicit = [];
const patterns = [];
let hangulChecked = 0;

for (const line of dataLines(ucd.DerivedName)) {
  const semi = line.indexOf(";");
  const span = line.slice(0, semi).trim();
  const name = line.slice(semi + 1).trim();
  const [startText, endText] = span.split("..");
  const start = Number.parseInt(startText, 16);
  const end = Number.parseInt(endText ?? startText, 16);
  if (name.includes("*")) {
    patterns.push({ start, end, prefix: name.replace("*", "") });
    for (let cp = start; cp <= end; cp += 1) addCharacter(cp);
    continue;
  }
  for (let cp = start; cp <= end; cp += 1) {
    const actual = cp >= 0xac00 && cp <= 0xd7a3 ? hangulName(cp) : name;
    if (cp >= 0xac00 && cp <= 0xd7a3) {
      if (actual !== name && start === end) throw new Error(`hangul name ${cp.toString(16)} expected ${actual} got ${name}`);
      hangulChecked += 1;
    } else if (start !== end) {
      throw new Error(`unexpected multi-code name ${span} ${name}`);
    }
    if (!(cp >= 0xac00 && cp <= 0xd7a3)) explicit.push([cp, name]);
    addCharacter(cp);
  }
}

if (!patterns.some((pattern) => pattern.hangul)) {
  patterns.push({ start: 0xac00, end: 0xd7a3, prefix: "HANGUL SYLLABLE ", hangul: true });
}
patterns.sort((a, b) => a.start - b.start);

function addCharacter(cp) {
  const gc = lookup(categories, cp);
  const script = lookup(scripts, cp);
  const block = lookup(blocks, cp);
  if (!gc || !script || !block) throw new Error(`missing properties for U+${cp.toString(16)}`);
  const category = classify(gc, script);
  const bucket = grouped.get(category);
  let list = bucket.get(block);
  if (!list) bucket.set(block, (list = []));
  list.push(cp);
  if (gc === "Mn" || gc === "Mc" || gc === "Me") combining.push(cp);
}

if (hangulChecked !== 11172) throw new Error(`expected 11172 hangul syllables, checked ${hangulChecked}`);

explicit.sort((a, b) => a[0] - b[0]);
const dict = [];
const dictId = new Map();
const words = [];
const wordOffs = [0];
const nameCps = [];
for (const [cp, name] of explicit) {
  if (name !== name.trim() || name.includes("  ")) throw new Error(`odd name ${name}`);
  nameCps.push(cp);
  for (const word of name.split(" ")) {
    let id = dictId.get(word);
    if (id === undefined) {
      id = dict.length;
      dictId.set(word, id);
      dict.push(word);
    }
    if (id > 0xffff) throw new Error("dictionary overflow");
    words.push(id);
  }
  wordOffs.push(words.length);
}

const catalogCategories = [];
let count = 0;
for (const name of CATEGORY_ORDER) {
  const blocksInCategory = [...grouped.get(name).entries()]
    .map(([blockName, cps]) => ({ name: blockName, runs: coalesce(cps.sort((a, b) => a - b)) }))
    .filter((block) => block.runs.length)
    .sort((a, b) => a.runs[0][0] - b.runs[0][0]);
  if (!blocksInCategory.length) continue;
  for (const block of blocksInCategory) {
    for (const [start, end] of block.runs) count += end - start + 1;
  }
  catalogCategories.push({ name, blocks: blocksInCategory });
}

const catalog = {
  version: VERSION,
  notice: `Character names and blocks derived from the Unicode Character Database, Version ${VERSION}. Copyright © 1991-2026 Unicode, Inc. https://www.unicode.org/copyright.html`,
  count,
  categories: catalogCategories,
  combining: coalesce(combining.sort((a, b) => a - b)),
  names: {
    cps: u32Base64(nameCps),
    wordOffs: u32Base64(wordOffs),
    words: u16Base64(words),
    dict,
  },
  patterns: patterns.map((pattern) => (pattern.hangul ? { start: pattern.start, end: pattern.end, prefix: pattern.prefix, hangul: true } : { start: pattern.start, end: pattern.end, prefix: pattern.prefix })),
};

await mkdir(path.dirname(OUT), { recursive: true });
const json = JSON.stringify(catalog);
await writeFile(OUT, json);

const counts = catalogCategories.map((category) => {
  const n = category.blocks.reduce((sum, block) => sum + block.runs.reduce((runSum, [start, end]) => runSum + (end - start + 1), 0), 0);
  return `${category.name}: ${n} (${category.blocks.length} blocks)`;
});
console.log(counts.join("\n"));
console.log(`characters ${count}`);
console.log(`explicit names ${explicit.length}, dictionary ${dict.length}, hangul ${hangulChecked}, patterns ${patterns.length}`);
console.log(`catalog ${json.length} bytes → ${OUT}`);
console.log(`symbol blocks: ${catalogCategories[0].blocks.map((block) => block.name).join(", ")}`);
