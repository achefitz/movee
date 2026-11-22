import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity,
  ActivityIndicator, Platform, Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { SwipeCard } from '@/components/SwipeCard';
import { FilterSheet } from '@/components/FilterSheet';
import { MediaDetailModal } from '@/components/MediaDetailModal';
import { TutorialOverlay } from '@/components/TutorialOverlay';
import { useAppContext } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { fetchBulkContent, fetchTrailerKey, fetchWatchProviders, fetchSimilarIds, fetchKeywords, fetchCredits, MediaItem } from '@/services/tmdb';
import { buildTaste, calibrationSort, sortByRecommendation } from '@/services/recommendations';
import Colors from '@/constants/colors';

const GENRE_NAMES: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
  10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
  10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

function enrichGenres(items: MediaItem[]): MediaItem[] {
  return items.map(item => ({
    ...item,
    genreNames: item.genres.map(id => GENRE_NAMES[id]).filter(Boolean),
  }));
}

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
    filters, setFilters, swipedIds,
    recordSwipe, markWatched, undoLastSwipe, rateWatched, watchedRatings,
    savedItems, skippedItems, watchedItems, cacheDeckItems,
  } = useAppContext();
  const [canUndo, setCanUndo] = useState(false);
  const lastSwipedItemRef = useRef<MediaItem | null>(null);
  const { user } = useAuth();
  const showTutorial = user !== null && !user.hasSeenTutorial;

  const [allItems, setAllItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [trailerKeys, setTrailerKeys] = useState<Record<number, string | null>>({});
  const [providerMap, setProviderMap] = useState<Record<string, { streamingIds: number[]; watchLink: string | null }>>({});
  const [providersFetching, setProvidersFetching] = useState(0);
  const [keywordMap, setKeywordMap] = useState<Record<number, string[]>>({});
  const [castMap, setCastMap] = useState<Record<number, number[]>>({});
  const [pendingRatingItem, setPendingRatingItem] = useState<MediaItem | null>(null);

  const seenItemIds = useRef(new Set<string>());
  const trailerFetching = useRef(new Set<number>());
  const providerFetching = useRef(new Set<string>());
  const providerQueue = useRef<MediaItem[]>([]);
  const providerActiveCount = useRef(0);
  const providerGeneration = useRef(0);
  const runNextProvider = useRef<() => void>(() => {});
  const abortRef = useRef<AbortController | null>(null);

  const collaborativeMap = useRef<Map<number, number[]>>(new Map());
  const collaborativeFetching = useRef<Set<number>>(new Set());

  const richQueue = useRef<MediaItem[]>([]);
  const richActiveCount = useRef(0);
  const richFetching = useRef(new Set<number>());
  const runNextRich = useRef<() => void>(() => {});

  const maxRuntimeRef = useRef<number | null>(null);

  const loadContent = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setLoadError(false);
    setAllItems([]);
    setProviderMap({});
    seenItemIds.current.clear();
    trailerFetching.current.clear();
    providerFetching.current.clear();
    providerQueue.current = [];
    providerActiveCount.current = 0;
    providerGeneration.current++;
    setProvidersFetching(0);

    const maxRuntime = maxRuntimeRef.current;
    let gotFirst = false;

    try {
      await fetchBulkContent((batch) => {
        if (controller.signal.aborted) return;

        const newItems: MediaItem[] = [];
        const theaterMergeKeys = new Set<string>();
        const streamingMergeMap = new Map<string, number[]>();

        for (const item of batch) {
          const key = `${item.type}_${item.id}`;
          if (!seenItemIds.current.has(key)) {
            seenItemIds.current.add(key);
            newItems.push(item);
          } else if (item.inTheaters) {
            theaterMergeKeys.add(key);
          } else if (item.streamingIds.length > 0) {
            streamingMergeMap.set(key, item.streamingIds);
          }
        }

        for (let i = 0; i < newItems.length; i++) {
          const key = `${newItems[i].type}_${newItems[i].id}`;
          if (streamingMergeMap.has(key)) {
            const incoming = streamingMergeMap.get(key)!;
            const merged = [...new Set([...newItems[i].streamingIds, ...incoming])];
            newItems[i] = { ...newItems[i], streamingIds: merged };
            streamingMergeMap.delete(key);
          }
        }

        const hasMerges = theaterMergeKeys.size > 0 || streamingMergeMap.size > 0;
        if (hasMerges) {
          setAllItems(prev => prev.map(m => {
            const key = `${m.type}_${m.id}`;
            let updated = m;
            if (theaterMergeKeys.has(key)) updated = { ...updated, inTheaters: true };
            if (streamingMergeMap.has(key)) {
              const incoming = streamingMergeMap.get(key)!;
              const merged = [...new Set([...updated.streamingIds, ...incoming])];
              updated = { ...updated, streamingIds: merged };
            }
            return updated;
          }));
        }

        if (newItems.length === 0) return;
        const enriched = enrichGenres(newItems);

        setAllItems(prev => [...prev, ...enriched]);
        cacheDeckItems(enriched);

        if (!gotFirst) {
          gotFirst = true;
          setLoading(false);
        }
      }, controller.signal, maxRuntime != null ? { maxRuntime } : undefined);
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        console.error('Load error:', e);
        setLoadError(true);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    maxRuntimeRef.current = filters.maxRuntime;
    loadContent();
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (maxRuntimeRef.current === filters.maxRuntime) return;
    maxRuntimeRef.current = filters.maxRuntime;
    loadContent();
  }, [filters.maxRuntime]);

  const deck = useMemo(() => {
    let pool = allItems.filter(m => !swipedIds.has(m.id));
    if (filters.contentType === 'movie') pool = pool.filter(m => m.type === 'movie');
    if (filters.contentType === 'tv') pool = pool.filter(m => m.type === 'tv');
    if (filters.inTheaters) pool = pool.filter(m => m.inTheaters);
    if (filters.genres.length > 0) pool = pool.filter(m => m.genres.some(g => filters.genres.includes(g)));
    if (filters.minRating > 0) pool = pool.filter(m => m.rating >= filters.minRating);
    if (filters.maxRuntime != null) {
      pool = pool.filter(m => {
        if (m.type !== 'movie') return true;
        if (!m.runtimeMinutes) return true;
        return m.runtimeMinutes <= filters.maxRuntime!;
      });
    }
    if (filters.streaming.length > 0) {
      pool = pool.filter(m => {
        const key = `${m.type}_${m.id}`;
        const providers = providerMap[key];
        const ids = providers ? providers.streamingIds : m.streamingIds;
        return ids.some(id => filters.streaming.includes(id));
      });
    }

    const totalSwipes = savedItems.length + skippedItems.length + watchedItems.length;

    if (totalSwipes < 10) {
      // Phase 1 (0–9 swipes): calibration — genre-diverse deck, no personalisation
      return calibrationSort(pool);
    }

    if (totalSwipes < 30) {
      // Phase 2 (10–29 swipes): warm-up — genre/era weighting only, no franchise tunnelling
      const taste = buildTaste(savedItems, skippedItems, watchedItems, collaborativeMap.current, keywordMap, castMap, watchedRatings);
      return sortByRecommendation(pool, taste, keywordMap, castMap, {
        swipeCount: totalSwipes,
        warmupOnly: true,
      });
    }

    // Phase 3 (30+ swipes): full personalisation with diversity guardrails
    const taste = buildTaste(savedItems, skippedItems, watchedItems, collaborativeMap.current, keywordMap, castMap, watchedRatings);
    return sortByRecommendation(pool, taste, keywordMap, castMap, { swipeCount: totalSwipes });
  }, [allItems, swipedIds, filters, providerMap, savedItems, skippedItems, watchedItems, keywordMap, castMap, watchedRatings]);

  const enrichedDeck = useMemo(() => {
    return deck.map(item => {
      const key = `${item.type}_${item.id}`;
      const providers = providerMap[key];
      if (!providers) return item;
      return {
        ...item,
        streamingIds: providers.streamingIds,
        watchLink: providers.watchLink,
      };
    });
  }, [deck, providerMap]);

  useEffect(() => {
    if (deck.length === 0) return;
    const toFetch = deck.slice(0, 5).filter(
      item => !trailerFetching.current.has(item.id) && !(item.id in trailerKeys)
    );
    for (const item of toFetch) {
      trailerFetching.current.add(item.id);
      fetchTrailerKey(item.type, item.id).then(key => {
        setTrailerKeys(prev => ({ ...prev, [item.id]: key }));
      });
    }
  }, [deck.length > 0 ? deck[0]?.id : 0]);

  const candidatePool = useMemo(() => {
    return allItems.filter(m => !swipedIds.has(m.id));
  }, [allItems, swipedIds]);

  runNextProvider.current = () => {
    const CONCURRENT = 6;
    while (providerActiveCount.current < CONCURRENT && providerQueue.current.length > 0) {
      const item = providerQueue.current.shift()!;
      const key = `${item.type}_${item.id}`;
      const gen = providerGeneration.current;
      providerActiveCount.current++;
      setProvidersFetching(n => n + 1);
      fetchWatchProviders(item.type, item.id).then(data => {
        providerActiveCount.current--;
        setProvidersFetching(n => Math.max(0, n - 1));
        if (gen === providerGeneration.current) {
          setProviderMap(prev => ({ ...prev, [key]: data }));
        }
        runNextProvider.current();
      });
    }
  };

  runNextRich.current = () => {
    const CONCURRENT = 4;
    while (richActiveCount.current < CONCURRENT && richQueue.current.length > 0) {
      const item = richQueue.current.shift()!;
      richActiveCount.current++;
      Promise.all([
        fetchKeywords(item.type, item.id),
        fetchCredits(item.type, item.id),
      ]).then(([keywords, castIds]) => {
        richActiveCount.current--;
        setKeywordMap(prev => ({ ...prev, [item.id]: keywords }));
        setCastMap(prev => ({ ...prev, [item.id]: castIds }));
        runNextRich.current();
      }).catch(() => {
        richActiveCount.current--;
        richFetching.current.delete(item.id);
        runNextRich.current();
      });
    }
  };

  useEffect(() => {
    const MAX_LIKED = 50;
    const toFetch = savedItems.slice(-MAX_LIKED).filter(item => !richFetching.current.has(item.id));
    for (const item of toFetch) {
      richFetching.current.add(item.id);
      richQueue.current.push(item);
    }
    if (toFetch.length > 0) runNextRich.current();
  }, [savedItems]);

  useEffect(() => {
    if (candidatePool.length === 0) return;
    const PROVIDER_PREFETCH = filters.streaming.length > 0 ? 200 : 80;
    const toEnqueue = candidatePool.slice(0, PROVIDER_PREFETCH).filter(item => {
      const key = `${item.type}_${item.id}`;
      return !providerFetching.current.has(key);
    });
    for (const item of toEnqueue) {
      const key = `${item.type}_${item.id}`;
      providerFetching.current.add(key);
      providerQueue.current.push(item);
    }
    runNextProvider.current();
  }, [candidatePool.length > 0 ? candidatePool[0]?.id : 0, candidatePool.length, filters.streaming.length > 0]);

  useEffect(() => {
    if (Object.keys(providerMap).length === 0) return;
    setAllItems(prev => prev.map(item => {
      const key = `${item.type}_${item.id}`;
      const providers = providerMap[key];
      if (!providers) return item;
      if (item.streamingIds === providers.streamingIds && item.watchLink === providers.watchLink) return item;
      return { ...item, streamingIds: providers.streamingIds, watchLink: providers.watchLink };
    }));
  }, [providerMap]);

  useEffect(() => {
    if (filters.streaming.length === 0) return;
    if (enrichedDeck.length > 0) return;
    if (providersFetching > 0) return;
    if (candidatePool.length === 0) return;
    const currentWindow = providerFetching.current.size;
    const EXPAND_BY = 20;
    const toEnqueue = candidatePool.slice(currentWindow, currentWindow + EXPAND_BY).filter(item => {
      const key = `${item.type}_${item.id}`;
      return !providerFetching.current.has(key);
    });
    if (toEnqueue.length === 0) return;
    for (const item of toEnqueue) {
      const key = `${item.type}_${item.id}`;
      providerFetching.current.add(key);
      providerQueue.current.push(item);
    }
    runNextProvider.current();
  }, [filters.streaming.length, enrichedDeck.length, providersFetching, candidatePool.length]);

  const handleSwipe = useCallback((direction: 'left' | 'right' | 'up') => {
    if (enrichedDeck.length === 0) return;
    let item = enrichedDeck[0];
    if (!item.streamingIds || item.streamingIds.length === 0) {
      const key = `${item.type}_${item.id}`;
      const providers = providerMap[key];
      if (providers) {
        item = { ...item, streamingIds: providers.streamingIds, watchLink: providers.watchLink };
      }
    }
    lastSwipedItemRef.current = item;
    setCanUndo(true);
    if (direction === 'up') {
      setPendingRatingItem(item);
    } else {
      recordSwipe(item, direction === 'right');
      if (direction === 'right' && !collaborativeFetching.current.has(item.id)) {
        collaborativeFetching.current.add(item.id);
        const sourceGenres = item.genres;
        fetchSimilarIds(item.type, item.id).then(ids => {
          // Cap at top 2 per source — beyond that, same-source items get no boost
          ids.slice(0, 2).forEach(id => {
            if (!collaborativeMap.current.has(id)) {
              collaborativeMap.current.set(id, sourceGenres);
            }
          });
        });
      }
    }
  }, [enrichedDeck, providerMap, recordSwipe, markWatched]);

  const handleUndo = useCallback(() => {
    undoLastSwipe();
    setCanUndo(false);
    lastSwipedItemRef.current = null;
  }, [undoLastSwipe]);

  const hasActiveFilters =
    filters.genres.length > 0 ||
    filters.minRating > 0 ||
    filters.contentType !== 'all' ||
    filters.streaming.length > 0 ||
    filters.inTheaters ||
    filters.maxRuntime !== null;

  const paddingTop = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const currentItem = deck[0] ?? null;

  return (
    <View style={[styles.container, { paddingTop }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>MUSE</Text>
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
            <Text style={styles.loadingText}>Fetching movies & shows…</Text>
          </View>
        ) : loadError ? (
          <View style={styles.emptyState}>
            <Ionicons name="wifi-outline" size={56} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>Connection failed</Text>
            <Text style={styles.emptyDesc}>Check your connection and retry.</Text>
            <TouchableOpacity style={styles.refreshButton} onPress={loadContent}>
              <Text style={styles.refreshButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : enrichedDeck.length === 0 ? (
          <View style={styles.emptyState}>
            {filters.streaming.length > 0 && providersFetching > 0 ? (
              <ActivityIndicator size="large" color={Colors.accent} />
            ) : (
              <Ionicons name="film-outline" size={56} color={Colors.textMuted} />
            )}
            <Text style={styles.emptyTitle}>
              {filters.streaming.length > 0 && providersFetching > 0
                ? 'Checking platforms…'
                : filters.streaming.length > 0
                ? 'No matches found'
                : filters.inTheaters
                ? 'No films in theaters'
                : filters.maxRuntime
                ? `No short films found`
                : "You've seen it all!"}
            </Text>
            <Text style={styles.emptyDesc}>
              {filters.streaming.length > 0 && providersFetching > 0
                ? 'Verifying which titles are available on selected platforms.'
                : filters.streaming.length > 0
                ? 'No titles found on those platforms. Try different services or clear filters.'
                : filters.inTheaters
                ? 'No currently-playing movies matched. Try clearing the In Theaters filter.'
                : filters.maxRuntime
                ? `No movies found under ${filters.maxRuntime < 120 ? '1.5' : filters.maxRuntime === 120 ? '2' : '2.5'} hours. Try a longer runtime or clear the filter.`
                : 'Try changing your filters or refresh.'}
            </Text>
            <TouchableOpacity style={styles.refreshButton} onPress={loadContent}>
              <Text style={styles.refreshButtonText}>Refresh</Text>
            </TouchableOpacity>
          </View>
        ) : (
          enrichedDeck.slice(0, 3).reverse().map((item, idx, arr) => {
            const stackIdx = arr.length - 1 - idx;
            const isTop = stackIdx === 0;

            if (isTop) {
              return (
                <SwipeCard
                  key={item.type + '_' + item.id}
                  item={item}
                  trailerKey={trailerKeys[item.id]}
                  isTop
                  onSwipeLeft={() => handleSwipe('left')}
                  onSwipeRight={() => handleSwipe('right')}
                  onSwipeUp={() => handleSwipe('up')}
                  onPress={() => setSelectedItem(item)}
                />
              );
            }

            return (
              <View
                key={item.type + '_' + item.id}
                style={[
                  styles.backgroundCard,
                  {
                    transform: [
                      { translateY: stackIdx * 14 },
                      { scale: 1 - stackIdx * 0.05 },
                    ],
                    zIndex: -stackIdx,
                    opacity: 1 - stackIdx * 0.2,
                  },
                ]}
              >
                <View style={styles.cardInnerBack} />
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
          onPress={() => handleSwipe('left')}
          disabled={enrichedDeck.length === 0}
        >
          <Ionicons name="close" size={30} color={Colors.skip} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.watchedBtn]}
          onPress={() => handleSwipe('up')}
          disabled={enrichedDeck.length === 0}
        >
          <Ionicons name="checkmark-done" size={24} color="#7B68EE" />
          <Text style={styles.watchedBtnLabel}>Seen</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.likeBtn]}
          onPress={() => handleSwipe('right')}
          disabled={enrichedDeck.length === 0}
        >
          <Ionicons name="heart" size={30} color={Colors.like} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.undoBtn, !canUndo && styles.undoBtnDisabled]}
          onPress={handleUndo}
          disabled={!canUndo}
        >
          <Ionicons name="arrow-undo" size={22} color={canUndo ? Colors.accent : Colors.textMuted} />
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
        onLike={() => { if (currentItem) handleSwipe('right'); setSelectedItem(null); }}
        onSkip={() => { if (currentItem) handleSwipe('left'); setSelectedItem(null); }}
        onWatched={() => { if (currentItem) handleSwipe('up'); setSelectedItem(null); }}
      />

      {pendingRatingItem && (
        <RatingPrompt
          item={pendingRatingItem}
          onRate={(rating) => {
            markWatched(pendingRatingItem);
            rateWatched(pendingRatingItem.id, rating);
            setPendingRatingItem(null);
          }}
          onSkip={() => {
            markWatched(pendingRatingItem);
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
