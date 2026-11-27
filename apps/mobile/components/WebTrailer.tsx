import React, { useEffect, useRef } from 'react';

/**
 * Muted, looping YouTube trailer, TRAILER_ZOOM × its container's width and vertically
 * centered: in the card's 2:1 strip that trims the black bars of widescreen trailers.
 * Talks to the player over YouTube's postMessage API so we know when it is really
 * playing (to fade it in over the poster) or failed (embedding disabled, removed…).
 * pointer-events: none — swipes and taps go to the card, not the iframe.
 */
type Props = {
  ytKey: string;
  muted: boolean;
  onPlaying: () => void;
  onError: () => void;
  /** Width as a multiple of the container's; the 16:9 video is centered, so extra width crops it. */
  zoom?: number;
};

const ORIGIN = 'https://www.youtube.com';
export const TRAILER_ZOOM = 1.15;

export function WebTrailer({ ytKey, muted, onPlaying, onError, zoom = TRAILER_ZOOM }: Props) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const playing = useRef(false);
  const cb = useRef({ onPlaying, onError, muted });
  cb.current = { onPlaying, onError, muted };

  const send = (func: string) =>
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args: [] }), ORIGIN);

  useEffect(() => {
    playing.current = false;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== ORIGIN || e.source !== frame.current?.contentWindow) return;
      let data: any;
      try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      if (data?.event === 'onError') {
        cb.current.onError();
        return;
      }
      const state = data?.event === 'onStateChange' ? data.info
        : data?.event === 'infoDelivery' ? data.info?.playerState : undefined;
      if (state === 1 && !playing.current) {
        playing.current = true;
        // Always start muted (browsers block unmuted autoplay); unmute once it runs if wanted.
        if (!cb.current.muted) send('unMute');
        cb.current.onPlaying();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [ytKey]);

  // Mute toggles go to the running player instead of reloading the iframe.
  useEffect(() => {
    if (!playing.current) return;
    send(muted ? 'mute' : 'unMute');
    if (!muted) send('playVideo');
  }, [muted]);

  const src =
    `${ORIGIN}/embed/${ytKey}?autoplay=1&mute=1&controls=0&loop=1&playlist=${ytKey}` +
    '&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3&disablekb=1&fs=0&enablejsapi=1' +
    `&origin=${encodeURIComponent(window.location.origin)}`;

  return React.createElement('iframe', {
    ref: frame,
    src,
    title: 'Trailer',
    allow: 'autoplay; encrypted-media; picture-in-picture',
    onLoad: () => {
      // Subscribe to player events.
      frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: ytKey }), ORIGIN);
    },
    style: {
      position: 'absolute',
      top: '50%',
      left: '50%',
      width: `${zoom * 100}%`,
      aspectRatio: '16 / 9',
      transform: 'translate(-50%, -50%)',
      border: 'none',
      pointerEvents: 'none',
    },
  });
}
