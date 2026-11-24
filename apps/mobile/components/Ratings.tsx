import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../constants/colors';
import type { MediaItem } from '../services/tmdb';

/** "1.2M", "84K", "950" */
export function compactCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

const open = (url?: string) => { if (url) Linking.openURL(url).catch(() => {}); };

/**
 * IMDb and Rotten Tomatoes scores (TMDB when neither is known). Plain labels, not the
 * services' logos. `size="lg"` adds vote counts and the TMDB score, for the details sheet.
 */
export function Ratings({ item, size = 'sm', linked = false }: { item: MediaItem; size?: 'sm' | 'lg'; linked?: boolean }) {
  const lg = size === 'lg';
  const hasImdb = typeof item.imdbRating === 'number';
  const hasRt = typeof item.rtScore === 'number';
  const fresh = (item.rtScore ?? 0) >= 60;
  const Wrap = ({ url, children, label }: { url?: string; children: React.ReactNode; label: string }) =>
    linked && url ? (
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} onPress={() => open(url)} style={[styles.pill, lg && styles.pillLg]} activeOpacity={0.8}>
        {children}
        {lg && <Ionicons name="open-outline" size={12} color={Colors.textMuted} />}
      </TouchableOpacity>
    ) : (
      <View accessibilityLabel={label} style={[styles.pill, lg && styles.pillLg]}>{children}</View>
    );

  return (
    <View style={styles.row}>
      {hasImdb && (
        <Wrap url={item.imdbUrl} label={`IMDb ${item.imdbRating!.toFixed(1)} out of 10`}>
          <Text style={[styles.imdbLabel, lg && styles.labelLg]}>IMDb</Text>
          <Text style={[styles.value, lg && styles.valueLg]}>{item.imdbRating!.toFixed(1)}</Text>
          {lg && item.imdbVotes ? <Text style={styles.sub}>{compactCount(item.imdbVotes)}</Text> : null}
        </Wrap>
      )}
      {hasRt && (
        <Wrap url={item.rtUrl} label={`Rotten Tomatoes ${item.rtScore}%`}>
          <Text style={lg ? styles.emojiLg : styles.emoji}>{fresh ? '🍅' : '🥀'}</Text>
          <Text style={[styles.value, lg && styles.valueLg, { color: fresh ? '#FF6B5B' : '#7BC67B' }]}>{item.rtScore}%</Text>
        </Wrap>
      )}
      {(lg || (!hasImdb && !hasRt)) && item.rating > 0 && (
        <View accessibilityLabel={`TMDB ${item.rating.toFixed(1)} out of 10`} style={[styles.pill, lg && styles.pillLg, styles.tmdb]}>
          <Ionicons name="star" size={lg ? 13 : 12} color={Colors.accent} />
          <Text style={[styles.value, lg && styles.valueLg]}>{item.rating.toFixed(1)}</Text>
          <Text style={styles.sub}>TMDB</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  pillLg: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, gap: 6, backgroundColor: Colors.bgCard, borderColor: Colors.border },
  tmdb: {},
  imdbLabel: { color: Colors.accent, fontWeight: '900', fontSize: 11, letterSpacing: 0.3 },
  labelLg: { fontSize: 13 },
  value: { color: '#fff', fontWeight: '800', fontSize: 13 },
  valueLg: { fontSize: 15 },
  sub: { color: Colors.textMuted, fontSize: 11, fontWeight: '600' },
  emoji: { fontSize: 12 },
  emojiLg: { fontSize: 15 },
});
