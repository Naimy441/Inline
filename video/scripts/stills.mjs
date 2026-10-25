// Renders review stills at chosen moments: node scripts/stills.mjs scene:seconds ... (or "all")
import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';

const root = path.resolve(import.meta.dirname, '..');
const out = process.env.STILLS_DIR;
const timeline = JSON.parse(fs.readFileSync(path.join(root, 'src/data/timeline.json'), 'utf8'));
let picks = process.argv.slice(2);
if (picks[0] === 'all') picks = timeline.scenes.flatMap((s) => [0.25, 0.5, 0.8].map((f) => `${s.id}:${((s.frames / 30) * f).toFixed(1)}`));
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.ts'), publicDir: path.join(root, 'public') });
const composition = await selectComposition({ serveUrl, id: 'Inline' });
for (const pick of picks) {
  const [id, sec] = pick.split(':');
  const scene = timeline.scenes.find((s) => s.id === id);
  const frame = scene.from + Math.round(Number(sec) * 30);
  await renderStill({ composition, serveUrl, frame, output: path.join(out, `${id}-${sec}.png`), scale: 0.5 });
  console.log('still', pick);
}
