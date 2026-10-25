import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

import { AppWindow, Background, C, EASE_IO, Headline, Logo, MONO, SANS, SERIF, enter, prog, sceneFrames, useLines } from '../ui';

// ---------- Shared pieces ----------

/** A sheet of paper with a short document on it, in the thesis' typography. */
export const Paper: React.FC<{ w: number; style?: React.CSSProperties; edit?: number; children?: React.ReactNode }> = ({ w, style, edit, children }) => {
  const frame = useCurrentFrame();
  const k = w / 520;
  const line = (width: number, key: number, color = '#d9d5cd') => <div key={key} style={{ height: 7 * k, width: `${width}%`, background: color, borderRadius: 4 * k, marginBottom: 9 * k }} />;
  const e = edit === undefined ? 0 : prog(frame, edit, 26);
  return (
    <div style={{ width: w, height: w * 1.294, background: '#fff', borderRadius: 6 * k, boxShadow: '0 1px 2px rgba(31,30,28,0.06), 0 30px 80px -20px rgba(60,40,20,0.30)', padding: `${56 * k}px ${58 * k}px`, boxSizing: 'border-box', position: 'relative', ...style }}>
      <div style={{ fontFamily: 'Georgia, serif', fontSize: 25 * k, color: '#202124', lineHeight: 1.15 }}>Living Shorelines in a Changing Climate</div>
      <div style={{ fontFamily: 'Georgia, serif', fontSize: 13 * k, color: '#75726b', marginTop: 6 * k, marginBottom: 22 * k }}>Measuring how oyster reefs and salt marshes protect the coast</div>
      <div style={{ fontFamily: 'Georgia, serif', fontSize: 15 * k, color: '#202124', marginBottom: 10 * k }}>Introduction</div>
      <div style={{ fontFamily: 'Georgia, serif', fontSize: 11.5 * k, color: '#202124', lineHeight: 1.55, marginBottom: 14 * k }}>
        Every year, coastal communities spend millions on seawalls that hold back erosion but cut the shoreline off from its habitats.{' '}
        <span style={{ position: 'relative', color: e > 0 ? C.deleteText : '#202124', background: e > 0 ? `rgba(218,54,51,${0.1 * e})` : 'transparent', textDecoration: e > 0.3 ? 'line-through' : 'none' }}>
          It has become increasingly important to understand whether there might be better alternatives.
        </span>
        {e > 0 && (
          <span style={{ background: C.insert, borderBottom: `${1.5 * k}px solid ${C.insertLine}`, opacity: e }}>
            {' '}
            {'We need better alternatives.'.slice(0, Math.round(e * 28))}
          </span>
        )}
      </div>
      {[96, 92, 99, 60].map((wd, i) => line(wd, i))}
      <div style={{ height: 12 * k }} />
      <div style={{ fontFamily: 'Georgia, serif', fontSize: 15 * k, color: '#202124', marginBottom: 10 * k }}>Methods</div>
      {[98, 94, 97, 88, 45].map((wd, i) => line(wd, 10 + i))}
      <div style={{ textAlign: 'center', fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: 15 * k, color: '#202124', margin: `${14 * k}px 0` }}>H(x) = H₀ e⁻ᵏˣ</div>
      {[95, 90, 70].map((wd, i) => line(wd, 20 + i))}
      {children}
    </div>
  );
};

// ---------- 1. Cold open ----------

const MD = [
  ['#', ' Living Shorelines'],
  ['', ''],
  ['##', ' Introduction'],
  ['', 'Every year, coastal communities spend'],
  ['', 'millions on seawalls that hold back'],
  ['-', 'erosion. It has become increasingly'],
  ['-', 'important to understand whether there'],
  ['-', 'might be better alternatives.'],
  ['+', 'erosion. We need better alternatives.'],
  ['', ''],
  ['##', ' Methods'],
  ['', 'Pressure sensors at three sites, 4 Hz.'],
];

