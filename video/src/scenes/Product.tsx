import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';

import terminal from '../data/terminal.json';
import { AppWindow, Background, C, Callout, Chapter, EASE_IO, KeyHint, Layer, MONO, SANS, SERIF, Tag, WIN, cam, enter, prog, sceneFrames, useLines } from '../ui';

const FULL = (at = 0): [number, number, number, number] => [at, 720, 450, 1];

// ---------- Home ----------

export const HomeScene: React.FC = () => {
  const [l0, l1, l2, l3] = useLines('home');
  const keys = cam(FULL(0), FULL(l2 - 20), [l2 + 10, 720, 230, 1.22], [l3 - 30, 720, 230, 1.22], FULL(l3 - 4));
  const layers: Layer[] = [
    { rec: 'home-tour', at: 0, from: 0.9, to: 7.2 },
    { img: 'home', at: l2 - 16, fade: 14 },
    { rec: 'home-tour', at: l3 - 8, from: 12.2, to: 16.1, fade: 10 },
  ];
  return (
    <AbsoluteFill>
      <Background />
      <Chapter index="01" label="Home" />
      <AppWindow layers={layers} cam={keys}>
        <Callout cam={keys} box={{ x: 225, y: 198, w: 789, h: 295 }} label="Color-coded folders" sub="with live page previews" at={l1 + 14} out={l1 + 80} side="bottom" />
        <Callout cam={keys} box={{ x: 218, y: 124, w: 1004, h: 201 }} label="Templates" sub="essays, MLA papers, reports, résumés" at={l2 + 24} out={l3 - 34} side="bottom" />
        <Callout cam={keys} box={{ x: 478, y: 10, w: 559, h: 35 }} label="Search every document" at={l3 + 30} out={sceneFrames('home') - 10} side="bottom" />
      </AppWindow>
    </AbsoluteFill>
  );
};

// ---------- Editor ----------

export const EditorScene: React.FC = () => {
  const [l0, l1, l2] = useLines('editor');
  const rate = 4;
  const start = 96;
  const at = (src: number) => start + Math.round((src / rate) * 30);
  // The first frame holds until `start`, then the scroll plays at `rate`.
  const layers: Layer[] = [
    { rec: 'editor-scroll', at: 0, from: 0, to: 0.034 },
    { rec: 'editor-scroll', at: start, from: 0, to: 56, rate, fade: 1 },
    { img: 'thesis-dark', at: at(56) + 30, fade: 18 },
  ];
  const tags: [number, string][] = [
    [at(1.5), 'Live table of contents'],
    [at(13), 'Citations'],
    [at(19), 'Headers and page numbers'],
    [at(24), 'LaTeX equations'],
    [at(27.5), 'Tables'],
    [at(34), 'Figures'],
    [at(49), 'References'],
    [at(56) + 36, 'Light or dark'],
  ];
  return (
    <AbsoluteFill>
      <Background />
      <Chapter index="02" label="Real pages" />
      <AppWindow layers={layers} />
      {tags.map(([t, text], i) => (
        <Tag key={text} at={t} out={(tags[i + 1]?.[0] ?? sceneFrames('editor')) - 12} text={text} x={WIN.x + 28} y={WIN.y + 900 - 76} />
      ))}
    </AbsoluteFill>
  );
};

// ---------- Claude in the document ----------

