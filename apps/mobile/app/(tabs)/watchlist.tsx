import React, { useState, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, FlatList, TouchableOpacity,
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

type SubTab = 'towatch' | 'watched';

function MediaRow({
  item,
  onRemove,
  onOpen,
  onCheck,
  showCheck,
  rating,
}: {
  item: MediaItem;
  onRemove: () => void;
  onOpen: () => void;
  onCheck?: () => void;
  showCheck?: boolean;
  rating?: 'up' | 'meh' | 'down';
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
    <Animated.View style={[styles.row, { transform: [{ scale: scaleAnim }], opacity: opacityAnim }]}>
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
          {rating === 'up' && (
            <Ionicons name="thumbs-up" size={14} color="#2ECC71" style={styles.ratingIcon} />
          )}
          {rating === 'meh' && (
            <Ionicons name="thumbs-up" size={14} color="#F5C518" style={[styles.ratingIcon, { transform: [{ rotate: '90deg' }] }]} />
          )}
          {rating === 'down' && (
            <Ionicons name="thumbs-down" size={14} color="#E74C3C" style={styles.ratingIcon} />
          )}
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
    </Animated.View>
  );
}

export default function WatchlistScreen() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<SubTab>('towatch');
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const {
    savedItems, watchedItems, removeFromSaved, removeFromWatched,
    markWatched, watchedRatings,
  } = useAppContext();

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const botPad = Platform.OS === 'web' ? 34 : insets.bottom;

  const items = activeTab === 'towatch' ? savedItems : watchedItems;
  const isEmpty = items.length === 0;

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
  }

  return (
    <View style={[styles.container, { paddingTop: topPad }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Watchlist</Text>
        <Text style={styles.headerCount}>
          {activeTab === 'towatch' ? savedItems.length : watchedItems.length} titles
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

      {isEmpty ? (
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
          keyExtractor={(item) => `${item.type}_${item.id}`}
          renderItem={({ item }) => (
            <MediaRow
              item={item}
              showCheck={activeTab === 'towatch'}
              onCheck={() => handleMoveToWatched(item)}
              onRemove={() => confirmRemove(item.id, activeTab === 'towatch')}
              onOpen={() => setSelected(item)}
              rating={activeTab === 'watched' ? watchedRatings[item.id] : undefined}
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
