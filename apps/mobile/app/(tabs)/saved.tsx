import React, { useState } from 'react';
import { StyleSheet, Text, View, FlatList, TouchableOpacity, Platform, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Colors from '@/constants/colors';
import { Ionicons } from '@expo/vector-icons';
import { useAppContext } from '@/context/AppContext';
import { Image } from 'expo-image';
import { MediaDetailModal } from '@/components/MediaDetailModal';
import { MediaItem } from '@/services/tmdb';

export default function SavedScreen() {
  const insets = useSafeAreaInsets();
  const { savedItems, removeFromSaved } = useAppContext();
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);

  const paddingTop = Platform.OS === 'web' ? Math.max(insets.top, 12) : insets.top;
  const paddingBottom = Platform.OS === 'web' ? 100 : Math.max(insets.bottom + 60, 80);

  const confirmRemove = (id: number, title: string) => {
    if (Platform.OS === 'web') {
      if (window.confirm(`Remove ${title} from saved?`)) {
        removeFromSaved(id);
      }
    } else {
      Alert.alert(
        "Remove Item",
        `Remove ${title} from saved?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Remove", style: "destructive", onPress: () => removeFromSaved(id) }
        ]
      );
    }
  };

  const renderItem = ({ item }: { item: MediaItem }) => (
    <TouchableOpacity 
      style={styles.card} 
      onPress={() => setSelectedItem(item)}
      onLongPress={() => confirmRemove(item.id, item.title)}
      activeOpacity={0.8}
    >
      <View style={styles.imageContainer}>
        <Image source={item.posterUrl} style={styles.poster} contentFit="cover" />
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{item.type === 'movie' ? 'MOVIE' : 'TV'}</Text>
        </View>
        <TouchableOpacity 
          style={styles.removeBtn}
          onPress={() => confirmRemove(item.id, item.title)}
        >
          <Ionicons name="trash" size={16} color="#FFF" />
        </TouchableOpacity>
      </View>
      <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
      <Text style={styles.year}>{item.year}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { paddingTop }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Saved</Text>
        <View style={styles.countBadge}>
          <Text style={styles.countText}>{savedItems.length}</Text>
        </View>
      </View>

      {savedItems.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="heart-outline" size={64} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>Nothing saved yet</Text>
          <Text style={styles.emptyDesc}>Swipe right on movies and TV shows to save them here.</Text>
        </View>
      ) : (
        <FlatList
          data={savedItems.slice().reverse()}
          keyExtractor={(item) => item.id.toString()}
          numColumns={2}
          renderItem={renderItem}
          contentContainerStyle={[styles.listContent, { paddingBottom }]}
          columnWrapperStyle={styles.row}
          showsVerticalScrollIndicator={false}
        />
      )}

      <MediaDetailModal
        visible={!!selectedItem}
        item={selectedItem}
        onClose={() => setSelectedItem(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 12,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: Colors.textPrimary,
  },
  countBadge: {
    backgroundColor: Colors.bgElevated,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  countText: {
    color: Colors.accent,
    fontWeight: 'bold',
    fontSize: 14,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  row: {
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  card: {
    width: '48%',
  },
  imageContainer: {
    width: '100%',
    aspectRatio: 2/3,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: Colors.bgCard,
    marginBottom: 8,
    position: 'relative',
  },
  poster: {
    width: '100%',
    height: '100%',
  },
  badge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: Colors.accent,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    color: '#000',
    fontSize: 10,
    fontWeight: 'bold',
  },
  removeBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  year: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: Colors.textPrimary,
    marginTop: 16,
    marginBottom: 8,
  },
  emptyDesc: {
    fontSize: 16,
    color: Colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
});