import React from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import Colors from '../constants/colors';
import type { MediaItem } from '../services/tmdb';

/** 3-column poster grid with title and year, for profiles and stat lists. */
export function TitleGrid({ items, empty }: { items: MediaItem[]; empty: string }) {
  const { width } = useWindowDimensions();
  const cols = 3, gap = 10, pad = 20;
  const tileW = Math.floor((Math.min(width, 600) - pad * 2 - gap * (cols - 1)) / cols);

  if (items.length === 0) return <Text style={styles.empty}>{empty}</Text>;
  return (
    <View style={[styles.grid, { gap }]}>
      {items.map(item => (
        <View key={`${item.type}:${item.id}`} style={{ width: tileW }} accessibilityLabel={`${item.title} ${item.year}`}>
          <View style={[styles.poster, { height: tileW * 1.5 }]}>
            {item.posterUrl ? <Image source={item.posterUrl} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} /> : null}
          </View>
          <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
          {item.year ? <Text style={styles.year}>{item.year}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  poster: { borderRadius: 10, overflow: 'hidden', backgroundColor: Colors.bgCard },
  title: { color: Colors.textPrimary, fontSize: 12, fontWeight: '600', marginTop: 6 },
  year: { color: Colors.textMuted, fontSize: 11 },
  empty: { color: Colors.textMuted, fontSize: 14, textAlign: 'center', paddingVertical: 32 },
});
