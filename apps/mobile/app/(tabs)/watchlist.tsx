import React, { useState, useRef, useCallback, useMemo } from 'react';
import {
  StyleSheet, Text, View, FlatList, TouchableOpacity, TextInput,
  Platform, Alert, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { confirmAction } from '@/utils/confirm';
import Colors from '@/constants/colors';
import { useAppContext } from '@/context/AppContext';
import { MediaItem } from '@/services/tmdb';
import { shareItem } from '@/utils/share';
import { MediaDetailModal } from '@/components/MediaDetailModal';
import { sendFeedback } from '@/services/recs';

type Thumbs = 'up' | 'meh' | 'down';

/** Your rating of a watched title: 1–5 stars plus 👎 / 👌 / 👍, kept in sync (1–2★ 👎, 3★ 👌, 4–5★ 👍). */
function RatingBar({ title, rating, stars, onChange }: {
  title: string;
  rating?: Thumbs;
  stars?: number;
  onChange: (r: { rating?: Thumbs; stars?: number | null }) => void;
}) {
  const thumbs: Array<{ v: Thumbs; icon: 'thumbs-down' | 'thumbs-up'; color: string; label: string; rotate?: boolean }> = [
    { v: 'down', icon: 'thumbs-down', color: '#E74C3C', label: 'Not great' },
    { v: 'meh', icon: 'thumbs-up', color: '#F5C518', label: 'It was OK', rotate: true },
    { v: 'up', icon: 'thumbs-up', color: '#2ECC71', label: 'Loved it' },
  ];
  return (
    <View style={styles.ratingBar}>
      <View style={styles.stars}>
        {[1, 2, 3, 4, 5].map(n => (
          <TouchableOpacity
            key={n}
            onPress={() => onChange({ stars: stars === n ? null : n })}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={stars === n ? `Clear your ${n}-star rating of ${title}` : `Rate ${title} ${n} out of 5`}
            accessibilityState={{ selected: !!stars && n <= stars }}
          >
            <Ionicons name={stars && n <= stars ? 'star' : 'star-outline'} size={22} color={stars && n <= stars ? Colors.accent : Colors.textMuted} />
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.thumbs}>
        {thumbs.map(t => {
          const on = rating === t.v;
          return (
            <TouchableOpacity
              key={t.v}
              style={[styles.thumbBtn, on && { backgroundColor: t.color + '26', borderColor: t.color }]}
              onPress={() => onChange({ rating: t.v })}
              accessibilityRole="button"
              accessibilityLabel={`${t.label}: ${title}`}
              accessibilityState={{ selected: on }}
            >
              <Ionicons
                name={t.icon}
                size={15}
                color={on ? t.color : Colors.textMuted}
                style={t.rotate ? { transform: [{ rotate: '90deg' }] } : undefined}
              />
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

type SubTab = 'towatch' | 'watched';

function MediaRow({
  item,
  onRemove,
  onOpen,
  onCheck,
  showCheck,
  rating,
  stars,
  onRate,
}: {
  item: MediaItem;
  onRemove: () => void;
  onOpen: () => void;
  onCheck?: () => void;
  showCheck?: boolean;
  rating?: Thumbs;
  stars?: number;
  /** Watched titles only: change the rating. */
  onRate?: (r: { rating?: Thumbs; stars?: number | null }) => void;
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const opacityAnim = useRef(new Animated.Value(1)).current;

  const handleCheck = useCallback(() => {
    Animated.parallel([
      Animated.timing(scaleAnim, { toValue: 0.85, duration: 200, useNativeDriver: true }),
      Animated.timing(opacityAnim, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => {
      onCheck?.();
    });
  }, [onCheck, scaleAnim, opacityAnim]);

  return (
    <Animated.View style={[styles.row, styles.rowColumn, { transform: [{ scale: scaleAnim }], opacity: opacityAnim }]}>
      <View style={styles.rowTop}>
      <TouchableOpacity
        style={styles.rowMain}
        onPress={onOpen}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={`Details for ${item.title}`}
      >
      <Image source={item.posterUrl} style={styles.rowPoster} contentFit="cover" />
      <View style={styles.rowInfo}>
        <View style={styles.titleRow}>
          <Text style={styles.rowTitle} numberOfLines={2}>{item.title}</Text>
        </View>
        <View style={styles.rowMeta}>
          <View style={styles.typeBadge}>
            <Text style={styles.typeBadgeText}>{item.type === 'movie' ? 'MOVIE' : 'TV'}</Text>
          </View>
          {item.year ? <Text style={styles.rowYear}>{item.year}</Text> : null}
          {item.imdbRating ? <Text style={styles.rowRating}>IMDb {item.imdbRating.toFixed(1)}</Text> : null}
        </View>
        {item.genreNames.slice(0, 2).join(', ') ? (
          <Text style={styles.rowGenres} numberOfLines={1}>{item.genreNames.slice(0, 2).join(', ')}</Text>
        ) : null}
      </View>
      </TouchableOpacity>
      <View style={styles.rowActions}>
        {showCheck && (
          <TouchableOpacity style={styles.checkBtn} onPress={handleCheck} hitSlop={8} accessibilityRole="button" accessibilityLabel="Mark as watched">
            <Ionicons name="checkmark-circle" size={26} color="#7B68EE" />
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.shareBtn} onPress={() => shareItem(item)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Share">
          <Ionicons name="share-outline" size={20} color={Colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.removeBtn} onPress={onRemove} hitSlop={12} accessibilityRole="button" accessibilityLabel="Remove">
          <Ionicons name="close-circle" size={22} color={Colors.textMuted} />
        </TouchableOpacity>
      </View>
      </View>
      {onRate && <RatingBar title={item.title} rating={rating} stars={stars} onChange={onRate} />}
    </Animated.View>
  );
}

export default function WatchlistScreen() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<SubTab>('towatch');
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const {
    savedItems, watchedItems, removeFromSaved, removeFromWatched,
    markWatched, watchedRatings, watchedStars, changeRating,
  } = useAppContext();

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 12) : insets.top;
  const botPad = Platform.OS === 'web' ? 34 : insets.bottom;

  const [query, setQuery] = useState('');
  const all = activeTab === 'towatch' ? savedItems : watchedItems;
  const isEmpty = all.length === 0;
  // Search within your lists: title, genre or year.
  const matches = useCallback((i: MediaItem) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return i.title.toLowerCase().includes(q)
      || i.genreNames.some(g => g.toLowerCase().includes(q))
      || (!!i.year && i.year.startsWith(q));
  }, [query]);
  const items = useMemo(() => all.filter(matches), [all, matches]);
  const otherTabHits = useMemo(
    () => (query.trim() ? (activeTab === 'towatch' ? watchedItems : savedItems).filter(matches).length : 0),
    [query, activeTab, watchedItems, savedItems, matches],
  );

  function confirmRemove(id: number, isSaved: boolean) {
    confirmAction(
      'Remove',
      'Remove this from your ' + (isSaved ? 'watchlist' : 'watched history') + '?',
      'Remove',
      () => (isSaved ? removeFromSaved(id) : removeFromWatched(id)),
    );
  }

  function handleMoveToWatched(item: MediaItem) {
    markWatched(item);
    sendFeedback(item, 'seen'); // saved to the account, so it stays watched on every device
  }

  return (
    <View style={[styles.container, { paddingTop: topPad }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Watchlist</Text>
        <Text style={styles.headerCount}>
          {all.length} {all.length === 1 ? 'title' : 'titles'}
        </Text>
      </View>

      <View style={styles.subTabs}>
        <TouchableOpacity
          style={[styles.subTab, activeTab === 'towatch' && styles.subTabActive]}
          onPress={() => setActiveTab('towatch')}
        >
          <Ionicons name={activeTab === 'towatch' ? 'bookmark' : 'bookmark-outline'} size={16} color={activeTab === 'towatch' ? Colors.accent : Colors.textMuted} />
          <Text style={[styles.subTabText, activeTab === 'towatch' && styles.subTabTextActive]}>To Watch</Text>
          {savedItems.length > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{savedItems.length}</Text>
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.subTab, activeTab === 'watched' && styles.subTabActive]}
          onPress={() => setActiveTab('watched')}
        >
          <Ionicons name={activeTab === 'watched' ? 'checkmark-circle' : 'checkmark-circle-outline'} size={16} color={activeTab === 'watched' ? '#7B68EE' : Colors.textMuted} />
          <Text style={[styles.subTabText, activeTab === 'watched' && styles.subTabTextActive, activeTab === 'watched' && styles.subTabTextWatched]}>Watched</Text>
          {watchedItems.length > 0 && (
            <View style={[styles.badge, activeTab === 'watched' && styles.badgeWatched]}>
              <Text style={styles.badgeText}>{watchedItems.length}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {!isEmpty && (
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={16} color={Colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder={`Search your ${activeTab === 'towatch' ? 'watchlist' : 'watched titles'}`}
            placeholderTextColor={Colors.textMuted}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            accessibilityLabel="Search your watchlist"
          />
          {!!query && (
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={16} color={Colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {!isEmpty && items.length === 0 ? (
        <View style={styles.noMatch}>
          <Text style={styles.emptySubtitle}>Nothing in {activeTab === 'towatch' ? 'To Watch' : 'Watched'} matches “{query.trim()}”.</Text>
          {otherTabHits > 0 && (
            <TouchableOpacity onPress={() => setActiveTab(activeTab === 'towatch' ? 'watched' : 'towatch')} accessibilityRole="button">
              <Text style={styles.switchTab}>
                {otherTabHits} in {activeTab === 'towatch' ? 'Watched' : 'To Watch'} →
              </Text>
            </TouchableOpacity>
          )}
        </View>
      ) : isEmpty ? (
        <View style={styles.empty}>
          <Ionicons
            name={activeTab === 'towatch' ? 'bookmark-outline' : 'checkmark-circle-outline'}
            size={56}
            color={Colors.textMuted}
          />
          <Text style={styles.emptyTitle}>
            {activeTab === 'towatch' ? 'Nothing saved yet' : 'Nothing watched yet'}
          </Text>
          <Text style={styles.emptySubtitle}>
            {activeTab === 'towatch'
              ? 'Swipe right on movies and shows to save them here'
              : 'Swipe up on a card or tap ✓ in your To Watch list'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          keyExtractor={(item) => `${item.type}_${item.id}`}
          renderItem={({ item }) => (
            <MediaRow
              item={item}
              showCheck={activeTab === 'towatch'}
              onCheck={() => handleMoveToWatched(item)}
              onRemove={() => confirmRemove(item.id, activeTab === 'towatch')}
              onOpen={() => setSelected(item)}
              rating={activeTab === 'watched' ? watchedRatings[item.id] : undefined}
              stars={activeTab === 'watched' ? watchedStars[item.id] : undefined}
              onRate={activeTab === 'watched' ? r => changeRating(item, r) : undefined}
            />
          )}
          contentContainerStyle={{ paddingBottom: botPad + 80, paddingHorizontal: 16, paddingTop: 8 }}
          showsVerticalScrollIndicator={false}
        />
      )}
      <MediaDetailModal
        visible={!!selected}
        item={selected}
        onClose={() => setSelected(null)}
        onWatched={selected && activeTab === 'towatch' ? () => { handleMoveToWatched(selected); setSelected(null); } : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 6,
    paddingHorizontal: 12, height: 40, borderRadius: 12, backgroundColor: Colors.bgCard,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: {
    flex: 1, color: Colors.textPrimary, fontSize: 15, height: '100%',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
  },
  noMatch: { alignItems: 'center', gap: 10, paddingTop: 40, paddingHorizontal: 32 },
  switchTab: { color: Colors.accent, fontWeight: '800', fontSize: 14 },
  rowColumn: { flexDirection: 'column', alignItems: 'stretch' },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  ratingBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
  },
  stars: { flexDirection: 'row', gap: 6 },
  thumbs: { flexDirection: 'row', gap: 6 },
  thumbBtn: {
    width: 34, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.border,
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
  },
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: Colors.textPrimary,
    letterSpacing: -0.5,
  },
  headerCount: {
    fontSize: 14,
    color: Colors.textMuted,
  },
  subTabs: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: Colors.bgElevated,
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  subTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  subTabActive: {
    backgroundColor: Colors.bgCard,
  },
  subTabText: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.textMuted,
  },
  subTabTextActive: {
    color: Colors.accent,
  },
  subTabTextWatched: {
    color: '#7B68EE',
  },
  badge: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
    minWidth: 20,
    alignItems: 'center',
  },
  badgeWatched: {
    backgroundColor: '#7B68EE',
  },
  badgeText: {
    color: '#000',
    fontSize: 10,
    fontWeight: '800',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.bgCard,
    borderRadius: 16,
    marginBottom: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 12,
  },
  rowPoster: {
    width: 56,
    height: 84,
    borderRadius: 10,
  },
  rowInfo: {
    flex: 1,
    gap: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  rowTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  ratingIcon: {
    marginTop: 2,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  typeBadge: {
    backgroundColor: Colors.accent,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  typeBadgeText: {
    color: '#000',
    fontSize: 9,
    fontWeight: '800',
  },
  rowYear: {
    color: Colors.textMuted,
    fontSize: 12,
  },
  rowRating: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  rowGenres: {
    color: Colors.textMuted,
    fontSize: 12,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  checkBtn: {
    padding: 4,
  },
  shareBtn: {
    padding: 4,
  },
  removeBtn: {
    padding: 4,
  },
});
