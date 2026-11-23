import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity,
  ActivityIndicator, Platform, Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { SwipeCard, type SwipeCardHandle, type SwipeDirection } from '@/components/SwipeCard';
import { FilterSheet } from '@/components/FilterSheet';
import { MediaDetailModal } from '@/components/MediaDetailModal';
import { TutorialOverlay } from '@/components/TutorialOverlay';
import { useAppContext } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { fetchTrailerKey, MediaItem } from '@/services/tmdb';
import {
  fetchDeck, keyOf, sendFeedback, sendUndo, syncHistoryOnce, type SwipeAction,
} from '@/services/recs';
import Colors from '@/constants/colors';

/** Fetch the next page once this many cards are left, so the deck never runs dry mid-swipe. */
const REFILL_AT = 6;
const FIRST_PAGE = 15;
const NEXT_PAGE = 20;

function RatingPrompt({
  item,
  onRate,
  onSkip,
}: {
  item: MediaItem;
  onRate: (rating: 'up' | 'meh' | 'down') => void;
  onSkip: () => void;
}) {
  return (
    <Modal visible transparent animationType="fade">
      <View style={promptStyles.overlay}>
        <View style={promptStyles.sheet}>
          <Text style={promptStyles.title}>How was it?</Text>
          <Text style={promptStyles.subtitle} numberOfLines={1}>{item.title}</Text>
          <View style={promptStyles.buttons}>
            <TouchableOpacity
              style={[promptStyles.rateBtn, promptStyles.downBtn]}
              onPress={() => onRate('down')}
              activeOpacity={0.8}
            >
              <Ionicons name="thumbs-down" size={26} color="#E74C3C" />
              <Text style={[promptStyles.rateBtnText, { color: '#E74C3C' }]}>Not great</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[promptStyles.rateBtn, promptStyles.mehBtn]}
              onPress={() => onRate('meh')}
              activeOpacity={0.8}
            >
              <Ionicons name="thumbs-up" size={26} color="#F5C518" style={{ transform: [{ rotate: '90deg' }] }} />
              <Text style={[promptStyles.rateBtnText, { color: '#F5C518' }]}>It was OK</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[promptStyles.rateBtn, promptStyles.upBtn]}
              onPress={() => onRate('up')}
              activeOpacity={0.8}
            >
              <Ionicons name="thumbs-up" size={26} color="#2ECC71" />
              <Text style={[promptStyles.rateBtnText, { color: '#2ECC71' }]}>Loved it</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={onSkip} hitSlop={8}>
            <Text style={promptStyles.skip}>Skip</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const promptStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.bgCard,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 28,
    paddingBottom: Platform.OS === 'web' ? 40 : 48,
    alignItems: 'center',
    gap: 12,
    borderTopWidth: 1,
    borderColor: Colors.border,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: Colors.textPrimary,
  },
  subtitle: {
    fontSize: 14,
    color: Colors.textMuted,
    maxWidth: '80%',
    textAlign: 'center',
  },
  buttons: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  rateBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 16,
    borderWidth: 2,
    gap: 6,
  },
  downBtn: {
    borderColor: '#E74C3C',
    backgroundColor: 'rgba(231,76,60,0.1)',
  },
  mehBtn: {
    borderColor: '#F5C518',
    backgroundColor: 'rgba(245,197,24,0.1)',
  },
  upBtn: {
    borderColor: '#2ECC71',
    backgroundColor: 'rgba(46,204,113,0.1)',
  },
  rateBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  skip: {
    color: Colors.textMuted,
    fontSize: 14,
    paddingVertical: 8,
    paddingHorizontal: 20,
  },
});

