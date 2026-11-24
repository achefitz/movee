import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Colors from '@/constants/colors';
import { GENRES } from '@/constants/genres';
import { useAppContext } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { apiFetch } from '@/services/api';
import { keyOf } from '@/services/recs';
import type { MediaItem } from '@/services/tmdb';

/** Genres offered first. TV Movie is left out: nobody picks it as a favorite. */
const PICKABLE_GENRES = GENRES.filter(g => g.id !== 10770);
const SUGGESTED_PICKS = 3;

export default function OnboardingScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { user, completeOnboarding } = useAuth();
  const { markWatched, rateWatched } = useAppContext();

  const [step, setStep] = useState<'genres' | 'titles'>('genres');
  const [genres, setGenres] = useState<number[]>([]);
  const [titles, setTitles] = useState<MediaItem[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const toggleGenre = (id: number) =>
    setGenres(prev => (prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]));

  const togglePick = (item: MediaItem) =>
    setPicked(prev => {
      const next = new Set(prev);
      const k = keyOf(item);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  const loadTitles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const q = genres.length ? `?genres=${genres.join(',')}` : '';
      const { items } = await apiFetch<{ items: MediaItem[] }>(`/api/onboarding/titles${q}`);
      setTitles(items);
    } catch {
      setError("Couldn't load titles. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [genres]);

  useEffect(() => {
    if (step === 'titles') loadTitles();
  }, [step, loadTitles]);

  // "Don't know these?" — 20 more, never repeating what's already on screen.
  const loadMore = async () => {
    setLoadingMore(true);
    setError('');
    try {
      const params = [genres.length ? `genres=${genres.join(',')}` : '', `exclude=${titles.map(keyOf).join(',')}`]
        .filter(Boolean).join('&');
      const { items } = await apiFetch<{ items: MediaItem[] }>(`/api/onboarding/titles?${params}`);
      setTitles(prev => [...prev, ...items.filter(i => !prev.some(p => keyOf(p) === keyOf(i)))]);
    } catch {
      setError("Couldn't load more titles. Try again.");
    } finally {
      setLoadingMore(false);
    }
  };

  const finish = async (withAnswers: boolean) => {
    setSaving(true);
    setError('');
    const favorites = withAnswers ? titles.filter(t => picked.has(keyOf(t))) : [];
    const res = await completeOnboarding(withAnswers ? genres : [], favorites.map(keyOf));
    if (!res.success) {
      setSaving(false);
      setError(res.error ?? 'Something went wrong. Try again.');
      return;
    }
    // Mirror the picks into the local Watched list ("Loved it"), like a swipe-up would.
    for (const item of favorites) {
      markWatched(item);
      rateWatched(item.id, 'up');
    }
    // AuthGate moves on to the app once user.onboarded flips to true.
  };

  const cols = 3;
  const gap = 10;
  const pad = 20;
  const tileW = Math.floor((Math.min(width, 600) - pad * 2 - gap * (cols - 1)) / cols);

  const top = Platform.OS === 'web' ? Math.max(insets.top, 24) : insets.top + 8;

  return (
    <View style={[styles.container, { paddingTop: top }]}>
      <View style={styles.progressRow}>
        <View style={[styles.progressDot, styles.progressDotActive]} />
        <View style={[styles.progressDot, step === 'titles' && styles.progressDotActive]} />
      </View>

      {step === 'genres' ? (
        <>
          <ScrollView contentContainerStyle={[styles.body, { paddingHorizontal: pad }]}>
            <Text style={styles.kicker}>Welcome{user ? `, ${user.username}` : ''}</Text>
            <Text style={styles.title}>What do you like to watch?</Text>
            <Text style={styles.subtitle}>Pick a few genres so your first cards are already your kind of thing.</Text>
            <View style={styles.chips}>
              {PICKABLE_GENRES.map(g => {
                const on = genres.includes(g.id);
                return (
                  <TouchableOpacity
                    key={g.id}
                    style={[styles.chip, on && styles.chipOn]}
                    onPress={() => toggleGenre(g.id)}
                    activeOpacity={0.8}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                  >
                    {on && <Ionicons name="checkmark" size={14} color="#000" />}
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{g.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 20), paddingHorizontal: pad }]}>
            <TouchableOpacity onPress={() => finish(false)} disabled={saving} style={styles.skipBtn}>
              <Text style={styles.skipText}>Skip</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.primaryBtn, genres.length === 0 && styles.primaryBtnMuted]}
              onPress={() => setStep('titles')}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryText}>{genres.length ? `Next (${genres.length})` : 'Next'}</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <ScrollView contentContainerStyle={[styles.body, { paddingHorizontal: pad }]}>
            <TouchableOpacity onPress={() => setStep('genres')} style={styles.backRow} hitSlop={8}>
              <Ionicons name="chevron-back" size={18} color={Colors.textSecondary} />
              <Text style={styles.backText}>Genres</Text>
            </TouchableOpacity>
            <Text style={styles.title}>Pick some favorites</Text>
            <Text style={styles.subtitle}>
              Tap movies and shows you've loved. {SUGGESTED_PICKS} or more helps a lot.
            </Text>

            {loading ? (
              <View style={styles.center}><ActivityIndicator size="large" color={Colors.accent} /></View>
            ) : (
              <View style={[styles.grid, { gap }]}>
                {titles.map(item => {
                  const on = picked.has(keyOf(item));
                  return (
                    <TouchableOpacity
                      key={keyOf(item)}
                      onPress={() => togglePick(item)}
                      activeOpacity={0.85}
                      style={[styles.tile, { width: tileW }]}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={item.title}
                    >
                      <View style={[styles.posterWrap, { height: tileW * 1.5 }, on && styles.posterOn]}>
                        <Image source={item.posterUrl} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
                        {on && (
                          <View style={styles.check}>
                            <Ionicons name="heart" size={16} color="#fff" />
                          </View>
                        )}
                      </View>
                      <Text style={styles.tileTitle} numberOfLines={1}>{item.title}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
            {!loading && titles.length > 0 && (
              <TouchableOpacity
                style={styles.moreBtn}
                onPress={loadMore}
                disabled={loadingMore}
                activeOpacity={0.8}
                accessibilityRole="button"
              >
                {loadingMore
                  ? <ActivityIndicator color={Colors.accent} />
                  : <>
                      <Ionicons name="refresh" size={16} color={Colors.accent} />
                      <Text style={styles.moreText}>Don't know these? Show more titles</Text>
                    </>}
              </TouchableOpacity>
            )}
            {error ? (
              <TouchableOpacity onPress={loadTitles}>
                <Text style={styles.error}>{error} Tap to retry.</Text>
              </TouchableOpacity>
            ) : null}
          </ScrollView>
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 20), paddingHorizontal: pad }]}>
            <TouchableOpacity onPress={() => finish(false)} disabled={saving} style={styles.skipBtn}>
              <Text style={styles.skipText}>Skip</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.primaryBtn, saving && styles.primaryBtnMuted]}
              onPress={() => finish(true)}
              disabled={saving}
              activeOpacity={0.85}
            >
              {saving
                ? <ActivityIndicator color="#000" />
                : <Text style={styles.primaryText}>{picked.size ? `Start swiping (${picked.size})` : 'Start swiping'}</Text>}
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  progressRow: { flexDirection: 'row', gap: 6, justifyContent: 'center', paddingVertical: 12 },
  progressDot: { width: 28, height: 4, borderRadius: 2, backgroundColor: Colors.border },
  progressDotActive: { backgroundColor: Colors.accent },
  body: { paddingBottom: 24, maxWidth: 600, width: '100%', alignSelf: 'center' },
  kicker: { color: Colors.accent, fontSize: 14, fontWeight: '700', marginTop: 12 },
  title: { color: Colors.textPrimary, fontSize: 28, fontWeight: '800', marginTop: 6 },
  subtitle: { color: Colors.textSecondary, fontSize: 15, marginTop: 8, marginBottom: 20, lineHeight: 21 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22,
    backgroundColor: Colors.bgCard, borderWidth: 1, borderColor: Colors.border,
  },
  chipOn: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  chipText: { color: Colors.textSecondary, fontSize: 15, fontWeight: '600' },
  chipTextOn: { color: '#000' },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 8 },
  backText: { color: Colors.textSecondary, fontSize: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { gap: 6 },
  posterWrap: {
    borderRadius: 12, overflow: 'hidden', backgroundColor: Colors.bgCard,
    borderWidth: 2, borderColor: 'transparent',
  },
  posterOn: { borderColor: Colors.like },
  check: {
    position: 'absolute', top: 6, right: 6, width: 28, height: 28, borderRadius: 14,
    backgroundColor: Colors.like, alignItems: 'center', justifyContent: 'center',
  },
  tileTitle: { color: Colors.textSecondary, fontSize: 12 },
  center: { paddingVertical: 60, alignItems: 'center' },
  moreBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 18, paddingVertical: 14, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgCard,
  },
  moreText: { color: Colors.accent, fontWeight: '700', fontSize: 14 },
  error: { color: Colors.skip, textAlign: 'center', marginTop: 16 },
  footer: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: Colors.border, maxWidth: 600, width: '100%', alignSelf: 'center',
  },
  skipBtn: { paddingVertical: 16, paddingHorizontal: 12 },
  skipText: { color: Colors.textMuted, fontSize: 16, fontWeight: '600' },
  primaryBtn: {
    flex: 1, paddingVertical: 16, borderRadius: 14, alignItems: 'center', backgroundColor: Colors.accent,
  },
  primaryBtnMuted: { opacity: 0.6 },
  primaryText: { color: '#000', fontWeight: '800', fontSize: 16 },
});
