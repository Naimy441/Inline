"use client";

import { useMemo, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";

type Entry = [char: string, name: string];

const GROUPS: Array<{ name: string; chars: Entry[] }> = [
  {
    name: "Punctuation",
    chars: [
      ["—", "em dash"], ["–", "en dash"], ["…", "ellipsis"], ["“", "left double quote"], ["”", "right double quote"], ["‘", "left single quote"],
      ["’", "right single quote apostrophe"], ["«", "left guillemet"], ["»", "right guillemet"], ["•", "bullet"], ["·", "middle dot"], ["§", "section"],
      ["¶", "pilcrow paragraph"], ["†", "dagger"], ["‡", "double dagger"], ["©", "copyright"], ["®", "registered"], ["™", "trademark"],
      ["¿", "inverted question"], ["¡", "inverted exclamation"], ["‰", "per mille"], ["′", "prime"], ["″", "double prime"], ["№", "numero"],
    ],
  },
  {
    name: "Math",
    chars: [
      ["±", "plus minus"], ["×", "times multiply"], ["÷", "divide"], ["≠", "not equal"], ["≈", "approximately"], ["≤", "less or equal"],
      ["≥", "greater or equal"], ["∞", "infinity"], ["√", "square root"], ["∑", "sum sigma"], ["∏", "product"], ["∫", "integral"],
      ["∂", "partial"], ["∆", "increment delta"], ["°", "degree"], ["µ", "micro"], ["½", "one half"], ["⅓", "one third"],
      ["¼", "one quarter"], ["¾", "three quarters"], ["²", "squared superscript two"], ["³", "cubed superscript three"], ["∈", "element of"], ["∴", "therefore"],
    ],
  },
  {
    name: "Arrows",
    chars: [
      ["←", "left arrow"], ["→", "right arrow"], ["↑", "up arrow"], ["↓", "down arrow"], ["↔", "left right arrow"], ["↕", "up down arrow"],
      ["⇐", "left double arrow"], ["⇒", "implies right double arrow"], ["⇔", "if and only if"], ["↵", "return"], ["⟶", "long right arrow"], ["↗", "north east arrow"],
    ],
  },
  {
    name: "Currency",
    chars: [
      ["€", "euro"], ["£", "pound"], ["¥", "yen yuan"], ["¢", "cent"], ["₹", "rupee"], ["₩", "won"], ["₽", "ruble"], ["₺", "lira"], ["₿", "bitcoin"], ["₪", "shekel"], ["₦", "naira"], ["฿", "baht"],
    ],
  },
  {
    name: "Greek",
    chars: [
      ["α", "alpha"], ["β", "beta"], ["γ", "gamma"], ["δ", "delta"], ["ε", "epsilon"], ["θ", "theta"], ["λ", "lambda"], ["μ", "mu"],
      ["π", "pi"], ["σ", "sigma"], ["φ", "phi"], ["ω", "omega"], ["Γ", "capital gamma"], ["Δ", "capital delta"], ["Σ", "capital sigma"], ["Ω", "capital omega omega ohm"],
    ],
  },
  {
    name: "Letters",
    chars: [
      ["é", "e acute"], ["è", "e grave"], ["ê", "e circumflex"], ["ë", "e diaeresis"], ["á", "a acute"], ["à", "a grave"], ["â", "a circumflex"], ["ä", "a umlaut"],
      ["ã", "a tilde"], ["å", "a ring"], ["ç", "c cedilla"], ["ñ", "n tilde"], ["ó", "o acute"], ["ö", "o umlaut"], ["ø", "o slash"], ["ü", "u umlaut"],
      ["í", "i acute"], ["ú", "u acute"], ["ß", "sharp s eszett"], ["æ", "ae ligature"], ["œ", "oe ligature"], ["Ç", "capital c cedilla"], ["É", "capital e acute"], ["Ñ", "capital n tilde"],
    ],
  },
  {
    name: "Symbols",
    chars: [
      ["✓", "check mark"], ["✗", "cross mark"], ["★", "star filled"], ["☆", "star outline"], ["♥", "heart"], ["☐", "ballot box"], ["☑", "ballot box checked"], ["♪", "music note"],
      ["☀", "sun"], ["☎", "telephone"], ["✉", "envelope"], ["⚠", "warning"], ["✱", "asterisk heavy"], ["◆", "diamond"], ["●", "circle"], ["■", "square"],
    ],
  },
  {
    name: "Emoji",
    chars: [
      ["😀", "grinning face"], ["🙂", "slight smile"], ["😉", "wink"], ["🤔", "thinking"], ["👍", "thumbs up"], ["👎", "thumbs down"], ["👏", "clap"], ["🙏", "thanks pray"],
      ["🎉", "party tada"], ["✅", "check done"], ["❌", "cross no"], ["⭐", "star"], ["🔥", "fire"], ["💡", "idea bulb"], ["📌", "pin"], ["📎", "paperclip"],
      ["📅", "calendar"], ["📝", "memo note"], ["🚀", "rocket"], ["❤️", "red heart"], ["⚡", "lightning"], ["🌱", "seedling"], ["🏆", "trophy"], ["⏰", "alarm clock"],
    ],
  },
];

export function SpecialCharactersDialog({ open, onClose, onInsert }: { open: boolean; onClose: () => void; onInsert: (char: string) => void }) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.map((group) => ({ ...group, chars: group.chars.filter(([char, name]) => char === q || name.includes(q)) })).filter((group) => group.chars.length);
  }, [query]);

  return (
    <Dialog open={open} onClose={onClose} title="Special characters" width={520}>
      <input className="input" placeholder="Search, e.g. arrow, euro, check" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus aria-label="Search characters" />
      <div className="charmap">
        {groups.length === 0 && <p className="muted">No characters match “{query}”.</p>}
        {groups.map((group) => (
          <section key={group.name}>
            <h4>{group.name}</h4>
            <div className="charmap-grid">
              {group.chars.map(([char, name]) => (
                <button key={char + name} type="button" className="charmap-cell" title={name} aria-label={name} onClick={() => onInsert(char)}>
                  {char}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