export const ChatScene: React.FC = () => {
  const [l0, l1, l2, l3, l4, l5] = useLines('chat');
  const recAt = l1 - 26;
  const rate = 1.25;
  const src = (t: number) => recAt + Math.round(((t - 1.0) / rate) * 30);
  const keepAt = l5 + 34;
  const keys = cam(FULL(0), FULL(l3 - 10), [l3 + 20, 510, 760, 1.32], [l4 - 20, 510, 760, 1.32], [l4 + 14, 1180, 520, 1.45], [l5 - 10, 1180, 520, 1.45], FULL(l5 + 20));
  const layers: Layer[] = [
    { img: 'thesis-top', at: 0 },
    { img: 'chat-empty', at: l0 + 14, fade: 10 },
    { rec: 'chat-tighten', at: recAt, from: 1.0, to: 19.6, rate, fade: 6 },
    { rec: 'keep-all', at: keepAt, from: 0.6, to: 4.3, fade: 8 },
  ];
  return (
    <AbsoluteFill>
      <Background />
      <Chapter index="03" label="Claude in the document" />
      {/* The account's usage-limit notice is hidden in the later footage; cover it here too. */}
      <AppWindow layers={layers} cam={keys} covers={[{ x: 1036, y: 744, w: 404, h: 48, from: src(12.7), to: keepAt + 8 }]}>
        <Callout cam={keys} box={{ x: 1036, y: 455, w: 392, h: 125 }} label="It spotted a citation that doesn't match" side="left" at={l4 + 24} out={l5 - 14} />
        <Callout cam={keys} box={{ x: 296, y: 842, w: 424, h: 42 }} label="Keep or undo, one at a time or all at once" side="top" at={keepAt - 6} out={keepAt + 52} />
      </AppWindow>
      <KeyHint at={l0 + 6} keys={['⌘', 'J']} label="Open Claude" hold={50} />
      <Tag at={l3 + 26} out={l4 - 16} text="Deletions struck through, additions highlighted" x={WIN.x + 28} y={WIN.y + 900 - 76} />
    </AbsoluteFill>
  );
};

// ---------- Ask about a selection ----------

export const SelectScene: React.FC = () => {
  const [l0, l1] = useLines('select');
  const end = sceneFrames('select');
  const fast = 222;
  const rate = 3.4;
  const fastEnd = fast + Math.round(((53.3 - 7.4) / rate) * 30);
  const keys = cam(FULL(0), FULL(fastEnd - 40), [fastEnd - 10, 760, 470, 1.18]);
  const layers: Layer[] = [
    { rec: 'select-ask', at: 0, from: 0.2, to: 7.6 },
    { rec: 'select-ask', at: fast, from: 7.6, to: 53.3, rate, fade: 2 },
    { img: 'select-done', at: fastEnd - 4, fade: 8 },
  ];
  return (
    <AbsoluteFill>
      <Background />
      <Chapter index="04" label="Ask about a selection" />
      <AppWindow layers={layers} cam={keys}>
        <Callout cam={keys} box={{ x: 150, y: 442, w: 712, h: 104 }} label="Rewritten to match the paper" side="bottom" at={fastEnd + 4} out={end - 6} />
        <Callout cam={keys} box={{ x: 1034, y: 584, w: 390, h: 42 }} label="With its sources" side="top" at={fastEnd + 24} out={end - 6} ring />
      </AppWindow>
      <KeyHint at={70} keys={['⌘', 'L']} label="Ask about the selection" hold={70} />
    </AbsoluteFill>
  );
};

// ---------- Comments ----------

export const CommentsScene: React.FC = () => {
  const [l0, l1, l2] = useLines('comments');
  const recAt = l2 - 12;
  const rate = 2.9;
  const recEnd = recAt + Math.round(((34.6 - 1.0) / rate) * 30);
  const end = sceneFrames('comments');
  const layers: Layer[] = [
    { img: 'comments-panel', at: 0 },
    { rec: 'comments-claude', at: recAt, from: 1.0, to: 34.6, rate, fade: 10 },
    { img: 'comments-replies', at: recEnd, fade: 12 },
  ];
  const keys = cam(FULL(0), FULL(recEnd), [recEnd + 26, 1100, 330, 1.25]);
  return (
    <AbsoluteFill>
      <Background />
      <Chapter index="05" label="Comments" />
      <AppWindow layers={layers} cam={keys}>
        <Callout cam={keys} box={{ x: 1004, y: 138, w: 428, h: 336 }} label="Three notes from my advisor" side="left" at={l1} out={recAt - 6} />
        <Callout cam={keys} box={{ x: 1004, y: 70, w: 428, h: 330 }} label="Fixed, replied to and resolved" side="left" at={recEnd + 30} out={end - 6} ring={false} />
      </AppWindow>
    </AbsoluteFill>
  );
};

