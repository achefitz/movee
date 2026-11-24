import React, { useState, useEffect } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import Colors from '../constants/colors';
import { Era, Filters, defaultFilters } from '../context/AppContext';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SVC, STREAMING_FILTER_LIST } from '../constants/streaming';
import { GENRES } from '../constants/genres';

interface FilterSheetProps {
  visible: boolean;
  onClose: () => void;
  filters: Filters;
  onApply: (filters: Filters) => void;
}

const AGE_RATINGS = ['G', 'PG', 'PG-13', 'R', 'NC-17'];

const ERA_OPTIONS: Array<{ value: Era; label: string; hint: string }> = [
  { value: 'all', label: 'ANY', hint: 'All years' },
  { value: 'new', label: 'NEW', hint: 'Last 2 years' },
  { value: 'classic', label: 'OLDIES', hint: 'Before 2000' },
];


export function FilterSheet({ visible, onClose, filters, onApply }: FilterSheetProps) {
  const insets = useSafeAreaInsets();
  const [localFilters, setLocalFilters] = useState<Filters>(filters);

  useEffect(() => {
    if (visible) {
      setLocalFilters(filters);
    }
  }, [visible]);

  const toggleGenre = (id: number) => {
    setLocalFilters(prev => {
      const newGenres = prev.genres.includes(id)
        ? prev.genres.filter(g => g !== id)
        : [...prev.genres, id];
      return { ...prev, genres: newGenres };
    });
  };

  const toggleStreaming = (id: number) => {
    setLocalFilters(prev => {
      const newStreaming = prev.streaming.includes(id)
        ? prev.streaming.filter(s => s !== id)
        : [...prev.streaming, id];
      return { ...prev, streaming: newStreaming };
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 24) }]}>
          <View style={styles.header}>
            <View style={styles.handle} />
            <TouchableOpacity style={styles.closeButton} onPress={onClose}>
              <Ionicons name="close" size={24} color={Colors.textPrimary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.title}>Filters</Text>

          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {/* Content Type */}
            <Text style={styles.sectionTitle}>Content Type</Text>
            <View style={styles.segmentControl}>
              {['all', 'movie', 'tv'].map((type) => (
                <TouchableOpacity
                  key={type}
                  style={[
                    styles.segmentButton,
                    localFilters.contentType === type && styles.segmentButtonActive
                  ]}
                  onPress={() => setLocalFilters(prev => ({ ...prev, contentType: type as any }))}
                >
                  <Text style={[
                    styles.segmentText,
                    localFilters.contentType === type && styles.segmentTextActive
                  ]}>
                    {type.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Release era */}
            <Text style={styles.sectionTitle}>Release</Text>
            <View style={styles.segmentControl}>
              {ERA_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.segmentButton, localFilters.era === opt.value && styles.segmentButtonActive]}
                  onPress={() => setLocalFilters(prev => ({
                    ...prev,
                    era: opt.value,
                    // Oldies are never in theaters; don't let the two cancel each other out.
                    inTheaters: opt.value === 'classic' ? false : prev.inTheaters,
                  }))}
                >
                  <Text style={[styles.segmentText, localFilters.era === opt.value && styles.segmentTextActive]}>
                    {opt.label}
                  </Text>
                  <Text style={[styles.segmentHint, localFilters.era === opt.value && styles.segmentTextActive]}>
                    {opt.hint}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Age rating */}
            <Text style={styles.sectionTitle}>Age rating</Text>
            <Text style={styles.sectionHint}>TV shows match the same level: TV-G, TV-PG, TV-14, TV-MA</Text>
            <View style={styles.streamingContainer}>
              {AGE_RATINGS.map(r => {
                const on = (localFilters.ageRatings ?? []).includes(r);
                return (
                  <TouchableOpacity
                    key={r}
                    style={[styles.genrePill, on && styles.genrePillActive]}
                    onPress={() => setLocalFilters(prev => {
                      const cur = prev.ageRatings ?? [];
                      return { ...prev, ageRatings: on ? cur.filter(x => x !== r) : [...cur, r] };
                    })}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                  >
                    <Text style={[styles.genreText, on && styles.genreTextActive]}>{r}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Streaming Services */}
            <Text style={styles.sectionTitle}>Streaming Services</Text>
            <Text style={styles.sectionHint}>Only show titles available on selected platforms</Text>
            <View style={styles.streamingContainer}>
              {STREAMING_FILTER_LIST.map((svc) => {
                const isActive = localFilters.streaming.includes(svc.id);
                const svcInfo = SVC[svc.id];
                return (
                  <TouchableOpacity
                    key={svc.id}
                    style={[
                      styles.streamingPill,
                      isActive && { backgroundColor: svcInfo?.color || Colors.accent, borderColor: svcInfo?.color || Colors.accent }
                    ]}
                    onPress={() => toggleStreaming(svc.id)}
                  >
                    <Text style={[styles.streamingText, isActive && styles.streamingTextActive]}>
                      {svc.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Genres */}
            <Text style={styles.sectionTitle}>Genres</Text>
            <View style={styles.genresContainer}>
              {GENRES.map((genre) => {
                const isActive = localFilters.genres.includes(genre.id);
                return (
                  <TouchableOpacity
                    key={genre.id}
                    style={[styles.genrePill, isActive && styles.genrePillActive]}
                    onPress={() => toggleGenre(genre.id)}
                  >
                    <Text style={[styles.genreText, isActive && styles.genreTextActive]}>
                      {genre.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {/* Min Rating */}
            <Text style={styles.sectionTitle}>Minimum Rating: {localFilters.minRating}+</Text>
            <View style={styles.ratingRow}>
              {[0, 5, 6, 7, 8].map((rating) => (
                <TouchableOpacity
                  key={rating}
                  style={[
                    styles.ratingBubble,
                    localFilters.minRating === rating && styles.ratingBubbleActive
                  ]}
                  onPress={() => setLocalFilters(prev => ({ ...prev, minRating: rating }))}
                >
                  <Text style={[
                    styles.ratingText,
                    localFilters.minRating === rating && styles.ratingTextActive
                  ]}>{rating === 0 ? 'Any' : rating + '+'}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Max Runtime */}
            <Text style={styles.sectionTitle}>Max Runtime</Text>
            <Text style={styles.sectionHint}>Movies only — TV shows are unaffected</Text>
            <View style={styles.ratingRow}>
              {[null, 90, 120, 150].map((val) => {
                const isActive = localFilters.maxRuntime === val;
                const label = val === null ? 'Any' : val === 90 ? '<90 min' : val === 120 ? '<2 hrs' : '<2.5 hrs';
                return (
                  <TouchableOpacity
                    key={String(val)}
                    style={[styles.ratingBubble, { width: 60, paddingHorizontal: 4 }, isActive && styles.ratingBubbleActive]}
                    onPress={() => setLocalFilters(prev => ({ ...prev, maxRuntime: val }))}
                  >
                    <Text style={[styles.ratingText, isActive && styles.ratingTextActive]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* In Theaters */}
            <Text style={styles.sectionTitle}>Availability</Text>
            <TouchableOpacity
              style={[styles.theaterToggle, localFilters.inTheaters && styles.theaterToggleActive]}
              onPress={() => setLocalFilters(prev => ({
                ...prev,
                inTheaters: !prev.inTheaters,
                era: !prev.inTheaters && prev.era === 'classic' ? 'all' : prev.era,
              }))}
              activeOpacity={0.8}
            >
              <Ionicons
                name="film"
                size={18}
                color={localFilters.inTheaters ? Colors.accent : Colors.textMuted}
              />
              <View style={styles.theaterToggleText}>
                <Text style={[styles.theaterToggleLabel, localFilters.inTheaters && styles.theaterToggleLabelActive]}>
                  In Theaters Now
                </Text>
                <Text style={styles.theaterToggleHint}>Movies currently showing in cinemas</Text>
              </View>
              <View style={[styles.toggleDot, localFilters.inTheaters && styles.toggleDotActive]} />
            </TouchableOpacity>

          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity
              style={styles.resetButton}
              onPress={() => setLocalFilters(defaultFilters)}
            >
              <Text style={styles.resetText}>Reset</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.applyButton}
              onPress={() => {
                onApply(localFilters);
                onClose();
              }}
            >
              <Text style={styles.applyText}>Apply Filters</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.bgElevated,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '85%',
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: Colors.textMuted,
    borderRadius: 2,
    marginBottom: 12,
  },
  closeButton: {
    position: 'absolute',
    right: 0,
    top: 0,
    padding: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: Colors.textPrimary,
    marginBottom: 20,
  },
  content: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.textPrimary,
    marginBottom: 8,
    marginTop: 20,
  },
  sectionHint: {
    fontSize: 12,
    color: Colors.textMuted,
    marginBottom: 12,
    marginTop: -4,
  },
  segmentControl: {
    flexDirection: 'row',
    backgroundColor: Colors.bgCard,
    borderRadius: 12,
    padding: 4,
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
  },
  segmentButtonActive: {
    backgroundColor: Colors.accent,
  },
  segmentText: {
    color: Colors.textSecondary,
    fontWeight: '600',
    fontSize: 14,
  },
  segmentTextActive: {
    color: '#000',
  },
  segmentHint: {
    color: Colors.textMuted,
    fontSize: 10,
    marginTop: 2,
  },
  ratingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  ratingBubble: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: Colors.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  ratingBubbleActive: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  ratingText: {
    color: Colors.textSecondary,
    fontWeight: 'bold',
  },
  ratingTextActive: {
    color: '#000',
  },
  streamingContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },
  streamingPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: Colors.bgCard,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  streamingText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  streamingTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  theaterToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.bgCard,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    marginBottom: 4,
  },
  theaterToggleActive: {
    borderColor: Colors.accent,
    backgroundColor: 'rgba(245,197,24,0.08)',
  },
  theaterToggleText: {
    flex: 1,
    gap: 2,
  },
  theaterToggleLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  theaterToggleLabelActive: {
    color: Colors.accent,
  },
  theaterToggleHint: {
    fontSize: 11,
    color: Colors.textMuted,
  },
  toggleDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.border,
    borderWidth: 2,
    borderColor: Colors.border,
  },
  toggleDotActive: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  genresContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  genrePill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: Colors.bgCard,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  genrePillActive: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  genreText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  genreTextActive: {
    color: '#000',
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    gap: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  resetButton: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: Colors.bgCard,
  },
  resetText: {
    color: Colors.textPrimary,
    fontWeight: 'bold',
    fontSize: 16,
  },
  applyButton: {
    flex: 2,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: Colors.accent,
  },
  applyText: {
    color: '#000',
    fontWeight: 'bold',
    fontSize: 16,
  },
});
