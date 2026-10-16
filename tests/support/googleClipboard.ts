/**
 * What Google Docs puts on the clipboard as text/html, for a passage in Arial
 * 11pt black at 1.15 line spacing with no space between paragraphs: every
 * paragraph is a <p> whose line-height is the spacing × 1.2 (1.15 is written
 * 1.38), wrapped in a <b> that isn't bold, and each empty paragraph is a
 * <br> between them.
 */

const SPAN = "font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;";

export function googleParagraph(text: string, { lineHeight = "1.38", before = "0pt", after = "0pt", span = SPAN } = {}) {
  return `<p dir="ltr" style="line-height:${lineHeight};margin-top:${before};margin-bottom:${after};"><span style="${span}">${text}</span></p>`;
}

export function googleClipboard(body: string) {
  return `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-6f0d1c2e-7fff-3a4b-9c5d-0e1f2a3b4c5d">${body}</b><br class="Apple-interchange-newline">`;
}

export const PROLOGUE =
  "Scene of Stone King being enchanted/bewitched. The agony and pain of it all. But the reason it was righteois from the perspective. Done at night time in the light of torches and fires in a unbreakable chamber by the winners of the war starting a new nation from the ashes of the stone kings kingdom. The wars still clashing outside, and the undercoverness of what was going on. The kingdom burning in shatters and horror, people crying and dying. The dawn before a new era.";

/** The passage the paste fixes were made for: a short line, a blank line, a heading line, a long paragraph, a blank line and another paragraph. */
export const GOOGLE_PASSAGE = googleClipboard(
  [
    googleParagraph("3 parts @ 6 - 12 for 114 @ 3.6k to 5.4k words"),
    "<br />",
    googleParagraph("PROLOGUE"),
    googleParagraph(PROLOGUE),
    "<br />",
    googleParagraph("Certainly! Here’s a more detailed and slow-paced version, exploring the world and atmosphere in a style akin to Sanderson's:"),
  ].join(""),
);
