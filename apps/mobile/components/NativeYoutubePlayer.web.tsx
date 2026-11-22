import React from 'react';

interface Props {
  videoId: string;
  isMuted: boolean;
  onEnded: () => void;
  onError: () => void;
}

export function NativeYoutubePlayer(_props: Props) {
  return null;
}
