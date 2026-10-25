import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadSerif } from '@remotion/google-fonts/InstrumentSerif';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import React from 'react';
import { AbsoluteFill, Easing, Freeze, Img, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

import timeline from './data/timeline.json';

export const { fontFamily: SANS } = loadInter('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] });
export const { fontFamily: SERIF } = loadSerif('normal', { subsets: ['latin'] });
loadSerif('italic', { subsets: ['latin'] });
export const { fontFamily: MONO } = loadMono('normal', { weights: ['400', '500', '700'], subsets: ['latin'] });

/** Inline's own palette (app/styles/base.css). */
export const C = {
  bg: '#f6f5f2',
  sunken: '#efeee9',
  surface: '#ffffff',
  border: '#e5e3dd',
  borderStrong: '#d4d1c9',
  text: '#1f1e1c',
  muted: '#75726b',
  faint: '#a19e96',
  accent: '#c96442',
  accentSoft: '#f6e8e2',
  accentText: '#9c4a2f',
  green: '#2f7d4f',
  insert: 'rgba(46, 160, 67, 0.16)',
  insertLine: '#2ea043',
  deleteBg: 'rgba(218, 54, 51, 0.1)',
  deleteText: '#b4332f',
  ink: '#191816',
};

export const EASE = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_IO = Easing.bezier(0.65, 0, 0.35, 1);

/** 0 → 1 between `start` and `start + dur` frames. */
export function prog(frame: number, start: number, dur: number, easing = EASE): number {
  return interpolate(frame, [start, start + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing });
}

/** Fade + rise + unblur entrance, optional exit. */
export function enter(frame: number, at: number, opts: { dur?: number; y?: number; out?: number; outDur?: number } = {}): React.CSSProperties {
  const { dur = 22, y = 22, out, outDur = 14 } = opts;
  const p = prog(frame, at, dur);
  const o = out === undefined ? 0 : prog(frame, out, outDur, EASE_IO);
  return { opacity: p * (1 - o), transform: `translateY(${(1 - p) * y - o * 8}px)`, filter: `blur(${(1 - p) * 6 + o * 4}px)` };
}

type Line = { text: string; src: string; at: number; end: number; clipFrom: number };
type SceneTiming = { id: string; from: number; frames: number; lines: Line[] };
export const TIMELINE = timeline as { fps: number; frames: number; scenes: SceneTiming[] };

/** The frame (scene-relative) each narration sentence of a scene starts on. */
export function useLines(id: string): number[] {
  return TIMELINE.scenes.find((s) => s.id === id)!.lines.map((l) => l.at);
}
export function sceneFrames(id: string): number {
  return TIMELINE.scenes.find((s) => s.id === id)!.frames;
}

export const Background: React.FC<{ tone?: 'light' | 'warm' }> = ({ tone = 'light' }) => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const x1 = 18 + Math.sin(t / 7) * 6;
  const y1 = 12 + Math.cos(t / 9) * 5;
  const x2 = 84 + Math.cos(t / 8) * 6;
  const y2 = 88 + Math.sin(t / 6) * 4;
  return (
    <AbsoluteFill style={{ background: tone === 'warm' ? '#f4efe7' : C.bg }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(1000px 700px at ${x1}% ${y1}%, rgba(201,100,66,0.10), transparent 70%), radial-gradient(900px 650px at ${x2}% ${y2}%, rgba(201,140,90,0.10), transparent 70%)`,
        }}
      />
      <AbsoluteFill
        style={{
          opacity: 0.55,
          backgroundImage: 'radial-gradient(rgba(31,30,28,0.07) 1px, transparent 1px)',
          backgroundSize: '26px 26px',
          maskImage: 'radial-gradient(ellipse at center, black 25%, transparent 75%)',
        }}
      />
    </AbsoluteFill>
  );
};

/** Section label above product scenes. */
export const Chapter: React.FC<{ index: string; label: string; at?: number; out?: number; top?: number }> = ({ index, label, at = 4, out, top = 40 }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', top, left: 0, right: 0, display: 'flex', justifyContent: 'center', ...enter(frame, at, { out, y: 10 }) }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 18px 8px 9px',
          borderRadius: 999,
          background: 'rgba(255,255,255,0.85)',
          border: `1px solid ${C.border}`,
          boxShadow: '0 6px 20px -8px rgba(31,30,28,0.18)',
          fontFamily: SANS,
          fontSize: 18,
          color: C.muted,
        }}
      >
        <span style={{ background: C.accentSoft, color: C.accentText, borderRadius: 999, padding: '3px 10px', fontWeight: 600, fontSize: 14 }}>{index}</span>
        <span style={{ color: C.text, fontWeight: 500 }}>{label}</span>
      </div>
    </div>
  );
};

// ---------- The app window and its camera ----------

export interface CamKey {
  at: number;
  /** Focus point in app CSS px (1440x900). */
  f: [number, number];
  s: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A layer of the window's content: a still from public/shots or a stretch of a recording in public/rec. */
export type Layer =
  | { img: string; at: number; fade?: number }
  | { rec: string; at: number; from: number; to: number; rate?: number; fade?: number };

export const WIN = { x: 240, y: 124, w: 1440, h: 900 };

function camAt(keys: CamKey[], frame: number): { f: [number, number]; s: number } {
  if (keys.length === 0) return { f: [720, 450], s: 1 };
  if (frame <= keys[0].at) return keys[0];
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (frame <= b.at) {
      if (b.at === a.at) return b;
      const p = interpolate(frame, [a.at, b.at], [0, 1], { easing: EASE_IO, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
      return { f: [a.f[0] + (b.f[0] - a.f[0]) * p, a.f[1] + (b.f[1] - a.f[1]) * p], s: a.s + (b.s - a.s) * p };
    }
  }
  return keys[keys.length - 1];
}

/** Camera move: hold `from` until `at`, then ease to the new focus over `dur` frames. */
export const cam = (...moves: [number, number, number, number][]): CamKey[] => moves.map(([at, x, y, s]) => ({ at, f: [x, y], s }));

/** Maps an app point to screen space for the current camera. */
export function makeMapper(keys: CamKey[], frame: number, win = WIN, scale = 1) {
  const { f, s } = camAt(keys, frame);
  return (x: number, y: number): [number, number] => [win.x + (f[0] + (x - f[0]) * s) * scale, win.y + (f[1] + (y - f[1]) * s) * scale];
}

const layerLen = (l: Layer) => ('rec' in l ? Math.round(((l.to - l.from) / (l.rate ?? 1)) * 30) : Infinity);

/** The layer in view at `frame`: the latest one that has started. */
function layersAt(layers: Layer[], frame: number) {
  return layers.map((l, i) => ({ l, i, op: i === 0 ? 1 : prog(frame, l.at, l.fade ?? 12, EASE_IO) })).filter(({ l, op }, i, all) => op > 0 && !all.slice(i + 1).some((n) => frame >= n.l.at + (n.l.fade ?? 12)));
}

const TrafficLights: React.FC = () => (
  <div style={{ position: 'absolute', left: 16, top: 15, display: 'flex', gap: 8, zIndex: 5 }}>
    {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
      <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c, boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.15)' }} />
    ))}
  </div>
);

/** Content of the window: stills and recordings crossfading, in app CSS px. */
export const WindowContent: React.FC<{ layers: Layer[]; covers?: (Box & { from: number; to?: number; color?: string })[] }> = ({ layers, covers = [] }) => {
  const frame = useCurrentFrame();
  return (
    <>
      {layersAt(layers, frame).map(({ l, i, op }) => (
        <div key={i} style={{ position: 'absolute', inset: 0, opacity: op }}>
          {'img' in l ? (
            <Img src={staticFile(`shots/${l.img}.png`)} style={{ width: 1440, height: 900 }} />
          ) : (
            <Sequence from={l.at} layout="none">
              <Freeze frame={layerLen(l) - 1} active={(f) => f >= layerLen(l) - 1}>
                <OffthreadVideo muted src={staticFile(`rec/${l.rec}.mp4`)} trimBefore={Math.round(l.from * 30)} playbackRate={l.rate ?? 1} style={{ width: 1440, height: 900 }} />
              </Freeze>
            </Sequence>
          )}
        </div>
      ))}
      {covers
        .filter((c) => frame >= c.from && (c.to === undefined || frame < c.to))
        .map((c, i) => (
          <div key={`c${i}`} style={{ position: 'absolute', left: c.x, top: c.y, width: c.w, height: c.h, background: c.color ?? '#fff' }} />
        ))}
    </>
  );
};

/** The Inline desktop window (hidden-inset title bar, so the traffic lights sit on the app). */
export const AppWindow: React.FC<{
  layers: Layer[];
  cam?: CamKey[];
  intro?: number;
  out?: number;
  win?: typeof WIN;
  scale?: number;
  covers?: (Box & { from: number; to?: number; color?: string })[];
  children?: React.ReactNode;
}> = ({ layers, cam: keys = [], intro = 0, out, win = WIN, scale = 1, covers, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { f, s } = camAt(keys, frame);
  const pop = spring({ frame: frame - intro, fps, config: { damping: 200, mass: 0.9 } });
  const o = out === undefined ? 0 : prog(frame, out, 16, EASE_IO);
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: win.x,
          top: win.y,
          width: win.w * scale,
          height: win.h * scale,
          opacity: pop * (1 - o),
          transform: `translateY(${(1 - pop) * 50}px) scale(${0.965 + pop * 0.035})`,
          borderRadius: 14 * scale,
          overflow: 'hidden',
          background: C.bg,
          boxShadow: '0 0 0 1px rgba(31,30,28,0.10), 0 40px 100px -24px rgba(60,40,20,0.35), 0 12px 30px -12px rgba(31,30,28,0.18)',
        }}
      >
        <div style={{ position: 'absolute', left: 0, top: 0, width: 1440, height: 900, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
          <div style={{ position: 'absolute', inset: 0, transformOrigin: `${f[0]}px ${f[1]}px`, transform: `scale(${s})` }}>
            <WindowContent layers={layers} covers={covers} />
          </div>
          <div style={{ position: 'absolute', inset: 0, opacity: interpolate(s, [1, 1.15], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
            <TrafficLights />
          </div>
        </div>
      </div>
      {children}
    </>
  );
};

/** Accent ring around an app-space box plus a label pill, in screen space. */
export const Callout: React.FC<{
  cam: CamKey[];
  box: Box;
  label: string;
  sub?: string;
  at: number;
  out: number;
  side?: 'top' | 'bottom' | 'left' | 'right';
  ring?: boolean;
  win?: typeof WIN;
  scale?: number;
}> = ({ cam: keys, box, label, sub, at, out, side = 'bottom', ring = true, win = WIN, scale = 1 }) => {
  const frame = useCurrentFrame();
  if (frame < at - 2 || frame > out + 20) return null;
  const pt = makeMapper(keys, frame, win, scale);
  const [x1, y1] = pt(box.x, box.y);
  const [x2, y2] = pt(box.x + box.w, box.y + box.h);
  const p = prog(frame, at, 20);
  const o = prog(frame, out, 14, EASE_IO);
  const alpha = p * (1 - o);
  const gap = 18;
  let lx = (x1 + x2) / 2;
  let ly = y2 + gap;
  let tx = '-50%';
  let ty = '0';
  if (side === 'top') {
    ly = y1 - gap;
    ty = '-100%';
  } else if (side === 'left') {
    lx = x1 - gap;
    ly = (y1 + y2) / 2;
    tx = '-100%';
    ty = '-50%';
  } else if (side === 'right') {
    lx = x2 + gap;
    ly = (y1 + y2) / 2;
    tx = '0';
    ty = '-50%';
  }
  const pad = 8;
  return (
    <>
      {ring && (
        <div
          style={{
            position: 'absolute',
            left: x1 - pad,
            top: y1 - pad,
            width: x2 - x1 + pad * 2,
            height: y2 - y1 + pad * 2,
            borderRadius: 14,
            border: `2.5px solid ${C.accent}`,
            boxShadow: '0 0 0 6px rgba(201,100,66,0.12)',
            opacity: alpha,
            transform: `scale(${1.03 - p * 0.03})`,
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          left: lx,
          top: ly,
          transform: `translate(${tx}, ${ty}) translateY(${(1 - p) * 8}px)`,
          opacity: alpha,
          background: C.ink,
          borderRadius: 12,
          padding: sub ? '11px 18px 12px' : '10px 18px',
          fontFamily: SANS,
          color: '#fff',
          fontSize: 21,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          boxShadow: '0 18px 40px -12px rgba(31,30,28,0.45)',
          letterSpacing: -0.2,
        }}
      >
        {label}
        {sub && <div style={{ fontSize: 16, fontWeight: 400, color: 'rgba(255,255,255,0.7)', marginTop: 3 }}>{sub}</div>}
      </div>
    </>
  );
};

/** Keyboard shortcut chip, bottom center of the screen. */
export const KeyHint: React.FC<{ at: number; keys: string[]; label: string; hold?: number; bottom?: number }> = ({ at, keys, label, hold = 60, bottom = 86 }) => {
  const frame = useCurrentFrame();
  const d = frame - at;
  if (d < -12 || d > hold + 16) return null;
  const p = prog(frame, at - 12, 14);
  const o = prog(frame, at + hold, 14, EASE_IO);
  const press = d >= 0 && d < 9 ? 1 - d / 9 : 0;
  return (
    <div style={{ position: 'absolute', bottom, left: 0, right: 0, display: 'flex', justifyContent: 'center', opacity: p * (1 - o) }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: C.ink,
          borderRadius: 16,
          padding: '10px 20px 10px 12px',
          fontFamily: SANS,
          color: '#fff',
          fontSize: 21,
          fontWeight: 500,
          transform: `translateY(${(1 - p) * 14}px)`,
          boxShadow: '0 20px 50px -14px rgba(31,30,28,0.5)',
        }}
      >
        {keys.map((k) => (
          <span
            key={k}
            style={{
              minWidth: 40,
              textAlign: 'center',
              padding: '5px 11px',
              borderRadius: 9,
              background: press > 0 ? C.accent : '#34322e',
              border: '1px solid #4a4741',
              boxShadow: `0 ${3 - press * 2}px 0 #0d0c0b`,
              transform: `translateY(${press * 2}px)`,
              fontWeight: 600,
            }}
          >
            {k}
          </span>
        ))}
        <span style={{ marginLeft: 6 }}>{label}</span>
      </div>
    </div>
  );
};