export default function DiscoverScreen() {
  const insets = useSafeAreaInsets();
  const {
    filters, setFilters,
    recordSwipe, markWatched, undoLastSwipe, rateWatched, watchedRatings,
    savedItems, skippedItems, watchedItems, cacheDeckItems,
  } = useAppContext();
  const { user } = useAuth();
  const showTutorial = user !== null && !user.hasSeenTutorial;

  const [deck, setDeck] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [fetchingMore, setFetchingMore] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [trailerKeys, setTrailerKeys] = useState<Record<string, string | null>>({});
  const [pendingRatingItem, setPendingRatingItem] = useState<MediaItem | null>(null);
  const [lastSwiped, setLastSwiped] = useState<MediaItem | null>(null);

  const deckRef = useRef<MediaItem[]>([]);
  deckRef.current = deck;
  const servedKeys = useRef(new Set<string>()); // shown this session; excluded from later pages
  const pageInFlight = useRef(false);
  const generation = useRef(0); // bumps on filter change so stale pages are dropped
  const topCardRef = useRef<SwipeCardHandle>(null);
  const trailerFetching = useRef(new Set<string>());

  const loadPage = useCallback(async (reset: boolean) => {
    if (!reset && pageInFlight.current) return;
    const gen = reset ? ++generation.current : generation.current;
    pageInFlight.current = true;
    setFetchingMore(true);
    if (reset) {
      setLoading(true);
      setLoadError(false);
      setExhausted(false);
      servedKeys.current = new Set();
    }
    try {
      const exclude = reset ? [] : [...servedKeys.current];
      const items = await fetchDeck(filters, exclude, reset ? FIRST_PAGE : NEXT_PAGE);
      if (gen !== generation.current) return;

      const fresh = items.filter(i => !servedKeys.current.has(keyOf(i)));
      fresh.forEach(i => servedKeys.current.add(keyOf(i)));
      setDeck(prev => (reset ? fresh : [...prev, ...fresh]));
      if (fresh.length === 0) setExhausted(true);
      cacheDeckItems(fresh);
      // Warm the image cache so the next cards appear instantly.
      Image.prefetch(fresh.slice(0, 8).map(i => i.posterUrl).filter(Boolean)).catch(() => {});
    } catch (e) {
      if (gen !== generation.current) return;
      console.warn('Deck load failed:', e);
      if (reset || deckRef.current.length === 0) setLoadError(true);
    } finally {
      if (gen === generation.current) {
        pageInFlight.current = false;
        setFetchingMore(false);
        if (reset) setLoading(false);
      }
    }
  }, [filters, cacheDeckItems]);

  // (Re)load whenever the filters or the signed-in user change.
  const filtersKey = JSON.stringify(filters);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Swipes kept on this phone from before server accounts: hand them to the recommender once.
      if (user) await syncHistoryOnce(user.id, savedItems, skippedItems, watchedItems, watchedRatings);
      if (!cancelled) loadPage(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, user?.id]);

  // Keep the deck topped up ahead of the user.
  useEffect(() => {
    if (loading || exhausted || loadError) return;
    if (deck.length <= REFILL_AT) loadPage(false);
  }, [deck.length, loading, exhausted, loadError, loadPage]);

  // Trailers for the next few cards.
  const topKeys = deck.slice(0, 3).map(keyOf).join(',');
  useEffect(() => {
    for (const item of deck.slice(0, 3)) {
      const k = keyOf(item);
      if (trailerFetching.current.has(k)) continue;
      trailerFetching.current.add(k);
      fetchTrailerKey(item.type, item.id).then(key => {
        setTrailerKeys(prev => ({ ...prev, [k]: key }));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topKeys]);

  const sendSwipe = (item: MediaItem, action: SwipeAction) => {
    sendFeedback(item, action);
    setLastSwiped(item);
  };

  /** Called once the card has finished flying off screen. */
  const handleSwipe = useCallback((direction: SwipeDirection) => {
    const item = deckRef.current[0];
    if (!item) return;
    const k = keyOf(item);
    setDeck(prev => (prev[0] && keyOf(prev[0]) === k ? prev.slice(1) : prev.filter(i => keyOf(i) !== k)));
    if (direction === 'up') {
      setPendingRatingItem(item);
      return;
    }
    const liked = direction === 'right';
    recordSwipe(item, liked);
    sendSwipe(item, liked ? 'like' : 'skip');
  }, [recordSwipe]);

  /** Buttons animate the card exactly like a swipe does. */
  const swipeTop = (direction: SwipeDirection) => {
    if (deckRef.current.length === 0) return;
    if (topCardRef.current) topCardRef.current.swipe(direction);
    else handleSwipe(direction);
  };

  const handleUndo = useCallback(() => {
    const item = lastSwiped;
    if (!item) return;
    undoLastSwipe();
    sendUndo(item);
    setDeck(prev => [item, ...prev.filter(i => keyOf(i) !== keyOf(item))]);
    setLastSwiped(null);
  }, [lastSwiped, undoLastSwipe]);

  const hasActiveFilters =
    filters.genres.length > 0 ||
    filters.minRating > 0 ||
    filters.contentType !== 'all' ||
    filters.era !== 'all' ||
    filters.streaming.length > 0 ||
    filters.inTheaters ||
    filters.maxRuntime !== null;

  const paddingTop = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const currentItem = deck[0] ?? null;

  const emptyTitle = hasActiveFilters ? 'No more matches' : "You've seen it all!";
  const emptyDesc = filters.streaming.length > 0
    ? 'Nothing else on those services matches. Try another service or loosen your filters.'
    : filters.era === 'new'
    ? 'No more recent releases match. Try "Any" release year or loosen other filters.'
    : filters.era === 'classic'
    ? 'No more oldies match. Try "Any" release year or loosen other filters.'
    : filters.inTheaters
    ? 'No more currently-playing movies matched. Try clearing In Theaters.'
    : hasActiveFilters
    ? 'Try loosening your filters.'
    : 'Check back later for new picks.';

  return (
    <View style={[styles.container, { paddingTop }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>MOVEE</Text>
        <TouchableOpacity style={styles.filterButton} onPress={() => setShowFilters(true)}>
          <Ionicons name="options" size={24} color={Colors.accent} />
          {hasActiveFilters && (
            <View style={styles.filterBadge} />
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.cardContainer}>
        {loading ? (
          <View style={styles.emptyState}>
            <ActivityIndicator size="large" color={Colors.accent} />
            <Text style={styles.loadingText}>Finding picks for you…</Text>
          </View>
        ) : loadError && deck.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="wifi-outline" size={56} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>Connection failed</Text>
            <Text style={styles.emptyDesc}>Check your connection and retry.</Text>
            <TouchableOpacity style={styles.refreshButton} onPress={() => loadPage(true)}>
              <Text style={styles.refreshButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : deck.length === 0 ? (
          <View style={styles.emptyState}>
            {fetchingMore && !exhausted ? (
              <>
                <ActivityIndicator size="large" color={Colors.accent} />
                <Text style={styles.loadingText}>Finding more…</Text>
              </>
            ) : (
              <>
                <Ionicons name="film-outline" size={56} color={Colors.textMuted} />
                <Text style={styles.emptyTitle}>{emptyTitle}</Text>
                <Text style={styles.emptyDesc}>{emptyDesc}</Text>
                <View style={styles.emptyActions}>
                  {hasActiveFilters && (
                    <TouchableOpacity style={styles.secondaryButton} onPress={() => setShowFilters(true)}>
                      <Text style={styles.secondaryButtonText}>Filters</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity style={styles.refreshButton} onPress={() => loadPage(true)}>
                    <Text style={styles.refreshButtonText}>Refresh</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        ) : (
          deck.slice(0, 3).reverse().map((item, idx, arr) => {
            const stackIdx = arr.length - 1 - idx;
            const k = keyOf(item);

            if (stackIdx === 0) {
              return (
                <SwipeCard
                  key={k}
                  ref={topCardRef}
                  item={item}
                  trailerKey={trailerKeys[k]}
                  isTop
                  onSwipeLeft={() => handleSwipe('left')}
                  onSwipeRight={() => handleSwipe('right')}
                  onSwipeUp={() => handleSwipe('up')}
                  onPress={() => setSelectedItem(item)}
                />
              );
            }

            // The real next poster sits underneath, so it's already there as the top card leaves.
            return (
              <View
                key={k}
                pointerEvents="none"
                style={[
                  styles.backgroundCard,
                  {
                    transform: [
                      { translateY: stackIdx * 10 },
                      { scale: 1 - stackIdx * 0.04 },
                    ],
                    zIndex: -stackIdx,
                  },
                ]}
              >
                <View style={styles.cardInnerBack}>
                  <Image source={item.posterUrl} style={StyleSheet.absoluteFill} contentFit="cover" />
                  <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(10,10,15,${0.2 + stackIdx * 0.2})` }]} />
                </View>
              </View>
            );
          })
        )}
      </View>

      <View style={[styles.actionRow, {
        paddingBottom: Platform.OS === 'web' ? 100 : Math.max(insets.bottom + 60, 80),
      }]}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.skipBtn]}
          onPress={() => swipeTop('left')}
          disabled={deck.length === 0}
        >
          <Ionicons name="close" size={30} color={Colors.skip} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.watchedBtn]}
          onPress={() => swipeTop('up')}
          disabled={deck.length === 0}
        >
          <Ionicons name="checkmark-done" size={24} color="#7B68EE" />
          <Text style={styles.watchedBtnLabel}>Seen</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.likeBtn]}
          onPress={() => swipeTop('right')}
          disabled={deck.length === 0}
        >
          <Ionicons name="heart" size={30} color={Colors.like} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.undoBtn, !lastSwiped && styles.undoBtnDisabled]}
          onPress={handleUndo}
          disabled={!lastSwiped}
        >
          <Ionicons name="arrow-undo" size={22} color={lastSwiped ? Colors.accent : Colors.textMuted} />
        </TouchableOpacity>
      </View>

      <FilterSheet
        visible={showFilters}
        onClose={() => setShowFilters(false)}
        filters={filters}
        onApply={setFilters}
      />

      <MediaDetailModal
        visible={!!selectedItem}
        item={selectedItem}
        onClose={() => setSelectedItem(null)}
        onLike={() => { setSelectedItem(null); if (currentItem) swipeTop('right'); }}
        onSkip={() => { setSelectedItem(null); if (currentItem) swipeTop('left'); }}
        onWatched={() => { setSelectedItem(null); if (currentItem) swipeTop('up'); }}
      />

      {pendingRatingItem && (
        <RatingPrompt
          item={pendingRatingItem}
          onRate={(rating) => {
            markWatched(pendingRatingItem);
            rateWatched(pendingRatingItem.id, rating);
            sendSwipe(pendingRatingItem, `seen_${rating}`);
            setPendingRatingItem(null);
          }}
          onSkip={() => {
            markWatched(pendingRatingItem);
            sendSwipe(pendingRatingItem, 'seen');
            setPendingRatingItem(null);
          }}
        />
      )}

      <TutorialOverlay visible={showTutorial} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: Colors.accent,
    letterSpacing: 2,
  },
  filterButton: { padding: 8, position: 'relative' },
  filterBadge: {
    position: 'absolute',
    top: 6, right: 6,
    width: 8, height: 8,
    borderRadius: 4,
    backgroundColor: Colors.like,
  },
  cardContainer: {
    flex: 1,
    marginHorizontal: 12,
    marginTop: 6,
    marginBottom: 12,
    position: 'relative',
  },
  backgroundCard: {
    position: 'absolute',
    width: '100%', height: '100%',
    padding: 8,
  },
  cardInnerBack: {
    flex: 1,
    overflow: 'hidden',
    borderRadius: 20,
    backgroundColor: Colors.bgCard,
    borderColor: Colors.border,
    borderWidth: 1,
  },
  emptyState: {
    flex: 1, alignItems: 'center',
    justifyContent: 'center',
    padding: 24, gap: 12,
  },
  loadingText: { color: Colors.textMuted, fontSize: 15, marginTop: 8 },
  emptyTitle: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary },
  emptyDesc: { fontSize: 15, color: Colors.textMuted, textAlign: 'center' },
  refreshButton: {
    backgroundColor: Colors.accent,
    paddingHorizontal: 28, paddingVertical: 12,
    borderRadius: 24, marginTop: 8,
  },
  refreshButtonText: { color: '#000', fontWeight: '800', fontSize: 15 },
  emptyActions: { flexDirection: 'row', gap: 12 },
  secondaryButton: {
    borderColor: Colors.accent, borderWidth: 1.5,
    paddingHorizontal: 24, paddingVertical: 12,
    borderRadius: 24, marginTop: 8,
  },
  secondaryButtonText: { color: Colors.accent, fontWeight: '800', fontSize: 15 },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 24,
    paddingHorizontal: 20,
  },
  actionBtn: {
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 32, borderWidth: 2,
    backgroundColor: Colors.bgCard,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 6,
    elevation: 8,
  },
  skipBtn: { width: 60, height: 60, borderRadius: 30, borderColor: Colors.skip },
  watchedBtn: {
    width: 72, height: 72, borderRadius: 36,
    borderColor: '#7B68EE', gap: 2,
  },
  watchedBtnLabel: { color: '#7B68EE', fontSize: 10, fontWeight: '700' },
  likeBtn: { width: 60, height: 60, borderRadius: 30, borderColor: Colors.like },
  undoBtn: { width: 46, height: 46, borderRadius: 23, borderColor: Colors.accent },
  undoBtnDisabled: { borderColor: Colors.border, opacity: 0.45 },
});