// ---------- Versions ----------

export const HistoryScene: React.FC = () => {
  const frame = useCurrentFrame();
  const [l0, l1] = useLines('history');
  const end = sceneFrames('history');
  const layers: Layer[] = [
    { rec: 'history', at: 0, from: 0.3, to: 5.0 },
    { img: 'history-old', at: 141, fade: 10 },
  ];
  const keys = cam(FULL(0));
  const card = prog(frame, l1 + 6, 20);
  return (
    <AbsoluteFill>
      <Background />
      <Chapter index="06" label="Versions" />
      <AppWindow layers={layers} cam={keys}>
        <Callout cam={keys} box={{ x: 1026, y: 282, w: 408, h: 172 }} label="Named versions" side="left" at={40} out={136} />
        <Callout cam={keys} box={{ x: 30, y: 88, w: 960, h: 50 }} label="Compare an old draft, or restore it" side="bottom" at={160} out={l1 - 8} />
      </AppWindow>
      {/* The checkpoint every reply leaves, as the chat shows it. */}
      <div style={{ position: 'absolute', left: WIN.x + 1440 - 470, top: WIN.y + 560, width: 420, opacity: card * (1 - prog(frame, end - 16, 14, EASE_IO)), transform: `translateY(${(1 - card) * 16}px) scale(${0.97 + card * 0.03})`, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '16px 18px', boxShadow: '0 30px 60px -20px rgba(31,30,28,0.4)', fontFamily: SANS }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 17, color: C.text }}>
          <span style={{ color: C.accent }}>✎</span> Edited <b style={{ fontWeight: 600 }}>Living Shorelines…</b>
          <span style={{ marginLeft: 'auto', color: C.green, fontWeight: 600 }}>+14</span>
          <span style={{ color: C.deleteText, fontWeight: 600 }}>−48</span>
        </div>
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 16, color: '#2659c9', fontWeight: 500, background: prog(frame, l1 + 40, 10) > 0.5 ? 'rgba(38,89,201,0.08)' : 'transparent', padding: '4px 8px', borderRadius: 6 }}>↺ Restore to before</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------- Claude or Codex ----------

