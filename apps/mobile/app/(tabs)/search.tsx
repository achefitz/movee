import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, Keyboard, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import Colors from '@/constants/colors';
import { useAppContext } from '@/context/AppContext';
import { MediaDetailModal } from '@/components/MediaDetailModal';
import { keyOf, logSearchClick, searchTitles, type SearchResult } from '@/services/recs';
import type { MediaItem } from '@/services/tmdb';

const DEBOUNCE_MS = 350;
const WATCHED = '#7B68EE';

type Status = 'saved' | 'watched' | null;

/** Search movies and shows by name; add them to the Watchlist or mark them watched. */
export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const { savedItems, watchedItems, addFromSearch, removeFromSaved, removeFromWatched } = useAppContext();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState('');
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const abort = useRef<AbortController | null>(null);

  // What you've saved or watched, from your own lists (they follow your account).
  const status = useMemo(() => {
    const m = new Map<string, Status>();
    for (const i of savedItems) m.set(keyOf(i), 'saved');
    for (const i of watchedItems) m.set(keyOf(i), 'watched');
    return m;
  }, [savedItems, watchedItems]);
  const statusOf = (item: MediaItem): Status => status.get(keyOf(item)) ?? null;

  useEffect(() => {
    const q = query.trim();
    abort.current?.abort();
    if (q.length < 2) {
      setResults([]); setLoading(false); setError(''); setSearched('');
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const t = setTimeout(async () => {
      try {
        const items = await searchTitles(q, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setResults(items); setSearched(q); setError('');
      } catch (e: any) {
        if (ctrl.signal.aborted || e?.name === 'AbortError') return;
        setError("Couldn't search right now. Check your connection and try again.");
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);

  const toggle = (item: MediaItem, to: 'saved' | 'watched') => {
    const cur = statusOf(item);
    if (cur === to) {
      if (to === 'saved') removeFromSaved(item.id);
      else removeFromWatched(item.id);
    } else {
      addFromSearch(item, to);
    }
  };

  const open = (item: MediaItem) => {
    Keyboard.dismiss();
    setSelected(item);
    logSearchClick(item, query.trim());
  };

  const top = Platform.OS === 'web' ? Math.max(insets.top, 12) : insets.top;
  const q = query.trim();

  return (
    <View style={[styles.container, { paddingTop: top }]}>
      <Text style={styles.header}>Search</Text>
      <View style={styles.inputWrap}>
        <Ionicons name="search" size={18} color={Colors.textMuted} />
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder="Movies and TV shows"
          placeholderTextColor={Colors.textMuted}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="never"
          accessibilityLabel="Search movies and TV shows"
        />
        {loading ? <ActivityIndicator size="small" color={Colors.accent} /> : null}
        {!!query && !loading && (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {q.length < 2 ? (
        <View style={styles.empty}>
          <Ionicons name="search-outline" size={44} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>Find something to watch</Text>
          <Text style={styles.emptyText}>
            Look up any movie or show and add it to your Watchlist. What you add here counts extra
            toward your recommendations.
          </Text>
        </View>
      ) : error ? (
        <View style={styles.empty}><Text style={styles.emptyText}>{error}</Text></View>
      ) : !loading && searched === q && results.length === 0 ? (
        <View style={styles.empty}><Text style={styles.emptyText}>No movies or shows match “{q}”.</Text></View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={i => keyOf(i)}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 16) + 80 }}
          renderItem={({ item }) => {
            const st = statusOf(item);
            return (
              <View style={styles.row}>
                <TouchableOpacity
                  style={styles.rowMain}
                  onPress={() => open(item)}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityLabel={`Details for ${item.title}`}
                >
                  <View style={styles.poster}>
                    {item.posterUrl ? <Image source={item.posterUrl} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
                  </View>
                  <View style={styles.info}>
                    <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
                    <View style={styles.meta}>
                      <View style={styles.typeBadge}>
                        <Text style={styles.typeText}>{item.type === 'movie' ? 'MOVIE' : 'TV'}</Text>
                      </View>
                      {item.year ? <Text style={styles.metaText}>{item.year}</Text> : null}
                      {item.rating > 0 ? (
                        <>
                          <Ionicons name="star" size={11} color={Colors.accent} />
                          <Text style={styles.metaText}>{item.rating.toFixed(1)}</Text>
                        </>
                      ) : null}
                    </View>
                    {item.genreNames.length > 0 ? (
                      <Text style={styles.genres} numberOfLines={1}>{item.genreNames.slice(0, 2).join(', ')}</Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.action, st === 'saved' && styles.actionSaved]}
                    onPress={() => toggle(item, 'saved')}
                    accessibilityRole="button"
                    accessibilityLabel={st === 'saved' ? `Remove ${item.title} from Watchlist` : `Add ${item.title} to Watchlist`}
                    accessibilityState={{ selected: st === 'saved' }}
                  >
                    <Ionicons name={st === 'saved' ? 'bookmark' : 'bookmark-outline'} size={18} color={st === 'saved' ? '#000' : Colors.accent} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.action, st === 'watched' && styles.actionWatched]}
                    onPress={() => toggle(item, 'watched')}
                    accessibilityRole="button"
                    accessibilityLabel={st === 'watched' ? `Unmark ${item.title} as watched` : `Mark ${item.title} as watched`}
                    accessibilityState={{ selected: st === 'watched' }}
                  >
                    <Ionicons name="checkmark-done" size={18} color={st === 'watched' ? '#fff' : WATCHED} />
                  </TouchableOpacity>
                </View>
              </View>
            );
          }}
        />
      )}

      <MediaDetailModal
        visible={!!selected}
        item={selected}
        onClose={() => setSelected(null)}
        onLike={selected && statusOf(selected) !== 'saved' ? () => { addFromSearch(selected, 'saved'); setSelected(null); } : undefined}
        onWatched={selected && statusOf(selected) !== 'watched' ? () => { addFromSearch(selected, 'watched'); setSelected(null); } : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { color: Colors.textPrimary, fontSize: 28, fontWeight: '800', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginBottom: 12,
    paddingHorizontal: 14, height: 46, borderRadius: 14, backgroundColor: Colors.bgCard,
    borderWidth: 1, borderColor: Colors.border,
  },
  input: {
    flex: 1, color: Colors.textPrimary, fontSize: 16, height: '100%',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
  },
  empty: { alignItems: 'center', paddingHorizontal: 36, paddingTop: 70, gap: 10 },
  emptyTitle: { color: Colors.textPrimary, fontSize: 18, fontWeight: '800' },
  emptyText: { color: Colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
  poster: { width: 52, height: 78, borderRadius: 8, overflow: 'hidden', backgroundColor: Colors.bgCard },
  info: { flex: 1, minWidth: 0, gap: 4 },
  title: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { color: Colors.textSecondary, fontSize: 12 },
  typeBadge: { backgroundColor: Colors.bgElevated, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  typeText: { color: Colors.textSecondary, fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  genres: { color: Colors.textMuted, fontSize: 12 },
  actions: { flexDirection: 'row', gap: 8 },
  action: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: Colors.border, backgroundColor: Colors.bgCard,
  },
  actionSaved: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  actionWatched: { backgroundColor: WATCHED, borderColor: WATCHED },
});
