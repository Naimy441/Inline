// Records a page with the Chrome DevTools screencast: Retina JPEG frames with timestamps, turned
// into a constant 30 fps MP4 by ffmpeg. Much sharper than Playwright's built-in video.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './app.mjs';

export const RECS = path.join(ROOT, 'public', 'rec');
fs.mkdirSync(RECS, { recursive: true });

export async function record(page, name) {
  const dir = path.join(ROOT, 'capture-data', 'frames', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const marks = [];
  const t0 = Date.now() / 1000;
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const file = path.join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 2880, maxHeight: 1800, everyNthFrame: 1 });

  return {
    /** Named moment in the recording, in seconds from the start, for lining up the edit. */
    mark(label) {
      const at = Date.now() / 1000 - t0;
      marks.push({ label, at: +at.toFixed(2) });
      console.log(`  [${name}] ${label} @ ${at.toFixed(1)}s`);
    },
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const end = Date.now() / 1000;
      if (!frames.length) throw new Error(`no frames recorded for ${name}`);
      const start = Math.min(t0, frames[0].t);
      // ffmpeg concat list: each frame held until the next one arrives.
      const lines = [];
      frames.forEach((f, i) => {
        const next = i + 1 < frames.length ? frames[i + 1].t : end;
        lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
      });
      lines.push(`file '${frames.at(-1).file}'`);
      const list = path.join(dir, 'list.txt');
      fs.writeFileSync(list, lines.join('\n'));
      const lead = Math.max(0, frames[0].t - start);
      const out = path.join(RECS, `${name}.mp4`);
      execFileSync('ffmpeg', [
        '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
        '-vf', `tpad=start_duration=${lead.toFixed(3)}:start_mode=clone,fps=30,scale=2880:-2:flags=lanczos,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-movflags', '+faststart', out,
      ]);
      fs.writeFileSync(path.join(RECS, `${name}.json`), JSON.stringify({ marks, seconds: +(end - t0).toFixed(2) }, null, 2));
      console.log(`recorded ${name}: ${frames.length} frames, ${(end - t0).toFixed(1)}s`);
      return { marks, seconds: end - t0 };
    },
  };
}
