// Writes SCRIPT.md and out/inline-demo.srt from src/scenes.ts and src/data/timeline.json.
// Run with: npx tsx scripts/script-doc.ts
import fs from 'node:fs';
import path from 'node:path';

import timeline from '../src/data/timeline.json';
import { SCENES } from '../src/scenes';

const root = path.resolve(__dirname, '..');
const FPS = timeline.fps;
const clock = (f: number) => {
  const s = f / FPS;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const srt = (f: number) => {
  const ms = Math.round((f / FPS) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const total = SCENES.reduce((n, s) => n + words(s.vo), 0);
const rows = timeline.scenes.map((t, i) => {
  const s = SCENES.find((x) => x.id === t.id)!;
  return `| ${i + 1} | ${clock(t.from)} - ${clock(t.from + t.frames)} | ${s.title} | ${words(s.vo)} |`;
});
const blocks = timeline.scenes.map((t, i) => {
  const s = SCENES.find((x) => x.id === t.id)!;
  return `## ${i + 1}. ${s.title}  \`${clock(t.from)} - ${clock(t.from + t.frames)}\`\n\n**On screen:** ${s.visual}\n\n> ${s.vo}`;
});
const doc = `# Inline product video: voiceover script

Runtime ${clock(timeline.frames)}. ${total} words of narration, voiced by ElevenLabs "Jon".

| # | Time | Section | Words |
|---|---|---|---|
${rows.join('\n')}

---

${blocks.join('\n\n')}

---

Pronunciation: LaTeX (LAY-tek), MLA and MCP (say the letters), Codex (KOH-deks).
`;
fs.writeFileSync(path.join(root, 'SCRIPT.md'), doc);

let n = 0;
const cues = timeline.scenes.flatMap((t) => t.lines.map((l) => `${++n}\n${srt(t.from + l.at)} --> ${srt(t.from + l.end + 8)}\n${l.text}\n`));
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
fs.writeFileSync(path.join(root, 'out', 'inline-demo.srt'), cues.join('\n'));
console.log(`SCRIPT.md and out/inline-demo.srt: ${n} captions, ${total} words`);