const CodeEditor: React.FC<{ diff: number; steps: number }> = ({ diff, steps }) => {
  const frame = useCurrentFrame();
  const STEPS = ['Read 14 files', 'Edited proposal.md', 'Ran the checks', 'All 42 tests pass'];
  return (
    <div style={{ width: 1000, height: 600, borderRadius: 16, background: '#1d1c1a', boxShadow: '0 40px 100px -24px rgba(31,30,28,0.55)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 44, background: '#262522', display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderBottom: '1px solid #33312d' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
          <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
        ))}
        <div style={{ marginLeft: 18, fontFamily: SANS, fontSize: 15, color: '#d8d4cc', background: '#1d1c1a', padding: '7px 14px', borderRadius: '8px 8px 0 0', marginTop: 10 }}>proposal.md</div>
        <div style={{ fontFamily: SANS, fontSize: 15, color: '#8b877e', padding: '7px 14px', marginTop: 10 }}>analysis.py</div>
      </div>
      <div style={{ display: 'flex', flex: 1 }}>
        <div style={{ flex: 1, padding: '22px 0', fontFamily: MONO, fontSize: 18, lineHeight: '31px' }}>
          {MD.map(([mark, text], i) => {
            const removed = mark === '-';
            const added = mark === '+';
            if (added && diff <= 0) return null;
            const bg = removed && diff > 0 ? `rgba(218,54,51,${0.22 * diff})` : added ? `rgba(46,160,67,${0.25 * diff})` : 'transparent';
            const shown = added ? text.slice(0, Math.round(text.length * Math.min(1, diff * 1.4))) : text;
            return (
              <div key={i} style={{ display: 'flex', background: bg, opacity: added ? Math.min(1, diff * 3) : 1 }}>
                <span style={{ width: 54, textAlign: 'right', paddingRight: 18, color: '#5d5a54' }}>{i + 1}</span>
                <span style={{ width: 18, color: removed ? '#ff7b72' : added ? '#7ee787' : 'transparent' }}>{removed && diff > 0 ? '-' : added ? '+' : ' '}</span>
                <span style={{ color: mark.startsWith('#') ? '#e3a37f' : removed && diff > 0 ? '#ffb3ad' : added ? '#b4f0bd' : '#d8d4cc' }}>
                  {mark.startsWith('#') ? mark : ''}
                  {shown}
                </span>
              </div>
            );
          })}
        </div>
        <div style={{ width: 300, borderLeft: '1px solid #33312d', background: '#22211e', padding: 22, fontFamily: SANS }}>
          <div style={{ color: '#8b877e', fontSize: 13, letterSpacing: 1, fontWeight: 600, marginBottom: 14 }}>AGENT</div>
          <div style={{ background: '#2e2c28', color: '#ece8e0', borderRadius: 12, padding: '12px 14px', fontSize: 16, lineHeight: 1.4, marginBottom: 18 }}>Tighten the introduction.</div>
          {STEPS.map((s, i) => {
            const p = prog(frame, steps + i * 26, 14);
            return (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#d8d4cc', fontSize: 16, marginBottom: 12, opacity: p, transform: `translateX(${(1 - p) * 10}px)` }}>
                <span style={{ width: 20, height: 20, borderRadius: 10, background: 'rgba(126,231,135,0.18)', color: '#7ee787', fontSize: 13, display: 'grid', placeItems: 'center', fontWeight: 700 }}>✓</span>
                {s}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const OpenScene: React.FC = () => {
  const frame = useCurrentFrame();
  const [l0, l1, l2, l3] = useLines('open');
  const inP = prog(frame, 0, 30);
  const split = prog(frame, l2 - 10, 34, EASE_IO);
  const solo = prog(frame, l3 - 6, 34, EASE_IO);
  const diff = prog(frame, l1 + 40, 60);
  const pageIn = prog(frame, l2 + 6, 30);
  const edX = 960 - split * 430 - solo * 260;
  const edS = 1 - split * 0.32;
  const pageX = 960 + 420 * (1 - solo);
  const pageS = 0.8 + solo * 0.25;
  return (
    <AbsoluteFill>
      <Background />
      <div style={{ position: 'absolute', top: 92, left: 0, right: 0, textAlign: 'center' }}>
        <Headline at={l0} out={l2 - 16} size={58}>
          In a code editor, an agent can do anything.
        </Headline>
      </div>
      <div style={{ position: 'absolute', top: 92, left: 0, right: 0, textAlign: 'center' }}>
        <Headline at={l2} out={l3 - 10} size={58}>
          But the writing that matters isn't there.
        </Headline>
      </div>
      <div style={{ position: 'absolute', top: 92, left: 0, right: 0, textAlign: 'center' }}>
        <Headline at={l3} size={64}>
          It lives on the <span style={{ fontStyle: 'italic', color: C.accent }}>page.</span>
        </Headline>
      </div>
      <div
        style={{
          position: 'absolute',
          left: edX,
          top: 600,
          transform: `translate(-50%, -50%) scale(${edS * (0.96 + inP * 0.04)})`,
          opacity: inP * (1 - solo),
          filter: `blur(${solo * 6}px)`,
        }}
      >
        <CodeEditor diff={diff} steps={l1 + 70} />
      </div>
      {/* A dashed gap between the agent and the page: it can't reach it. */}
      <div style={{ position: 'absolute', left: 820, top: 596, width: 280, opacity: pageIn * (1 - solo), display: 'flex', alignItems: 'center', gap: 0 }}>
        <div style={{ flex: 1, borderTop: `3px dashed ${C.borderStrong}` }} />
        <div style={{ width: 44, height: 44, borderRadius: 22, background: '#fff', border: `1.5px solid ${C.border}`, display: 'grid', placeItems: 'center', color: C.deleteText, fontFamily: SANS, fontSize: 22, fontWeight: 700, boxShadow: '0 8px 20px -8px rgba(0,0,0,0.25)' }}>✕</div>
        <div style={{ flex: 1, borderTop: `3px dashed ${C.borderStrong}` }} />
      </div>
      <div style={{ position: 'absolute', left: pageX, top: 600 + solo * 30, transform: `translate(-50%, -50%) scale(${pageS})`, opacity: pageIn }}>
        <Paper w={520} />
      </div>
    </AbsoluteFill>
  );
};

// ---------- 2. Title ----------

export const TitleScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - 4, fps, config: { damping: 14, mass: 0.8 } });
  const word = prog(frame, 16, 26);
  const tag = prog(frame, 44, 30);
  const pageOut = prog(frame, 0, 20, EASE_IO);
  return (
    <AbsoluteFill>
      <Background />
      <div style={{ position: 'absolute', left: 960, top: 630, transform: `translate(-50%, -50%) scale(${1.05 - pageOut * 0.6})`, opacity: 1 - pageOut }}>
        <Paper w={520} />
      </div>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 34, marginTop: -40 }}>
          <div style={{ transform: `scale(${pop})`, filter: 'drop-shadow(0 18px 30px rgba(201,100,66,0.35))' }}>
            <Logo size={150} />
          </div>
          <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 150, letterSpacing: -6, color: C.text, opacity: word, transform: `translateX(${(1 - word) * -24}px)`, clipPath: `inset(0 ${(1 - word) * 100}% 0 0)` }}>Inline</div>
        </div>
        <div style={{ fontFamily: SERIF, fontSize: 50, color: C.muted, marginTop: 26, ...enter(frame, 44, { y: 14 }) }}>
          Real documents, with <span style={{ color: C.text }}>Claude Code</span> and <span style={{ color: C.text }}>Codex</span> built in.
        </div>
        <div style={{ opacity: tag }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ---------- 3. The idea ----------

const TOOLS = ['read_document', 'edit_document', 'add_comment', 'format_text', 'insert_content', 'search_document', 'save_version', 'screenshot_page', 'get_outline', 'reply_to_comment', 'export_document', 'analyze_writing', 'set_paragraph_style', 'list_versions'];

const Node: React.FC<{ x: number; y: number; at: number; children: React.ReactNode; label: string; sub?: string }> = ({ x, y, at, children, label, sub }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: 'translate(-50%, -50%)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', ...enter(frame, at, { y: 16 }) }}>
        {children}
        <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 26, color: C.text, marginTop: 18 }}>{label}</div>
        {sub && <div style={{ fontFamily: SANS, fontSize: 18, color: C.muted, marginTop: 4 }}>{sub}</div>}
      </div>
    </div>
  );
};

