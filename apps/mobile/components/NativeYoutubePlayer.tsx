import React from 'react';
import { View } from 'react-native';
import YoutubeIframe from 'react-native-youtube-iframe';

interface Props {
  videoId: string;
  isMuted: boolean;
  /** Size of the frame; the 16:9 video covers it, zoomed by `zoom` to trim letterbox bars. */
  width: number;
  height: number;
  onPlaying: () => void;
  onError: () => void;
  zoom?: number;
}

export function NativeYoutubePlayer({ videoId, isMuted, width, height, onPlaying, onError, zoom = 1 }: Props) {
  const videoW = Math.ceil(Math.max(width, height * 16 / 9) * zoom);
  const videoH = Math.ceil(videoW * 9 / 16);
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
