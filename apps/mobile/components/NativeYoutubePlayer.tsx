import React from 'react';
import { StyleSheet, Dimensions } from 'react-native';
import YoutubeIframe from 'react-native-youtube-iframe';

const { width: W, height: H } = Dimensions.get('window');

interface Props {
  videoId: string;
  isMuted: boolean;
  onEnded: () => void;
  onError: () => void;
}

export function NativeYoutubePlayer({ videoId, isMuted, onEnded, onError }: Props) {
  return (
    <YoutubeIframe
      videoId={videoId}
      play
      mute={isMuted}
      height={H}
      width={W}
      onChangeState={(state: string) => { if (state === 'ended') onEnded(); }}
      onError={onError}
      initialPlayerParams={{
        preventFullScreen: true,
        loop: true,
        controls: false,
        modestbranding: true,
        rel: false,
      }}
      webViewStyle={StyleSheet.absoluteFill}
      webViewProps={{
        allowsInlineMediaPlayback: true,
        mediaPlaybackRequiresUserAction: false,
        androidLayerType: 'hardware',
      }}
    />
  );
}