export const IdeaScene: React.FC = () => {
  const frame = useCurrentFrame();
  const [l0, l1, l2, l3] = useLines('idea');
  const lineP = prog(frame, l0 + 30, 30);
  const count = Math.round(interpolate(frame, [l1 + 20, l1 + 90], [0, 40], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  const review = prog(frame, l2 + 30, 18);
  const PX = 960;
  const PY = 560;
  return (
    <AbsoluteFill>
      <Background />
      <div style={{ position: 'absolute', top: 70, left: 0, right: 0, textAlign: 'center' }}>
        <Headline at={l0} size={60}>
          A real document editor, with the agent <span style={{ fontStyle: 'italic', color: C.accent }}>built in.</span>
        </Headline>
      </div>
      {/* Connectors */}
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
        <line x1={470} y1={PY} x2={470 + (PX - 230 - 470) * lineP} y2={PY} stroke={C.borderStrong} strokeWidth={3} strokeDasharray="2 10" strokeLinecap="round" />
        <line x1={1450} y1={PY} x2={1450 - (1450 - PX - 230) * lineP} y2={PY} stroke={C.accent} strokeOpacity={0.5} strokeWidth={3} strokeDasharray="2 10" strokeLinecap="round" />
      </svg>
      <Node x={360} y={PY - 30} at={l0 + 10} label="You" sub="type, format, comment">
        <div style={{ width: 120, height: 120, borderRadius: 60, background: '#fff', border: `1px solid ${C.border}`, display: 'grid', placeItems: 'center', fontFamily: SANS, fontWeight: 600, fontSize: 40, color: C.accentText, boxShadow: '0 20px 40px -18px rgba(60,40,20,0.35)' }}>JL</div>
      </Node>
      <Node x={1560} y={PY - 30} at={l0 + 18} label="The agent" sub={count > 0 ? `${count}+ document tools` : 'Claude Code · Codex'}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[['Claude Code', '#d97757'], ['Codex', '#1f1e1c']].map(([name, color]) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 20px', fontFamily: SANS, fontWeight: 600, fontSize: 22, color: C.text, boxShadow: '0 14px 30px -16px rgba(60,40,20,0.35)' }}>
              <span style={{ width: 12, height: 12, borderRadius: 6, background: color }} />
              {name}
            </div>
          ))}
        </div>
      </Node>
      {/* Tool calls travel from the agent to the page. */}
      {TOOLS.map((t, i) => {
        const start = l1 + 10 + i * 13;
        const p = prog(frame, start, 46, EASE_IO);
        if (p <= 0 || p >= 1) return null;
        const x = 1440 - p * (1440 - (PX + 240));
        const y = PY + ((i % 3) - 1) * 44;
        return (
          <div key={t} style={{ position: 'absolute', left: x, top: y, transform: 'translate(-100%, -50%)', opacity: Math.min(1, p * 5, (1 - p) * 5), fontFamily: MONO, fontSize: 17, color: C.accentText, background: C.accentSoft, border: '1px solid rgba(201,100,66,0.25)', borderRadius: 8, padding: '5px 10px', whiteSpace: 'nowrap' }}>
            {t}
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: PX, top: PY + 30, transform: 'translate(-50%, -50%)' }}>
        <div style={enter(frame, l0 + 4, { y: 20 })}>
        <Paper w={430} edit={l2 + 4}>
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 24,
              transform: `translate(-50%, ${(1 - review) * 12}px)`,
              opacity: review,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: '#fff',
              border: `1px solid ${C.border}`,
              borderRadius: 999,
              padding: '7px 8px 7px 14px',
              boxShadow: '0 12px 30px -12px rgba(0,0,0,0.3)',
              fontFamily: SANS,
              fontSize: 14,
              color: C.text,
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 4, background: C.insertLine }} />1 change by Claude
            <span style={{ color: C.muted, marginLeft: 6 }}>Undo</span>
            <span style={{ background: C.ink, color: '#fff', borderRadius: 999, padding: '5px 12px', fontWeight: 600 }}>Keep</span>
          </div>
        </Paper>
        </div>
      </div>
      <div style={{ position: 'absolute', bottom: 70, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 14 }}>
        {['Free', 'Open source', 'MIT license', 'github.com/Naimy441/Inline'].map((b, i) => (
          <div key={b} style={{ ...enter(frame, l3 + i * 6, { y: 12 }), fontFamily: i === 3 ? MONO : SANS, fontSize: 21, fontWeight: 600, color: i === 3 ? C.accentText : C.text, background: i === 3 ? C.accentSoft : '#fff', border: `1px solid ${i === 3 ? 'rgba(201,100,66,0.25)' : C.border}`, borderRadius: 999, padding: '10px 20px' }}>
            {b}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

// ---------- 4. Desktop app ----------

const AppleGlyph: React.FC<{ size: number; color?: string }> = ({ size, color = C.text }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path
      fill={color}
      d="M16.37 1.43c0 1.14-.47 2.27-1.18 3.09-.76.88-2 1.56-3.03 1.48-.13-1.1.42-2.27 1.12-3.03.78-.86 2.12-1.5 3.09-1.54zM20.5 17.2c-.55 1.27-.82 1.84-1.53 2.96-.99 1.56-2.39 3.5-4.12 3.51-1.54.02-1.94-1-4.03-.99-2.09.01-2.53 1.01-4.07.99-1.73-.02-3.05-1.77-4.04-3.33C-.07 16.07-.36 11 1.37 8.3c1.23-1.92 3.17-3.04 4.99-3.04 1.86 0 3.03 1.02 4.56 1.02 1.49 0 2.4-1.02 4.55-1.02 1.62 0 3.34.88 4.57 2.41-4.02 2.2-3.36 7.94.46 9.53z"
    />
  </svg>
);
const WindowsGlyph: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path fill="#2b78d4" d="M2 4.5l8-1.1v7.7H2zM11 3.3L22 1.8v9.3H11zM2 12h8v7.7l-8-1.1zM11 12h11v9.3L11 19.8z" />
  </svg>
);
const LinuxGlyph: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <rect x="2" y="4" width="20" height="16" rx="3" fill="#1f1e1c" />
    <path d="M6 9l3 3-3 3M11 15h6" stroke="#fcc624" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Platforms: React.FC<{ at: number; size?: number }> = ({ at, size = 22 }) => {
  const frame = useCurrentFrame();
  const items: [React.ReactNode, string][] = [
    [<AppleGlyph key="a" size={size} />, 'macOS'],
    [<WindowsGlyph key="w" size={size} />, 'Windows'],
    [<LinuxGlyph key="l" size={size} />, 'Linux'],
  ];
  return (
    <div style={{ display: 'flex', gap: 14 }}>
      {items.map(([icon, name], i) => (
        <div key={name} style={{ ...enter(frame, at + i * 6, { y: 12 }), display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: `${size * 0.5}px ${size * 0.9}px`, fontFamily: SANS, fontWeight: 600, fontSize: size, color: C.text, boxShadow: '0 12px 30px -16px rgba(60,40,20,0.3)' }}>
          {icon}
          {name}
        </div>
      ))}
    </div>
  );
};

const DOCK = ['#5aa0f0', '#f0b04a', '#7bc67b', '#e46a6a', '#9b8cf0', 'inline', '#4fc1c9'];

export const DesktopScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [l0, l1] = useLines('desktop');
  const bounce = Math.abs(Math.sin(Math.min(1, Math.max(0, (frame - 8) / 30)) * Math.PI * 2)) * (1 - prog(frame, 8, 34)) * 26;
  const open = spring({ frame: frame - 34, fps, config: { damping: 200, mass: 1 } });
  const s = 0.08 + open * 0.64;
  const dockX = 960 + (5 - 3) * 86;
  const cx = dockX + (960 - dockX) * open;
  const cy = 1010 + (500 - 1010) * open;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: 'linear-gradient(160deg, #f3d9c4 0%, #e9b598 35%, #c98a6c 70%, #8f5a48 100%)' }} />
      <AbsoluteFill style={{ background: 'radial-gradient(1200px 700px at 30% 20%, rgba(255,255,255,0.35), transparent 70%)' }} />
      {/* Menu bar */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 34, background: 'rgba(255,248,242,0.55)', backdropFilter: 'blur(20px)', display: 'flex', alignItems: 'center', padding: '0 20px', gap: 22, fontFamily: SANS, fontSize: 15, color: '#2a211c' }}>
        <AppleGlyph size={16} color="#2a211c" />
        <b style={{ fontWeight: 700 }}>Inline</b>
        {['File', 'Edit', 'View', 'Window', 'Help'].map((m) => (
          <span key={m}>{m}</span>
        ))}
        <span style={{ marginLeft: 'auto' }}>Sat Oct 24  7:30 PM</span>
      </div>
      {/* Dock */}
      <div style={{ position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 14, padding: 12, borderRadius: 26, background: 'rgba(255,248,242,0.4)', border: '1px solid rgba(255,255,255,0.5)', backdropFilter: 'blur(20px)' }}>
        {DOCK.map((c, i) =>
          c === 'inline' ? (
            <div key={i} style={{ position: 'relative', transform: `translateY(${-bounce}px)` }}>
              <Img src={staticFile('img/icon.png')} style={{ width: 72, height: 72 }} />
              <div style={{ position: 'absolute', bottom: -8, left: 33, width: 6, height: 6, borderRadius: 3, background: '#2a211c', opacity: prog(frame, 20, 10) }} />
            </div>
          ) : (
            <div key={i} style={{ width: 72, height: 72, borderRadius: 17, background: `linear-gradient(160deg, ${c}, ${c}cc)`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.4)' }} />
          ),
        )}
      </div>
      <div style={{ position: 'absolute', left: cx, top: cy, width: 1440, height: 900, transform: `translate(-50%, -50%) scale(${s})`, opacity: Math.min(1, open * 3) }}>
        <AppWindow layers={[{ img: 'home', at: 0 }]} win={{ x: 0, y: 0, w: 1440, h: 900 }} />
      </div>
      <div style={{ position: 'absolute', top: 70, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
        <Platforms at={l0 + 8} />
      </div>
      <div style={{ position: 'absolute', top: 128, left: 0, right: 0, textAlign: 'center', fontFamily: SANS, fontSize: 21, color: '#3a2a22', fontWeight: 500, ...enter(frame, l0 + 40, { y: 10, out: l1 - 6 }) }}>
        Claude Code and Codex included. Nothing else to install.
      </div>
      <div style={{ position: 'absolute', top: 124, left: 0, right: 0, display: 'flex', justifyContent: 'center', ...enter(frame, l1, { y: 10 }) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#fff', borderRadius: 999, padding: '7px 18px 7px 7px', fontFamily: SANS, fontSize: 19, color: C.text, boxShadow: '0 14px 30px -14px rgba(0,0,0,0.35)' }}>
          <span style={{ width: 34, height: 34, borderRadius: 17, background: C.accentSoft, color: C.accentText, display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 14 }}>JL</span>
          <b style={{ fontWeight: 600 }}>Jordan Lee</b>
          <span style={{ color: C.muted }}>grad student and product marketer · 19 documents</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------- Outro ----------

export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [l0, l1, l2] = useLines('outro');
  const pop = spring({ frame: frame - l0 + 10, fps, config: { damping: 14, mass: 0.8 } });
  const end = sceneFrames('outro');
  const fade = prog(frame, end - 40, 40, EASE_IO);
  return (
    <AbsoluteFill style={{ opacity: 1 - fade }}>
      <Background />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 28, marginTop: -60 }}>
          <div style={{ transform: `scale(${pop})`, filter: 'drop-shadow(0 18px 30px rgba(201,100,66,0.35))' }}>
            <Logo size={120} />
          </div>
          <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 120, letterSpacing: -5, color: C.text, ...enter(frame, l0, { y: 0 }) }}>Inline</div>
        </div>
        <div style={{ fontFamily: SERIF, fontSize: 52, color: C.muted, marginTop: 22, ...enter(frame, l1 - 4, { y: 14 }) }}>
          Real documents, with the agent <span style={{ fontStyle: 'italic', color: C.accent }}>built in.</span>
        </div>
        <div style={{ marginTop: 56 }}>
          <Platforms at={l2} size={24} />
        </div>
        <div style={{ marginTop: 30, display: 'flex', gap: 14, alignItems: 'center', ...enter(frame, l2 + 24, { y: 10 }) }}>
          <div style={{ fontFamily: MONO, fontSize: 24, color: C.accentText, background: C.accentSoft, border: '1px solid rgba(201,100,66,0.25)', borderRadius: 12, padding: '10px 18px' }}>github.com/Naimy441/Inline</div>
          <div style={{ fontFamily: SANS, fontSize: 21, color: C.muted }}>Free · Open source · MIT</div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
