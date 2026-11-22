import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import {
  View, Text, StyleSheet, Animated, PanResponder,
  Dimensions, Platform, TouchableOpacity, Linking,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { NativeYoutubePlayer } from './NativeYoutubePlayer';
import { MediaItem } from '../services/tmdb';
import Colors from '../constants/colors';
import { SVC, AMC_URL } from '../constants/streaming';

const { width: W, height: H } = Dimensions.get('window');
const SWIPE_H = 80;
const SWIPE_V = 100;
/** A quick flick counts even if the card hasn't travelled the full threshold. */
const FLICK_VX = 0.65;
const FLICK_MIN_DX = 24;

export type SwipeDirection = 'right' | 'left' | 'up';
export type SwipeCardHandle = { swipe: (dir: SwipeDirection) => void };

interface SwipeCardProps {
  item: MediaItem;
  trailerKey?: string | null;
  isTop: boolean;
  onSwipeRight: () => void;
  onSwipeLeft: () => void;
  onSwipeUp: () => void;
  onPress: () => void;
}

function buildYouTubeUrl(key: string, muted: boolean) {
  const m = muted ? '1' : '0';
  return `https://www.youtube.com/embed/${key}?autoplay=1&mute=${m}&controls=1&loop=1&playlist=${key}&playsinline=1&rel=0&modestbranding=1&enablejsapi=1`;
}

function WebIframePlayer({ ytKey, muted }: { ytKey: string; muted: boolean }) {
  const src = buildYouTubeUrl(ytKey, muted);
  return React.createElement('iframe', {
    key: src,
    src,
    allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
    allowFullScreen: true,
    style: {
      position: 'absolute' as const,
      top: 0, left: 0,
      width: '100%', height: '100%',
      border: 'none',
    },
  });
}

export const SwipeCard = forwardRef<SwipeCardHandle, SwipeCardProps>(function SwipeCard(
  { item, trailerKey, isTop, onSwipeRight, onSwipeLeft, onSwipeUp, onPress },
  ref,
) {
  const position = useRef(new Animated.ValueXY()).current;
  const [isMuted, setIsMuted] = useState(true);
  const [trailerError, setTrailerError] = useState(false);
  const [isPlaying, setIsPlayingState] = useState(false);
  const isDragging = useRef(false);
  const isPlayingRef = useRef(false);
  const leaving = useRef(false);
  // On web both the PanResponder and the mouse fallback below see the same gesture.
  // Whichever handles the release first stamps this so the other stands down
  // (otherwise a swipe's mouseup is misread as a tap and opens the details sheet).
  const releasedAt = useRef(0);
  const claimRelease = () => {
    if (Date.now() - releasedAt.current < 400) return false;
    releasedAt.current = Date.now();
    return true;
  };
  // The pan responder is created once; read callbacks through a ref so it never calls stale ones.
  const cb = useRef({ onSwipeRight, onSwipeLeft, onSwipeUp });
  cb.current = { onSwipeRight, onSwipeLeft, onSwipeUp };

  const setIsPlaying = (val: boolean) => {
    isPlayingRef.current = val;
    setIsPlayingState(val);
  };

  const forceSwipe = (dir: SwipeDirection) => {
    if (leaving.current) return; // ignore double taps while the card is flying off
    leaving.current = true;
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(dir === 'right' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    const toValue =
      dir === 'right' ? { x: W + 100, y: 0 } :
      dir === 'left' ? { x: -(W + 100), y: 0 } :
      { x: 0, y: -(H + 100) };
    Animated.timing(position, { toValue, duration: 220, useNativeDriver: false }).start(() => {
      if (dir === 'right') cb.current.onSwipeRight();
      else if (dir === 'left') cb.current.onSwipeLeft();
      else cb.current.onSwipeUp();
    });
  };

  useImperativeHandle(ref, () => ({ swipe: forceSwipe }));

  const resetPosition = () => {
    Animated.spring(position, { toValue: { x: 0, y: 0 }, friction: 5, useNativeDriver: false }).start();
  };

  const handleTap = () => {
    if (isPlayingRef.current || leaving.current) return;
    if (isTop && trailerKey && !trailerError) {
      setIsPlaying(true);
    } else {
      onPress();
    }
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !isPlayingRef.current,
      onMoveShouldSetPanResponder: (_, g) =>
        !isPlayingRef.current && (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        isDragging.current = false;
      },
      onPanResponderMove: (_, g) => {
        if (Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6) isDragging.current = true;
        position.setValue({ x: g.dx, y: g.dy });
      },
      onPanResponderRelease: (_, g) => {
        if (!claimRelease()) return;
        if (!isDragging.current) {
          resetPosition();
          handleTap();
          return;
        }
        isDragging.current = false;
        if (g.dx > SWIPE_H || (g.vx > FLICK_VX && g.dx > FLICK_MIN_DX)) {
          forceSwipe('right');
        } else if (g.dx < -SWIPE_H || (g.vx < -FLICK_VX && g.dx < -FLICK_MIN_DX)) {
          forceSwipe('left');
        } else if (g.dy < -SWIPE_V || (g.vy < -FLICK_VX && g.dy < -FLICK_MIN_DX * 2)) {
          forceSwipe('up');
        } else {
          resetPosition();
        }
      },
      onPanResponderTerminate: () => {
        isDragging.current = false;
        resetPosition();
      },
    })
  ).current;

  const webDragState = useRef({ active: false, startX: 0, startY: 0 });

  const webHandlers = Platform.OS === 'web' ? {
    onMouseDown: (e: any) => {
      if (isPlayingRef.current) return;
      isDragging.current = false;
      webDragState.current = { active: true, startX: e.clientX, startY: e.clientY };
      e.preventDefault?.();
    },
    onMouseMove: (e: any) => {
      if (!webDragState.current.active || isPlayingRef.current) return;
      const dx = e.clientX - webDragState.current.startX;
      const dy = e.clientY - webDragState.current.startY;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) isDragging.current = true;
      if (isDragging.current) position.setValue({ x: dx, y: dy });
    },
    onMouseUp: (e: any) => {
      if (!webDragState.current.active) return;
      webDragState.current.active = false;
      if (!claimRelease()) { isDragging.current = false; return; }
      const dx = e.clientX - webDragState.current.startX;
      const dy = e.clientY - webDragState.current.startY;
      if (!isDragging.current) {
        resetPosition();
        handleTap();
      } else if (dx > SWIPE_H) {
        forceSwipe('right');
      } else if (dx < -SWIPE_H) {
        forceSwipe('left');
      } else if (dy < -SWIPE_V) {
        forceSwipe('up');
      } else {
        resetPosition();
      }
      isDragging.current = false;
    },
    onMouseLeave: (e: any) => {
      if (!webDragState.current.active) return;
      webDragState.current.active = false;
      if (!claimRelease()) { isDragging.current = false; return; }
      const dx = e.clientX - webDragState.current.startX;
      const dy = e.clientY - webDragState.current.startY;
      if (isDragging.current) {
        if (dx > SWIPE_H) forceSwipe('right');
        else if (dx < -SWIPE_H) forceSwipe('left');
        else resetPosition();
      } else {
        resetPosition();
      }
      isDragging.current = false;
    },
  } : {};

  const rotate = position.x.interpolate({
    inputRange: [-W / 2, 0, W / 2],
    outputRange: ['-14deg', '0deg', '14deg'],
    extrapolate: 'clamp',
  });

  const likeOpacity = position.x.interpolate({ inputRange: [0, W / 4], outputRange: [0, 1], extrapolate: 'clamp' });
  const nopeOpacity = position.x.interpolate({ inputRange: [-W / 4, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const watchedOpacity = position.y.interpolate({ inputRange: [-H / 5, 0], outputRange: [1, 0], extrapolate: 'clamp' });

  const toggleMute = () => setIsMuted(prev => !prev);

  const canPlay = isTop && !!trailerKey && !trailerError;

  const streamingBadges = (item.streamingIds || [])
    .filter(id => SVC[id])
    .slice(0, 2);

  const openLink = (url: string) => {
    Linking.openURL(url).catch(() => {});
  };

  return (
    <Animated.View
      style={[styles.card, { transform: [{ translateX: position.x }, { translateY: position.y }, { rotate }] }]}
      {...panResponder.panHandlers}
      {...webHandlers}
    >
      <View style={styles.cardInner}>
        {isPlaying ? (
          Platform.OS === 'web' ? (
            <View style={StyleSheet.absoluteFill}>
              <WebIframePlayer ytKey={trailerKey!} muted={isMuted} />
            </View>
          ) : (
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              <NativeYoutubePlayer
                videoId={trailerKey!}
                isMuted={isMuted}
                onEnded={() => setIsPlaying(false)}
                onError={() => { setTrailerError(true); setIsPlaying(false); }}
              />
            </View>
          )
        ) : (
          <Image source={item.posterUrl} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        )}

        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0.97)']}
          style={styles.gradient}
        >
          <View style={styles.topBadgesRow}>
            <View style={styles.typeBadge}>
              <Text style={styles.typeBadgeText}>{item.type === 'movie' ? 'MOVIE' : 'TV'}</Text>
            </View>
            {item.year ? <Text style={styles.year}>{item.year}</Text> : null}
          </View>

          {item.reason ? (
            <View style={styles.reasonChip}>
              <Ionicons
                name={item.reason === 'Something different' ? 'compass' : item.reason.startsWith('Because') ? 'sparkles' : 'trending-up'}
                size={11}
                color={Colors.accent}
              />
              <Text style={styles.reasonText} numberOfLines={1}>{item.reason}</Text>
            </View>
          ) : null}

          <Text style={styles.title} numberOfLines={2}>{item.title}</Text>

          <View style={styles.metaRow}>
            <Ionicons name="star" size={14} color={Colors.accent} />
            <Text style={styles.rating}>{item.rating.toFixed(1)}</Text>
            {item.genreNames.slice(0, 2).map(g => (
              <View key={g} style={styles.genreTag}>
                <Text style={styles.genreText}>{g}</Text>
              </View>
            ))}
          </View>

          {(streamingBadges.length > 0 || item.inTheaters) && (
            <View style={styles.streamingRow}>
              {streamingBadges.map(id => {
                const svc = SVC[id];
                return (
                  <TouchableOpacity
                    key={id}
                    style={[styles.streamingBadge, { backgroundColor: svc.color }]}
                    onPress={() => openLink(svc.url)}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.streamingBadgeText}>{svc.name}</Text>
                  </TouchableOpacity>
                );
              })}
              {item.inTheaters && (
                <TouchableOpacity
                  style={styles.theaterBadge}
                  onPress={() => openLink(AMC_URL)}
                  activeOpacity={0.8}
                >
                  <Ionicons name="film" size={10} color="#F5C518" style={{ marginRight: 3 }} />
                  <Text style={styles.theaterBadgeText}>IN THEATERS</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </LinearGradient>

        {canPlay && !isPlaying && (
          <TouchableOpacity
            style={styles.playBtn}
            onPress={() => setIsPlaying(true)}
            activeOpacity={0.8}
          >
            <View style={styles.playBtnInner}>
              <Ionicons name="play" size={26} color="#fff" style={{ marginLeft: 4 }} />
            </View>
          </TouchableOpacity>
        )}

        {isPlaying && (
          <View style={styles.playerControls}>
            <TouchableOpacity style={styles.controlBtn} onPress={toggleMute} activeOpacity={0.8}>
              <Ionicons name={isMuted ? 'volume-mute' : 'volume-high'} size={18} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.controlBtn} onPress={() => setIsPlaying(false)} activeOpacity={0.8}>
              <Ionicons name="close" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        )}

        <Animated.View style={[styles.likeLabel, { opacity: likeOpacity }]}>
          <Text style={styles.likeText}>LIKE</Text>
        </Animated.View>
        <Animated.View style={[styles.nopeLabel, { opacity: nopeOpacity }]}>
          <Text style={styles.nopeText}>NOPE</Text>
        </Animated.View>
        <Animated.View style={[styles.watchedLabel, { opacity: watchedOpacity }]}>
          <Text style={styles.watchedText}>SEEN</Text>
        </Animated.View>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    padding: 8,
    zIndex: 100,
    ...(Platform.OS === 'web' ? { cursor: 'grab' } as any : {}),
  },
  cardInner: {
    flex: 1,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: Colors.bgCard,
    borderColor: Colors.border,
    borderWidth: 1,
  },
  gradient: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: '55%',
    justifyContent: 'flex-end',
    padding: 20,
    paddingBottom: 24,
  },
  topBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  typeBadge: {
    backgroundColor: Colors.accent,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  typeBadgeText: {
    color: '#000',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  year: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  reasonChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    maxWidth: '100%',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(245,197,24,0.14)',
    marginBottom: 6,
  },
  reasonText: {
    color: Colors.accent,
    fontSize: 11,
    fontWeight: '700',
    flexShrink: 1,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.textPrimary,
    marginBottom: 10,
    letterSpacing: -0.3,
    fontFamily: 'Inter_700Bold',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  rating: {
    color: Colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  genreTag: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  genreText: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: '500',
  },
  streamingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    flexWrap: 'wrap',
  },
  streamingBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  streamingBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  theaterBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: 1,
    borderColor: Colors.accent,
  },
  theaterBadgeText: {
    color: Colors.accent,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  playBtn: {
    position: 'absolute',
    top: '35%',
    left: '50%',
    transform: [{ translateX: -32 }, { translateY: -32 }],
    zIndex: 200,
  },
  playBtnInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerControls: {
    position: 'absolute',
    top: 16,
    right: 16,
    flexDirection: 'row',
    gap: 8,
    zIndex: 200,
  },
  controlBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  likeLabel: {
    position: 'absolute',
    top: 52,
    left: 28,
    zIndex: 300,
    transform: [{ rotate: '-20deg' }],
    borderWidth: 3,
    borderColor: Colors.like,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  likeText: {
    color: Colors.like,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 2,
  },
  nopeLabel: {
    position: 'absolute',
    top: 52,
    right: 28,
    zIndex: 300,
    transform: [{ rotate: '20deg' }],
    borderWidth: 3,
    borderColor: Colors.skip,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  nopeText: {
    color: Colors.skip,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 2,
  },
  watchedLabel: {
    position: 'absolute',
    top: 52,
    alignSelf: 'center',
    zIndex: 300,
    borderWidth: 3,
    borderColor: '#7B68EE',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  watchedText: {
    color: '#7B68EE',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
