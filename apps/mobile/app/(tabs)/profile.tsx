import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity,
  ScrollView, Platform, Alert, LayoutAnimation, UIManager, Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Colors from '@/constants/colors';
import { useAppContext } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { apiFetch } from '@/services/api';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const GENRE_MAP: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
  10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
  10759: 'Action & Adventure', 10762: 'Kids', 10765: 'Sci-Fi & Fantasy',
};

const STAT_ICONS = {
  movieLikes: 'film-outline' as const,
  tvLikes: 'tv-outline' as const,
  totalWatched: 'checkmark-done-circle-outline' as const,
  totalSwiped: 'swap-horizontal-outline' as const,
};

const SETTINGS_ITEMS = [
  { key: 'notifications', icon: 'notifications-outline' as const, label: 'Push Notifications', value: undefined },
  { key: 'region', icon: 'globe-outline' as const, label: 'Region', value: 'US' },
  { key: 'privacy', icon: 'shield-checkmark-outline' as const, label: 'Privacy', value: 'Public' },
  { key: 'about', icon: 'information-circle-outline' as const, label: 'About Movee', value: 'v1.0' },
];

function useViewerType(topGenreNames: string[], moviePct: number, tvPct: number, totalLikes: number) {
  const [viewerType, setViewerType] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastFetchKey = useRef<string>('');

  useEffect(() => {
    if (totalLikes < 3) {
      setViewerType(null);
      return;
    }

    const key = topGenreNames.slice(0, 3).join(',') + '|' + moviePct + '|' + tvPct;
    if (key === lastFetchKey.current) return;
    lastFetchKey.current = key;

    setLoading(true);

    const controller = new AbortController();

    apiFetch<{ label?: string }>('/api/viewer-type', {
      body: {
        topGenres: topGenreNames,
        mediaTypeSplit: { moviePct, tvPct },
        totalLikes,
      },
      signal: controller.signal,
    })
      .then(data => {
        if (data.label) setViewerType(data.label);
        else setViewerType(null);
        setLoading(false);
      })
      .catch(err => {
        if (err?.name !== 'AbortError') {
          setViewerType(null);
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [topGenreNames.join(','), moviePct, tvPct, totalLikes]);

  return { viewerType, loading };
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { profileName, stats, getTopGenres, savedItems, resetHistory } = useAppContext();
  const { user, logout, setPrivate } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const displayName = user?.username ?? profileName;

  const paddingTop = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const paddingBottom = Platform.OS === 'web' ? 100 : Math.max(insets.bottom + 60, 80);

  const genreCounts: Record<number, number> = {};
  savedItems.forEach(item => item.genres.forEach(g => { genreCounts[g] = (genreCounts[g] || 0) + 1; }));
  const topGenreEntries = Object.entries(genreCounts)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 8);
  const maxCount = topGenreEntries[0]?.[1] ?? 1;

  const top5GenreNames = topGenreEntries.slice(0, 5).map(([id]) => GENRE_MAP[Number(id)] || `Genre ${id}`);
  const totalLikes = stats.totalLiked;
  const totalTyped = stats.movieLikes + stats.tvLikes || 1;
  const moviePct = Math.round((stats.movieLikes / totalTyped) * 100);
  const tvPct = 100 - moviePct;

  const { viewerType, loading: viewerTypeLoading } = useViewerType(top5GenreNames, moviePct, tvPct, totalLikes);

  const handleReset = () => {
    if (Platform.OS === 'web') {
      if (window.confirm('Reset all history? This cannot be undone.')) resetHistory();
    } else {
      Alert.alert(
        'Reset History',
        'Are you sure? This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Reset', style: 'destructive', onPress: () => resetHistory() },
        ]
      );
    }
  };

  const handleLogout = () => {
    if (Platform.OS === 'web') {
      if (window.confirm('Log out of your account?')) logout();
    } else {
      Alert.alert(
        'Log Out',
        'Are you sure you want to log out?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Log Out', style: 'destructive', onPress: () => logout() },
        ]
      );
    }
  };

  const toggleSettings = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSettingsOpen(prev => !prev);
  };

  const topGenres = getTopGenres();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop, paddingBottom }}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{displayName.replace('@', '').substring(0, 2).toUpperCase()}</Text>
        </View>

        <Text style={styles.username}>{displayName}</Text>
        <Text style={styles.memberSince}>Movee member</Text>
      </View>

      <View style={styles.statsGrid}>
        <View style={styles.statCard}>
          <Ionicons name={STAT_ICONS.movieLikes} size={20} color={Colors.accent} />
          <Text style={styles.statValue}>{stats.movieLikes}</Text>
          <Text style={styles.statLabel}>Movies</Text>
        </View>
        <View style={styles.statCard}>
          <Ionicons name={STAT_ICONS.tvLikes} size={20} color={Colors.accent} />
          <Text style={styles.statValue}>{stats.tvLikes}</Text>
          <Text style={styles.statLabel}>TV Shows</Text>
        </View>
        <View style={styles.statCard}>
          <Ionicons name={STAT_ICONS.totalWatched} size={20} color="#7B68EE" />
          <Text style={[styles.statValue, { color: '#7B68EE' }]}>{stats.totalWatched}</Text>
          <Text style={styles.statLabel}>Watched</Text>
        </View>
        <View style={styles.statCard}>
          <Ionicons name={STAT_ICONS.totalSwiped} size={20} color={Colors.textMuted} />
          <Text style={[styles.statValue, { color: Colors.textSecondary }]}>{stats.totalSwiped}</Text>
          <Text style={styles.statLabel}>Swiped</Text>
        </View>
      </View>

      <View style={styles.viewerTypeSection}>
        <View style={styles.viewerTypeCard}>
          <View style={styles.viewerTypeHeader}>
            <Ionicons name="sparkles" size={18} color={Colors.accent} />
            <Text style={styles.viewerTypeTitle}>Your Viewer Type</Text>
          </View>
          {viewerTypeLoading ? (
            <View style={styles.shimmerContainer}>
              <View style={styles.shimmerBar} />
            </View>
          ) : viewerType ? (
            <Text style={styles.viewerTypeLabel}>{viewerType}</Text>
          ) : (
            <Text style={styles.viewerTypeFallback}>Keep swiping to reveal your viewer type</Text>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Taste Profile</Text>
        {topGenreEntries.length > 0 ? (
          <View style={styles.genreChart}>
            {topGenreEntries.map(([idStr, count]) => {
              const id = Number(idStr);
              const name = GENRE_MAP[id] || `Genre ${id}`;
              const pct = Math.round((count / maxCount) * 100);
              return (
                <View key={id} style={styles.genreRow}>
                  <Text style={styles.genreName}>{name}</Text>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { width: `${pct}%` }]} />
                  </View>
                  <Text style={styles.genreCount}>{count}</Text>
                </View>
              );
            })}
          </View>
        ) : (
          <View style={styles.emptyTaste}>
            <Ionicons name="analytics-outline" size={40} color={Colors.textMuted} />
            <Text style={styles.emptyText}>Swipe on more content to build your taste profile</Text>
          </View>
        )}
      </View>

      <View style={styles.section}>
        <View style={[styles.prefList, styles.privacyCard]}>
          <View style={[styles.prefIcon, styles.settingsIcon]}>
            <Ionicons name={user?.isPrivate ? 'lock-closed' : 'globe-outline'} size={20} color={Colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.accordionTitle}>Private account</Text>
            <Text style={styles.privacyHint}>
              {user?.isPrivate
                ? 'You approve each follower before they see your likes and watches.'
                : 'Anyone who follows you can see your likes and watches.'}
            </Text>
          </View>
          <Switch
            value={!!user?.isPrivate}
            onValueChange={async v => {
              const res = await setPrivate(v);
              if (!res.success) Alert.alert("Couldn't update privacy", res.error ?? 'Try again.');
            }}
            trackColor={{ true: Colors.accent, false: Colors.border }}
            thumbColor="#fff"
            accessibilityLabel="Private account"
          />
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.prefList}>
          <TouchableOpacity style={styles.accordionHeader} onPress={toggleSettings} activeOpacity={0.7}>
            <View style={styles.accordionHeaderLeft}>
              <View style={[styles.prefIcon, styles.settingsIcon]}>
                <Ionicons name="settings-outline" size={20} color={Colors.accent} />
              </View>
              <Text style={styles.accordionTitle}>Settings</Text>
            </View>
            <Ionicons
              name={settingsOpen ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={Colors.textMuted}
            />
          </TouchableOpacity>

          {settingsOpen && (
            <View>
              {SETTINGS_ITEMS.map((item, index) => (
                <View key={item.key}>
                  <View style={styles.separator} />
                  <TouchableOpacity style={styles.prefRow}>
                    <View style={styles.prefIcon}>
                      <Ionicons name={item.icon} size={20} color={Colors.accent} />
                    </View>
                    <Text style={styles.prefText}>{item.label}</Text>
                    {item.value !== undefined && (
                      <Text style={styles.prefValue}>{item.value}</Text>
                    )}
                    <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>
      </View>

      <TouchableOpacity style={styles.resetBtn} onPress={handleReset}>
        <Ionicons name="trash-outline" size={18} color={Colors.skip} />
        <Text style={styles.resetBtnText}>Reset All History</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
        <Ionicons name="log-out-outline" size={18} color={Colors.textSecondary} />
        <Text style={styles.logoutBtnText}>Log Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  header: {
    alignItems: 'center',
    paddingVertical: 28,
    paddingHorizontal: 20,
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    borderWidth: 3,
    borderColor: 'rgba(245,197,24,0.3)',
  },
  avatarText: {
    fontSize: 34,
    fontWeight: '900',
    color: '#000',
    letterSpacing: 2,
  },
  username: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.textPrimary,
    marginBottom: 2,
    letterSpacing: -0.3,
  },
  memberSince: {
    fontSize: 13,
    color: Colors.textMuted,
    marginTop: 4,
  },
  statsGrid: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 10,
    marginBottom: 20,
  },
  statCard: {
    flex: 1,
    backgroundColor: Colors.bgCard,
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 4,
  },
  statValue: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.accent,
  },
  statLabel: {
    fontSize: 10,
    color: Colors.textMuted,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  viewerTypeSection: {
    paddingHorizontal: 16,
    marginBottom: 20,
  },
  viewerTypeCard: {
    backgroundColor: Colors.bgCard,
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: Colors.accent + '40',
    gap: 10,
  },
  viewerTypeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  viewerTypeTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  viewerTypeLabel: {
    fontSize: 22,
    fontWeight: '900',
    color: Colors.textPrimary,
    letterSpacing: -0.3,
  },
  viewerTypeFallback: {
    fontSize: 14,
    color: Colors.textMuted,
    fontStyle: 'italic',
    lineHeight: 20,
  },
  shimmerContainer: {
    paddingVertical: 4,
  },
  shimmerBar: {
    height: 24,
    borderRadius: 8,
    backgroundColor: Colors.bgElevated,
    width: '70%',
  },
  section: {
    paddingHorizontal: 20,
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: Colors.textPrimary,
    marginBottom: 16,
    letterSpacing: -0.3,
  },
  genreChart: {
    gap: 10,
  },
  genreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  genreName: {
    width: 110,
    fontSize: 13,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
  barTrack: {
    flex: 1,
    height: 8,
    backgroundColor: Colors.bgElevated,
    borderRadius: 4,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: Colors.accent,
    borderRadius: 4,
  },
  genreCount: {
    width: 24,
    fontSize: 12,
    color: Colors.textMuted,
    textAlign: 'right',
    fontWeight: '600',
  },
  emptyTaste: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: 20,
  },
  emptyText: {
    color: Colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
  prefList: {
    backgroundColor: Colors.bgCard,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
  },
  accordionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  accordionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  privacyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  privacyHint: {
    color: Colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  settingsIcon: {
    backgroundColor: 'rgba(245,197,24,0.1)',
  },
  prefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  prefIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(245,197,24,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  prefText: {
    flex: 1,
    fontSize: 15,
    color: Colors.textPrimary,
    fontWeight: '500',
  },
  prefValue: {
    color: Colors.textMuted,
    fontSize: 14,
    marginRight: 4,
  },
  separator: {
    height: 1,
    backgroundColor: Colors.border,
    marginHorizontal: 16,
  },
  resetBtn: {
    marginHorizontal: 20,
    marginBottom: 20,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.skip,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(231,76,60,0.08)',
  },
  resetBtnText: {
    color: Colors.skip,
    fontWeight: '700',
    fontSize: 15,
  },
  logoutBtn: {
    marginHorizontal: 20,
    marginBottom: 20,
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.bgCard,
  },
  logoutBtnText: {
    color: Colors.textSecondary,
    fontWeight: '700',
    fontSize: 15,
  },
});