export const ProvidersScene: React.FC = () => {
  const frame = useCurrentFrame();
  const [l0, l1, l2] = useLines('providers');
  const keys = cam([0, 720, 450, 1], [14, 1230, 420, 1.55], [100, 1230, 420, 1.55], [124, 1230, 300, 1.55]);
  const layers: Layer[] = [{ rec: 'codex-switch', at: 0, from: 0.5, to: 8.6 }];
  const end = sceneFrames('providers');
  return (
    <AbsoluteFill>
      <Background />
      <Chapter index="07" label="Claude or Codex" />
      <AppWindow layers={layers} cam={keys}>
        <Callout cam={keys} box={{ x: 1136, y: 300, w: 256, h: 70 }} label="Switch provider or model" side="left" at={l0 + 10} out={84} />
        <Callout cam={keys} box={{ x: 1050, y: 228, w: 360, h: 108 }} label="Claude and Codex, on the same page" side="left" at={l1 + 40} out={end - 8} ring={false} />
      </AppWindow>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 74, display: 'flex', justifyContent: 'center', gap: 14 }}>
        {['Same transcript', 'Same document', 'Same tools'].map((t, i) => (
          <div key={t} style={{ ...enter(frame, l2 + i * 8, { y: 12 }), background: C.ink, color: '#fff', fontFamily: SANS, fontWeight: 600, fontSize: 22, padding: '11px 20px', borderRadius: 12, boxShadow: '0 18px 40px -12px rgba(31,30,28,0.45)' }}>
            {t}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

// ---------- Canvas ----------

export const CanvasScene: React.FC = () => {
  const [l0, l1] = useLines('canvas');
  const recAt = 50;
  const layers: Layer[] = [
    { img: 'canvas-top', at: 0 },
    { rec: 'canvas-tour', at: recAt, from: 0.6, to: 10.7, fade: 8 },
  ];
  const typing = recAt + Math.round((7.56 - 0.6) * 30);
  const end = sceneFrames('canvas');
  const keys = cam(FULL(0), FULL(typing - 20), [typing + 10, 640, 300, 1.3]);
  return (
    <AbsoluteFill>
      <Background />
      <Chapter index="08" label="Canvas" />
      <AppWindow layers={layers} cam={keys} />
      <Tag at={l0 + 30} out={l1 + 40} text="Designed, paginated, editable" x={WIN.x + 28} y={WIN.y + 900 - 76} />
      <Tag at={l1 + 52} out={typing - 16} text="Columns, color and type" x={WIN.x + 28} y={WIN.y + 900 - 76} />
      <Tag at={typing} out={end - 8} text="Click in and change any word" x={WIN.x + 28} y={WIN.y + 900 - 76} />
    </AbsoluteFill>
  );
};

// ---------- PDF import ----------

export const PdfScene: React.FC = () => {
  const frame = useCurrentFrame();
  const [l0, l1] = useLines('pdf');
  const end = sceneFrames('pdf');
  const fastAt = 170;
  const rate = 9;
  const fastEnd = fastAt + Math.round(((126.6 - 6.0) / rate) * 30);
  const sideAt = fastEnd - 30;
  const layers: Layer[] = [
    { rec: 'pdf-import', at: 0, from: 0.3, to: 6.0 },
    { rec: 'pdf-import', at: fastAt, from: 6.0, to: 126.6, rate, fade: 2 },
  ];
  const keys = cam(FULL(0), FULL(fastAt + 20), [fastAt + 50, 1230, 420, 1.35], [fastEnd - 60, 1230, 420, 1.35], FULL(fastEnd - 30));
  const side = prog(frame, sideAt, 30);
  const dim = prog(frame, sideAt, 24, EASE_IO);
  const speed = frame >= fastAt && frame < fastEnd - 30;
  return (
    <AbsoluteFill>
      <Background />
      <Chapter index="09" label="PDF import" />
      <div style={{ position: 'absolute', inset: 0, opacity: 1 - dim * 0.85, filter: `blur(${dim * 6}px)` }}>
        <AppWindow layers={layers} cam={keys} />
      </div>
      {speed && (
        <div style={{ position: 'absolute', right: WIN.x + 24, top: WIN.y + 900 - 70, ...enter(frame, fastAt + 4, { y: 8, out: fastEnd - 44 }), background: C.ink, color: '#fff', fontFamily: MONO, fontSize: 18, padding: '7px 12px', borderRadius: 9 }}>9× speed · 2 min real time</div>
      )}
      <Tag at={20} out={fastAt - 10} text="Page size, fonts and margins, matched" x={WIN.x + 28} y={WIN.y + 900 - 76} />
      <Tag at={fastAt + 20} out={sideAt - 20} text="Read · write · align · compare, page by page" x={WIN.x + 28} y={WIN.y + 900 - 76} />
      {side > 0 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 70, paddingTop: 40 }}>
          {[
            ['img/pdf-original.png', 'Original PDF', 2040 / 2025],
            ['img/pdf-rebuilt.png', 'Editable in Inline', 1632 / 1620],
          ].map(([src, label, ratio], i) => {
            const p = prog(frame, sideAt + i * 10, 30);
            return (
              <div key={label as string} style={{ opacity: p, transform: `translateY(${(1 - p) * 40}px) rotate(${(i ? 1 : -1) * (1 - p) * 2}deg)`, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 24, color: i ? C.accentText : C.muted, marginBottom: 18 }}>{label}</div>
                <div style={{ width: 660, height: 660 / (ratio as number), background: '#fff', borderRadius: 6, overflow: 'hidden', boxShadow: '0 1px 2px rgba(31,30,28,0.06), 0 40px 90px -24px rgba(60,40,20,0.4)', outline: i ? `2px solid ${C.accent}` : 'none', outlineOffset: 6 }}>
                  <Img src={staticFile(src as string)} style={{ width: '100%', height: '100%' }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AbsoluteFill>
  );
};

// ---------- Organize with AI ----------

export const OrganizeScene: React.FC = () => {
  const [l0, l1] = useLines('organize');
  const rate = 1.55;
  const layers: Layer[] = [{ rec: 'organize', at: 0, from: 0, to: 21.4, rate }];
  const done = Math.round((18.1 / rate) * 30);
  const end = sceneFrames('organize');
  const keys = cam(FULL(0));
  return (
    <AbsoluteFill>
      <Background />
      <Chapter index="10" label="Organize with AI" />
      <AppWindow layers={layers} cam={keys}>
        <Callout cam={keys} box={{ x: 1036, y: 186, w: 390, h: 306 }} label="8 documents, filed in 13 seconds" side="left" at={done - 30} out={end - 6} />
      </AppWindow>
      <Tag at={8} out={60} text="8 unfiled documents" x={WIN.x + 28} y={WIN.y + 900 - 76} />
      <Tag at={l1} out={done - 40} text="Reads titles and first lines only" x={WIN.x + 28} y={WIN.y + 900 - 76} />
    </AbsoluteFill>
  );
};

// ---------- Your files ----------

const TREE: [string, string[]][] = [
  ['Classes', ['EOS 310 Lecture 7', 'STAT 512 midterm review', 'STAT 512- Problem Set 6', 'The Ethics of Attention']],
  ['Personal', ['Apartment lease questions', 'Cover letter- Ocean Futures Fellowship', 'Reading list 2026', 'Resume']],
  ['Thesis', ['CERF 2027 conference abstract', 'Field guide- Reading the marsh', 'Field notes- Pivers Island', 'Literature review', 'Living Shorelines Thesis Proposal', 'Tide gauge calibration notes']],
  ['Work', ['Customer interview- Northwind Legal', 'Launch plan- Sync 2.0', 'October investor update', 'Q4 OKRs draft', 'Weekly sync- October 21']],
];

const Folder: React.FC<{ size?: number; color?: string }> = ({ size = 20, color = '#5aa0f0' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path d="M2 6.5A2.5 2.5 0 014.5 4h4.2l2 2.2h8.8A2.5 2.5 0 0122 8.7v9.8a2.5 2.5 0 01-2.5 2.5h-15A2.5 2.5 0 012 18.5z" fill={color} />
  </svg>
);
const WordIcon: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <rect x="4" y="2" width="16" height="20" rx="2.5" fill="#fff" stroke="#c9d4e6" />
    <rect x="1.5" y="8" width="11" height="9" rx="2" fill="#2b579a" />
    <path d="M3.6 10l1.1 5 1.2-3.6 1.2 3.6 1.1-5" stroke="#fff" strokeWidth="1.1" fill="none" strokeLinejoin="round" />
  </svg>
);

export const FilesScene: React.FC = () => {
  const frame = useCurrentFrame();
  const [l0, l1] = useLines('files');
  const end = sceneFrames('files');
  const rows = TREE.flatMap(([folder, files]) => [{ folder, name: folder, kind: 'folder' as const }, ...files.map((f) => ({ folder, name: `${f}.docx`, kind: 'file' as const }))]);
  const win = enter(frame, 6, { y: 30, dur: 26 });
  const exportAt = l1 + 120;
  const driveAt = l1 + 230;
  return (
    <AbsoluteFill>
      <Background />
      <Chapter index="11" label="Your files" />
      {/* Finder window listing the Word copies Inline keeps (the real folder from this account). */}
      <div style={{ position: 'absolute', left: 170, top: 150, width: 880, height: 830, borderRadius: 14, background: '#fff', boxShadow: '0 0 0 1px rgba(31,30,28,0.10), 0 40px 100px -24px rgba(60,40,20,0.35)', overflow: 'hidden', fontFamily: SANS, ...win }}>
        <div style={{ height: 52, background: '#f6f5f3', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', padding: '0 18px', gap: 8 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
            <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
          ))}
          <div style={{ marginLeft: 22, display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, color: C.text, fontWeight: 600 }}>
            <Folder size={18} /> Documents <span style={{ color: C.faint }}>›</span> Inline
          </div>
          <div style={{ marginLeft: 'auto', fontSize: 14, color: C.muted }}>19 items</div>
        </div>
        <div style={{ display: 'flex', fontSize: 13, color: C.muted, padding: '8px 22px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ flex: 1 }}>Name</span>
          <span style={{ width: 150 }}>Kind</span>
          <span style={{ width: 120 }}>Modified</span>
        </div>
        {rows.map((r, i) => {
          const p = prog(frame, 14 + i * 3, 12);
          return (
            <div key={r.folder + r.name} style={{ display: 'flex', alignItems: 'center', height: 30, padding: '0 22px', background: i % 2 ? '#fafaf8' : '#fff', opacity: p, fontSize: 15, color: C.text }}>
              <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 9, paddingLeft: r.kind === 'file' ? 26 : 0 }}>
                {r.kind === 'folder' ? <><span style={{ color: C.faint, fontSize: 10 }}>▼</span><Folder size={18} /></> : <WordIcon size={18} />}
                {r.name}
              </span>
              <span style={{ width: 150, color: C.muted, fontSize: 14 }}>{r.kind === 'folder' ? 'Folder' : 'Word document'}</span>
              <span style={{ width: 120, color: C.muted, fontSize: 14 }}>Today</span>
            </div>
          );
        })}
      </div>
      <div style={{ position: 'absolute', left: 1110, top: 210, width: 650, ...enter(frame, l0 + 10, { y: 16 }) }}>
        <div style={{ fontFamily: SERIF, fontSize: 52, lineHeight: 1.08, color: C.text }}>A Word copy of every document, <span style={{ fontStyle: 'italic', color: C.accent }}>on your computer.</span></div>
        <div style={{ fontFamily: SANS, fontSize: 20, color: C.muted, marginTop: 16, lineHeight: 1.45 }}>Updated a few seconds after you stop typing, in the same folders as Home. Fonts, margins, headers, images and tables included.</div>
      </div>
      <div style={{ position: 'absolute', left: 1110, top: 560, display: 'flex', gap: 10, flexWrap: 'wrap', width: 650 }}>
        {['Word (.docx)', 'PDF (.pdf)', 'Markdown (.md)', 'Web page (.html)', 'Plain text (.txt)'].map((f, i) => (
          <div key={f} style={{ ...enter(frame, exportAt + i * 6, { y: 12 }), background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: '10px 16px', fontFamily: SANS, fontSize: 19, fontWeight: 500, color: C.text, boxShadow: '0 10px 24px -14px rgba(60,40,20,0.3)' }}>
            {f}
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 1110, top: 720, width: 650, ...enter(frame, driveAt, { y: 16 }), background: C.accentSoft, border: '1px solid rgba(201,100,66,0.22)', borderRadius: 16, padding: '20px 24px', fontFamily: SANS }}>
        <div style={{ fontWeight: 600, fontSize: 21, color: C.accentText }}>Moving from Google Docs?</div>
        <div style={{ fontSize: 18, color: '#7c4a37', marginTop: 6, lineHeight: 1.45 }}>Export your Drive with Google Takeout and import the .zip. Every doc arrives in the folders it had in Drive.</div>
      </div>
    </AbsoluteFill>
  );
};

// ---------- Claude Code over MCP ----------

type TermLine = { at: number; kind: 'cmd' | 'out' | 'tool' | 'say' | 'ok'; text: string; sub?: string };

const Terminal: React.FC<{ lines: TermLine[] }> = ({ lines }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ width: 800, height: 760, borderRadius: 14, background: '#1b1a18', boxShadow: '0 40px 100px -24px rgba(31,30,28,0.55)', overflow: 'hidden', fontFamily: MONO }}>
      <div style={{ height: 42, background: '#262522', display: 'flex', alignItems: 'center', padding: '0 16px', gap: 8, borderBottom: '1px solid #34322e' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
          <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
        ))}
        <div style={{ flex: 1, textAlign: 'center', fontFamily: SANS, fontSize: 14, color: '#9a968e', marginRight: 52 }}>jordan — claude — 80×24</div>
      </div>
      <div style={{ padding: '22px 24px', fontSize: 17, lineHeight: '27px', color: '#e8e4dc' }}>
        {lines.map((l, i) => {
          if (frame < l.at) return null;
          if (l.kind === 'cmd') {
            const typed = l.text.slice(0, Math.max(0, Math.round((frame - l.at) * 2.4)));
            const caret = typed.length < l.text.length && Math.floor(frame / 8) % 2 === 0;
            return (
              <div key={i} style={{ marginBottom: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                <span style={{ color: '#7ee787' }}>~ </span>
                <span style={{ color: '#e8a87c' }}>$ </span>
                {typed}
                {caret && <span style={{ background: '#e8e4dc' }}> </span>}
              </div>
            );
          }
          const p = prog(frame, l.at, 10);
          const color = l.kind === 'tool' ? '#e8e4dc' : l.kind === 'ok' ? '#7ee787' : l.kind === 'say' ? '#e8e4dc' : '#9a968e';
          return (
            <div key={i} style={{ opacity: p, marginBottom: l.kind === 'say' ? 14 : 8, color, whiteSpace: 'pre-wrap', fontFamily: l.kind === 'say' ? SANS : MONO, fontSize: l.kind === 'say' ? 18 : 17 }}>
              {l.kind === 'tool' && <span style={{ color: '#d97757' }}>⏺ </span>}
              {l.kind === 'say' && <span style={{ color: '#d97757' }}>⏺ </span>}
              {l.kind === 'tool' ? <b style={{ fontWeight: 700 }}>{l.text}</b> : l.text}
              {l.sub && <div style={{ color: '#9a968e', paddingLeft: 26 }}>⎿  {l.sub}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const McpScene: React.FC = () => {
  const frame = useCurrentFrame();
  const [l0, l1] = useLines('mcp');
  const end = sceneFrames('mcp');
  const rate = 1.1;
  const recFrom = 1.0;
  const srcAt = (t: number) => Math.round(((t - recFrom) / rate) * 30);
  const landed = srcAt(13.6);
  const lines = (terminal as TermLine[]).map((l) => ({ ...l, at: l.at === -1 ? landed - 6 : l.at }));
  const scale = 0.62;
  const win = { x: 1000, y: 250, w: 1440, h: 900 };
  const layers: Layer[] = [{ rec: 'mcp-live', at: 0, from: recFrom, to: 20.5, rate }];
  const keys = cam(FULL(0));
  return (
    <AbsoluteFill>
      <Background />
      <Chapter index="12" label="Claude Code, over MCP" />
      <div style={{ position: 'absolute', left: 120, top: 180, ...enter(frame, 4, { y: 24 }) }}>
        <Terminal lines={lines} />
      </div>
      <AppWindow layers={layers} cam={keys} win={win} scale={scale} intro={8}>
        <Callout cam={keys} win={win} scale={scale} box={{ x: 472, y: 470, w: 250, h: 86 }} label="The edit lands live, for review" side="bottom" at={landed + 10} out={end - 6} />
      </AppWindow>
    </AbsoluteFill>
  );
};
