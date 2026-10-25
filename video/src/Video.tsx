import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';

import { CanvasScene, ChatScene, CommentsScene, EditorScene, FilesScene, HistoryScene, HomeScene, McpScene, OrganizeScene, PdfScene, ProvidersScene, SelectScene } from './scenes/Product';
import { DesktopScene, IdeaScene, OpenScene, OutroScene, TitleScene } from './scenes/Story';
import { SCENES } from './scenes';
import { C, SceneFade, TIMELINE } from './ui';

const COMPONENTS: Record<string, React.FC> = {
  open: OpenScene,
  title: TitleScene,
  idea: IdeaScene,
  desktop: DesktopScene,
  home: HomeScene,
  editor: EditorScene,
  chat: ChatScene,
  select: SelectScene,
  comments: CommentsScene,
  history: HistoryScene,
  providers: ProvidersScene,
  canvas: CanvasScene,
  pdf: PdfScene,
  organize: OrganizeScene,
  files: FilesScene,
  mcp: McpScene,
  outro: OutroScene,
};

/** Frames each scene lingers into the next one for a crossfade. */
const OVER = 14;

export const InlineVideo: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    {TIMELINE.scenes.map((scene, i) => {
      const Comp = COMPONENTS[scene.id];
      const last = i === TIMELINE.scenes.length - 1;
      const title = SCENES.find((s) => s.id === scene.id)!.title;
      return (
        <Sequence key={scene.id} from={scene.from} durationInFrames={scene.frames + (last ? 0 : OVER)} name={title}>
          <SceneFade dur={last ? scene.frames + 100 : scene.frames} over={OVER}>
            <Comp />
          </SceneFade>
        </Sequence>
      );
    })}
    {/* Narration, one clip per sentence, placed by scripts/voiceover.ts. */}
    {TIMELINE.scenes.flatMap((scene) =>
      scene.lines.map((line) => (
        <Sequence key={line.src} from={Math.max(0, scene.from + line.clipFrom)} name={`VO ${line.text}`} layout="none">
          <Audio src={staticFile(line.src)} />
        </Sequence>
      )),
    )}
  </AbsoluteFill>
);
