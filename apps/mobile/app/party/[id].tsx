import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Colors from '@/constants/colors';
import { SwipeCard, type SwipeCardHandle } from '@/components/SwipeCard';
import { MediaDetailModal } from '@/components/MediaDetailModal';
import { TitleGrid } from '@/components/TitleGrid';
import { ApiError } from '@/services/api';
import { getParty, voteInParty, type PartySummary } from '@/services/parties';
import { keyOf } from '@/services/recs';
import { fetchTrailerKey, type MediaItem } from '@/services/tmdb';

const MUTE_KEY = 'movee.trailerMuted';
const POLL_MS = 5000;

/**
 * A watch party: both people swipe the same deck (trailers autoplay like Discover).
 * Right = yes, left = no. A title you both say yes to is a match, shown at once.
 */
export default function PartyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const [party, setParty] = useState<PartySummary | null>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [queue, setQueue] = useState<MediaItem[]>([]);
  const [error, setError] = useState('');
  const [matchItem, setMatchItem] = useState<MediaItem | null>(null);
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [trailerKeys, setTrailerKeys] = useState<Record<string, string | null>>({});
  const [muted, setMuted] = useState(true);
  const topCard = useRef<SwipeCardHandle>(null);
  const queueRef = useRef<MediaItem[]>([]);
  queueRef.current = queue;
  const fetching = useRef(new Set<string>());

  useEffect(() => {
    AsyncStorage.getItem(MUTE_KEY).then(v => { if (v === '0') setMuted(false); }).catch(() => {});
  }, []);
  const toggleMute = () => setMuted(m => {
    AsyncStorage.setItem(MUTE_KEY, m ? '0' : '1').catch(() => {});
    return !m;
  });

  const load = useCallback(async (first: boolean) => {
    try {
      const v = await getParty(String(id));
      setParty(v.party);
      if (first) {
        setItems(v.items);
        setQueue(v.items.filter(i => !v.myVotes[keyOf(i)]));
      }
      setError('');
    } catch (e) {
      if (first) setError(e instanceof ApiError ? e.message : "Couldn't reach the server. Try again.");
    }
  }, [id]);

  useEffect(() => { load(true); }, [load]);

  // Once you're through the deck, keep checking for your friend's progress and matches.
  const finished = !!party && queue.length === 0 && items.length > 0;
  useEffect(() => {
    if (!finished || party?.status === 'done' || party?.status === 'cancelled') return;
    const t = setInterval(() => load(false), POLL_MS);
    return () => clearInterval(t);
  }, [finished, party?.status, load]);

  // Trailers for the next few cards.
  const topKeys = queue.slice(0, 3).map(keyOf).join(',');
  useEffect(() => {
    for (const item of queue.slice(0, 3)) {
      const k = keyOf(item);
      if (fetching.current.has(k)) continue;
      fetching.current.add(k);
      fetchTrailerKey(item.type, item.id).then(key => setTrailerKeys(prev => ({ ...prev, [k]: key })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topKeys]);

  const handleSwipe = useCallback((yes: boolean) => {
    const item = queueRef.current[0];
    if (!item) return;
    setQueue(q => q.filter(i => keyOf(i) !== keyOf(item)));
    voteInParty(String(id), keyOf(item), yes ? 'yes' : 'no')
      .then(r => {
        setParty(r.party);
        if (r.match) setMatchItem(item);
      })
      .catch(() => {
        // Put it back so the vote isn't lost.
        setQueue(q => [item, ...q.filter(i => keyOf(i) !== keyOf(item))]);
        setError("That swipe didn't go through. Check your connection.");
      });
  }, [id]);

  const swipe = (yes: boolean) => {
    if (!queueRef.current.length) return;
    if (topCard.current) topCard.current.swipe(yes ? 'right' : 'left');
    else handleSwipe(yes);
  };

  const matches = useMemo(() => {
    const keys = new Set(party?.matches ?? []);
    return items.filter(i => keys.has(keyOf(i)));
  }, [party?.matches, items]);

  const top = Platform.OS === 'web' ? Math.max(insets.top, 12) : insets.top;
  const back = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/social'));
  const done = items.length - queue.length;

  return (
    <View style={[styles.container, { paddingTop: top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={back} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>Watch party{party ? ` with ${party.with}` : ''}</Text>
          {party && items.length > 0 && (
            <Text style={styles.sub}>
              {party.mediaType === 'movie' ? 'Movies' : 'TV shows'} · {done}/{items.length} · {party.matches.length} match{party.matches.length === 1 ? '' : 'es'}
            </Text>
          )}
        </View>
      </View>

      {!party && !error ? (
        <View style={styles.center}><ActivityIndicator color={Colors.accent} size="large" /></View>
      ) : !party ? (
        <View style={styles.center}>
          <Text style={styles.muted}>{error}</Text>
          <TouchableOpacity style={styles.goldBtn} onPress={() => load(true)}><Text style={styles.goldText}>Retry</Text></TouchableOpacity>
        </View>
      ) : party.status === 'pending' ? (
        <View style={styles.center}>
          <Text style={styles.bigEmoji}>⏳</Text>
          <Text style={styles.h2}>Waiting for {party.with} to accept</Text>
        </View>
      ) : party.status === 'cancelled' || party.status === 'declined' ? (
        <View style={styles.center}>
          <Text style={styles.h2}>This watch party was called off</Text>
          <TouchableOpacity style={styles.goldBtn} onPress={back}><Text style={styles.goldText}>Back</Text></TouchableOpacity>
        </View>
      ) : !finished ? (
        <>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${(done / Math.max(1, items.length)) * 100}%` }]} />
          </View>
          <View style={styles.deck}>
            {queue.slice(0, 3).reverse().map((item, idx, arr) => {
              const stackIdx = arr.length - 1 - idx;
              const k = keyOf(item);
              if (stackIdx === 0) {
                return (
                  <SwipeCard
                    key={k}
                    ref={topCard}
                    item={item}
                    trailerKey={trailerKeys[k]}
                    muted={muted}
                    onToggleMute={toggleMute}
                    isTop
                    onSwipeLeft={() => handleSwipe(false)}
                    onSwipeRight={() => handleSwipe(true)}
                    onPress={() => setSelected(item)}
                  />
                );
              }
              return (
                <View
                  key={k}
                  pointerEvents="none"
                  style={[styles.backCard, { transform: [{ translateY: stackIdx * 10 }, { scale: 1 - stackIdx * 0.04 }], zIndex: -stackIdx }]}
                >
                  <View style={styles.backInner}>
                    <Image source={item.posterUrl} style={StyleSheet.absoluteFill} contentFit="cover" />
                    <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(10,10,15,${0.2 + stackIdx * 0.2})` }]} />
                  </View>
                </View>
              );
            })}
          </View>
          {!!error && <Text style={styles.errorLine}>{error}</Text>}
          <View style={[styles.actions, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
            <TouchableOpacity style={[styles.actionBtn, styles.noBtn]} onPress={() => swipe(false)} accessibilityRole="button" accessibilityLabel="Not for me">
              <Ionicons name="close" size={30} color={Colors.skip} />
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, styles.yesBtn]} onPress={() => swipe(true)} accessibilityRole="button" accessibilityLabel="I'd watch this">
              <Ionicons name="heart" size={30} color={Colors.like} />
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <ScrollView contentContainerStyle={styles.results}>
          {party.status === 'done' ? (
            <Text style={styles.h2}>
              {matches.length ? `You matched on ${matches.length} title${matches.length === 1 ? '' : 's'} 🎉` : 'No matches this time'}
            </Text>
          ) : (
            <View style={styles.waiting}>
              <ActivityIndicator color={Colors.accent} />
              <Text style={styles.muted}>
                You're done! Waiting for {party.with} ({party.theirProgress}/{party.size})
              </Text>
            </View>
          )}
          {matches.length > 0 ? (
            <>
              <Text style={styles.label}>Matches so far</Text>
              <TitleGrid items={matches} empty="" />
            </>
          ) : party.status === 'done' ? (
            <Text style={styles.muted}>Try another party with different services, or switch between Movies and TV.</Text>
          ) : (
            <Text style={styles.muted}>Matches show up here as soon as you both say yes.</Text>
          )}
          <TouchableOpacity style={[styles.goldBtn, { alignSelf: 'center', marginTop: 12 }]} onPress={back}>
            <Text style={styles.goldText}>Back to Social</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      <MediaDetailModal visible={!!selected} item={selected} onClose={() => setSelected(null)} />

      <Modal visible={!!matchItem} transparent animationType="fade" onRequestClose={() => setMatchItem(null)}>
        <View style={styles.matchOverlay}>
          <View style={styles.matchCard}>
            <Text style={styles.matchTitle}>It's a match! 🍿</Text>
            {matchItem?.posterUrl ? <Image source={matchItem.posterUrl} style={styles.matchPoster} contentFit="cover" /> : null}
            <Text style={styles.matchText}>You and {party?.with} both want to watch {matchItem?.title}.</Text>
            <TouchableOpacity style={styles.goldBtn} onPress={() => setMatchItem(null)} accessibilityRole="button">
              <Text style={styles.goldText}>Keep swiping</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8 },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: Colors.textPrimary, fontSize: 18, fontWeight: '800' },
  sub: { color: Colors.textSecondary, fontSize: 12, marginTop: 2 },
  progressTrack: { height: 3, marginHorizontal: 20, borderRadius: 2, backgroundColor: Colors.border, overflow: 'hidden' },
  progressFill: { height: 3, backgroundColor: Colors.accent },
  deck: { flex: 1, marginHorizontal: 12, marginTop: 10, maxWidth: 520, width: '100%', alignSelf: 'center' },
  backCard: { position: 'absolute', width: '100%', height: '100%', padding: 8 },
  backInner: { flex: 1, overflow: 'hidden', borderRadius: 20, backgroundColor: Colors.bgCard, borderColor: Colors.border, borderWidth: 1 },
  actions: { flexDirection: 'row', justifyContent: 'center', gap: 40, paddingTop: 14 },
  actionBtn: { width: 64, height: 64, borderRadius: 32, borderWidth: 2, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bgCard },
  noBtn: { borderColor: Colors.skip },
  yesBtn: { borderColor: Colors.like },
  errorLine: { color: Colors.skip, textAlign: 'center', fontSize: 13, marginTop: 6 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
  bigEmoji: { fontSize: 44 },
  h2: { color: Colors.textPrimary, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  muted: { color: Colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  label: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700', marginTop: 8 },
  results: { padding: 20, gap: 14, maxWidth: 640, width: '100%', alignSelf: 'center' },
  waiting: { alignItems: 'center', gap: 10, paddingVertical: 10 },
  goldBtn: { backgroundColor: Colors.accent, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 22 },
  goldText: { color: '#000', fontWeight: '800', fontSize: 15 },
  matchOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  matchCard: {
    backgroundColor: Colors.bgCard, borderRadius: 24, padding: 24, alignItems: 'center', gap: 14,
    borderWidth: 1, borderColor: Colors.accent, maxWidth: 360, width: '100%',
  },
  matchTitle: { color: Colors.accent, fontSize: 26, fontWeight: '900' },
  matchPoster: { width: 150, height: 225, borderRadius: 14 },
  matchText: { color: Colors.textPrimary, fontSize: 15, textAlign: 'center', lineHeight: 21 },
});
