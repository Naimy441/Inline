// Generates the narration with ElevenLabs (voice: Jon), one clip per sentence, and lays the clips
// out scene by scene. Writes public/vo/*.mp3 and src/data/timeline.json.
// Run with: npx tsx --env-file=.env scripts/voiceover.ts   (add --force to regenerate every clip)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

import { FPS, SCENES, sentences } from '../src/scenes';

const VOICE = 'enzbGixeo55iqn1QxbbC'; // Jon
const MODEL = 'eleven_v4';
const SETTINGS = { stability: 0.5, similarityBoost: 0.75 };
/** Silence between two sentences of a scene, before the first line after a cut, and held at the end. */
const GAP = 0.35;
const LEAD = 0.6;
const TAIL = 1.4;

const root = path.resolve(__dirname, '..');
const voDir = path.join(root, 'public', 'vo');
const force = process.argv.includes('--force');

/** Spellings the voice reads more reliably than the written form. */
const spoken = (t: string) =>
  t
    .replace(/\bLaTeX\b/g, 'lay-tek')
    .replace(/\bMLA\b/g, 'M-L-A')
    .replace(/\bMCP\b/g, 'M-C-P')
    .replace(/\bCommand ([JL])\b/g, 'Command-$1');

interface Clip {
  scene: string;
  index: number;
  text: string;
  src: string;
  /** Where speech starts and ends inside the clip, in seconds. */
  speechStart: number;
  speechEnd: number;
  hash: string;
}

const client = new ElevenLabsClient();
const lines = SCENES.flatMap((s) => sentences(s.vo).map((text, index) => ({ scene: s, index, text })));

async function clip(i: number): Promise<Clip> {
  const { scene, index, text } = lines[i];
  const name = `${scene.id}-${index}`;
  const previousText = lines.slice(Math.max(0, i - 2), i).map((l) => spoken(l.text)).join(' ') || undefined;
  const nextText = lines[i + 1] ? spoken(lines[i + 1].text) : undefined;
  const hash = crypto.createHash('sha1').update(JSON.stringify([VOICE, MODEL, SETTINGS, spoken(text), previousText, nextText])).digest('hex').slice(0, 12);
  const metaPath = path.join(voDir, `${name}.json`);
  if (!force && fs.existsSync(metaPath)) {
    const meta: Clip = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.hash === hash) return meta;
  }
  const res = await client.textToSpeech.convertWithTimestamps(VOICE, {
    text: spoken(text),
    modelId: MODEL,
    voiceSettings: SETTINGS,
    outputFormat: 'mp3_44100_128',
    previousText,
    nextText,
    seed: 11,
  });
  fs.writeFileSync(path.join(voDir, `${name}.mp3`), Buffer.from(res.audioBase64, 'base64'));
  const a = res.alignment!;
  const idx = a.characters.map((c, k) => (c.trim() ? k : -1)).filter((k) => k >= 0);
  const meta: Clip = {
    scene: scene.id,
    index,
    text,
    src: `vo/${name}.mp3`,
    speechStart: a.characterStartTimesSeconds[idx[0]],
    speechEnd: a.characterEndTimesSeconds[idx[idx.length - 1]],
    hash,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`generated ${name}`);
  return meta;
}

async function main() {
  fs.mkdirSync(voDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'data'), { recursive: true });
  const clips: Clip[] = [];
  for (let i = 0; i < lines.length; i += 1) clips.push(await clip(i));

  const scenes: { id: string; from: number; frames: number; lines: { text: string; src: string; at: number; end: number; clipFrom: number }[] }[] = [];
  let k = 0;
  let sceneStart = 0;
  for (const scene of SCENES) {
    let t = scene.lead ?? LEAD;
    const out: (typeof scenes)[number]['lines'] = [];
    sentences(scene.vo).forEach((text, index) => {
      const c = clips[k++];
      if (index > 0) t += GAP + (scene.pauses?.[index] ?? 0);
      else t += scene.pauses?.[0] ?? 0;
      const len = c.speechEnd - c.speechStart;
      // Scene-relative frames; the clip's own leading silence plays before the speech start.
      out.push({ text, src: c.src, at: Math.round(t * FPS), end: Math.round((t + len) * FPS), clipFrom: Math.round((t - c.speechStart) * FPS) });
      t += len;
    });
    const seconds = Math.max(scene.min ?? 0, t + (scene.tail ?? TAIL));
    const frames = Math.round(seconds * FPS);
    scenes.push({ id: scene.id, from: sceneStart, frames, lines: out });
    sceneStart += frames;
  }
  fs.writeFileSync(path.join(root, 'src', 'data', 'timeline.json'), JSON.stringify({ fps: FPS, frames: sceneStart, scenes }, null, 2));
  for (const s of scenes) {
    console.log(`${(s.from / FPS).toFixed(1).padStart(6)}s  ${s.id.padEnd(10)} ${(s.frames / FPS).toFixed(1)}s`);
    for (const l of s.lines) console.log(`          ${(l.at / FPS).toFixed(2).padStart(6)}  ${l.text}`);
  }
  console.log(`total ${(sceneStart / FPS / 60).toFixed(2)} min`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
