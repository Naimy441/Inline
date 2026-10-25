import React from 'react';
import { Composition } from 'remotion';

import { TIMELINE } from './ui';
import { InlineVideo } from './Video';

export const Root: React.FC = () => <Composition id="Inline" component={InlineVideo} durationInFrames={TIMELINE.frames} fps={30} width={1920} height={1080} />;
