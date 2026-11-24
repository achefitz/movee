import React from 'react';
import { View } from 'react-native';
import YoutubeIframe from 'react-native-youtube-iframe';

interface Props {
  videoId: string;
  isMuted: boolean;
  /** Size of the card; the 16:9 video is scaled to cover it and the sides are cropped. */
  width: number;
  height: number;
  onPlaying: () => void;
  onError: () => void;
}

export function NativeYoutubePlayer({ videoId, isMuted, width, height, onPlaying, onError }: Props) {
  const videoW = Math.max(width, Math.ceil(height * 16 / 9));
  const videoH = Math.max(height, Math.ceil(videoW * 9 / 16));
  return (
    <View style={{ position: 'absolute', top: (height - videoH) / 2, left: (width - videoW) / 2, width: videoW, height: videoH }}>
      <YoutubeIframe
        videoId={videoId}
        play
        mute={isMuted}
        height={videoH}
        width={videoW}
        onChangeState={(state: string) => { if (state === 'playing') onPlaying(); }}
        onError={onError}
        initialPlayerParams={{
          preventFullScreen: true,
          loop: true,
          controls: false,
          modestbranding: true,
          rel: false,
          iv_load_policy: 3,
        }}
        webViewProps={{
          allowsInlineMediaPlayback: true,
          mediaPlaybackRequiresUserAction: false,
          androidLayerType: 'hardware',
          scrollEnabled: false,
        }}
      />
    </View>
  );
}