/** Lower-left feature chip that names what's on screen. */
export const Tag: React.FC<{ at: number; out: number; text: string; x?: number; y?: number }> = ({ at, out, text, x = 120, y = 960 }) => {
  const frame = useCurrentFrame();
  if (frame < at - 2 || frame > out + 20) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        ...enter(frame, at, { out, y: 12, dur: 16 }),
        background: C.ink,
        color: '#fff',
        fontFamily: SANS,
        fontSize: 22,
        fontWeight: 600,
        padding: '10px 18px',
        borderRadius: 12,
        boxShadow: '0 18px 40px -12px rgba(31,30,28,0.45)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 4, background: C.accent }} />
      {text}
    </div>
  );
};

export const Logo: React.FC<{ size: number; style?: React.CSSProperties }> = ({ size, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={style}>
    <rect x="2" y="2" width="20" height="20" rx="6" fill={C.accent} />
    <path d="M8 7.5h8M8 12h8M8 16.5h5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

/** Wraps a scene with a soft crossfade at both ends. */
export const SceneFade: React.FC<{ dur: number; over: number; children: React.ReactNode }> = ({ dur, over, children }) => {
  const frame = useCurrentFrame();
  const fin = prog(frame, 0, over, EASE_IO);
  const fout = prog(frame, dur, over, EASE_IO);
  return <AbsoluteFill style={{ opacity: fin * (1 - fout) }}>{children}</AbsoluteFill>;
};

/** Big serif headline used in story scenes. */
export const Headline: React.FC<{ children: React.ReactNode; at: number; out?: number; size?: number; style?: React.CSSProperties }> = ({ children, at, out, size = 64, style }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ fontFamily: SERIF, fontSize: size, lineHeight: 1.08, color: C.text, letterSpacing: -0.5, ...enter(frame, at, { out, y: 18, dur: 26 }), ...style }}>{children}</div>
  );
};
