# Inline product video

A 5:14 narrated demo of Inline, built with [Remotion](https://www.remotion.dev). All app footage is the Inline desktop app (built from `main`) running on a seeded demo account, with real Claude edits recorded live. Narration is ElevenLabs, voice "Jon".

- `out/inline-demo.mp4` is the finished video (1920x1080, 30 fps, narration normalized to -16 LUFS).
- `out/inline-demo.srt` has the narration as captions.
- `SCRIPT.md` is the voiceover script with timestamps per section.

## The demo account

`scripts/seed.ts` writes the account into a fresh data folder: a grad student who also works in product marketing, with four colored folders, a thesis proposal (table of contents, citations, LaTeX, a table, a figure, headers and page numbers, three advisor comments and a saved version), work documents, a problem set, an MLA essay, letters, a résumé and a designed Canvas. `scripts/reset.sh` restores the freshly seeded copy (`capture-data/pristine`).

## Rebuilding

```sh
npm install
# 1. Seed the account (from the repository root) and keep a pristine copy
INLINE_DATA_DIR=video/capture-data/desktop-user/data INLINE_MIRROR_DIR=off npx tsx video/scripts/seed.ts
cp -R video/capture-data/desktop-user/data video/capture-data/pristine

# 2. Serve Inline on that data, from the repository root (after `npm run build`)
INLINE_DATA_DIR=video/capture-data/desktop-user/data INLINE_MIRROR_DIR=video/capture-data/Documents/Inline INLINE_DESKTOP=1 npx next start -p 4391

# 3. Record the desktop app (Electron from desktop/, driven by Playwright). These run real
#    Claude turns on the signed-in account, in this order:
node scripts/cap-thesis.mjs          # editor scroll, "Tighten the introduction"
node scripts/cap-thesis2.mjs keep && node scripts/cap-thesis2.mjs select
node scripts/cap-thesis2.mjs codex   # the provider switch (the clip is cut before Codex replies)
node scripts/cap-thesis2.mjs comments
node scripts/cap-stills.mjs && node scripts/cap-home.mjs && node scripts/cap-history.mjs
node scripts/cap-pdf.mjs && node scripts/cap-pdfpage.mjs
node scripts/cap-organize.mjs        # after adding the unfiled documents (see below)
node scripts/cap-mcp.mjs             # Claude Code in a terminal, over MCP

# 4. Narration, script and captions
npx tsx --env-file=.env scripts/voiceover.ts     # needs ELEVENLABS_API_KEY in .env
npx tsx scripts/script-doc.ts

# 5. Preview and render
npx remotion studio src/index.ts
npx remotion render src/index.ts Inline out/inline-raw.mp4 --crf 16
ffmpeg -i out/inline-raw.mp4 -c:v copy -af loudnorm=I=-16:TP=-1.5:LRA=11 -ar 48000 -c:a aac -b:a 192k -movflags +faststart out/inline-demo.mp4
```

The organize scene needs six unfiled documents; they were added with `POST /api/documents` (titles in `src/scenes/Product.tsx` and the Word-copy listing).

Recordings use the DevTools screencast (`scripts/recorder.mjs`): Retina JPEG frames with timestamps, turned into constant-frame-rate MP4s in `public/rec`, with named marks in a matching JSON file. Stills are in `public/shots`.

Scene timing and narration live together in `src/scenes.ts`. `scripts/voiceover.ts` makes one clip per sentence and lays them out in `src/data/timeline.json`; each scene component places its visuals on the frame its sentences start (`useLines`), so changing a line re-times the picture with it. Clips are cached in `public/vo` and only regenerated when their text changes.

`scripts/stills.mjs scene:seconds ...` (or `all`) renders review stills to `$STILLS_DIR`.
