import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Colors from '@/constants/colors';
import { TitleGrid } from '@/components/TitleGrid';
import { ApiError, apiFetch } from '@/services/api';
import type { MediaItem } from '@/services/tmdb';

type Profile = {
  user: { username: string; isPrivate: boolean; joined: number; followers: number; following: number };
  isMe: boolean;
  followStatus: 'pending' | 'accepted' | null;
  followsYou: boolean;
  canView: boolean;
  liked: MediaItem[];
  watched: MediaItem[];
};

/** Someone's profile: counts, follow button, and their likes/watches when you're allowed to see them. */
export default function UserProfileScreen() {
  const { username: raw } = useLocalSearchParams<{ username: string }>();
  const username = String(raw ?? '').replace(/^@/, '');
  const insets = useSafeAreaInsets();
  const [p, setP] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'liked' | 'watched'>('liked');

  const load = useCallback(async () => {
    setError('');
    try {
      setP(await apiFetch<Profile>(`/api/users/${encodeURIComponent(username)}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't reach the server. Try again.");
    }
  }, [username]);

  useEffect(() => { load(); }, [load]);

  const follow = async () => {
    if (!p) return;
    setBusy(true);
    try {
      if (p.followStatus) await apiFetch(`/api/follows/${encodeURIComponent(p.user.username)}`, { method: 'DELETE' });
      else await apiFetch('/api/follows', { body: { username: p.user.username } });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const top = Platform.OS === 'web' ? Math.max(insets.top, 16) : insets.top;
  const followLabel = !p ? '' : p.followStatus === 'accepted' ? 'Following'
    : p.followStatus === 'pending' ? 'Requested'
    : p.followsYou ? 'Follow back' : 'Follow';

  return (
    <View style={[styles.container, { paddingTop: top }]}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/social'))}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {!p && !error ? (
        <View style={styles.center}><ActivityIndicator color={Colors.accent} size="large" /></View>
      ) : !p ? (
        <View style={styles.center}>
          <Text style={styles.muted}>{error}</Text>
          <TouchableOpacity onPress={load} style={styles.retry}><Text style={styles.retryText}>Retry</Text></TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.header}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{p.user.username[1]?.toUpperCase() ?? '?'}</Text>
            </View>
            <View style={styles.nameRow}>
              <Text style={styles.name}>{p.user.username}</Text>
              {p.user.isPrivate && <Ionicons name="lock-closed" size={16} color={Colors.textSecondary} />}
            </View>
            {p.followsYou && <Text style={styles.followsYou}>Follows you</Text>}
            <View style={styles.counts}>
              <Text style={styles.count}><Text style={styles.countNum}>{p.user.followers}</Text> followers</Text>
              <Text style={styles.count}><Text style={styles.countNum}>{p.user.following}</Text> following</Text>
            </View>
            {!p.isMe && (
              <TouchableOpacity
                style={[styles.followBtn, p.followStatus && styles.followBtnOutline]}
                onPress={follow}
                disabled={busy}
                accessibilityRole="button"
              >
                {busy ? <ActivityIndicator color={p.followStatus ? Colors.accent : '#000'} />
                  : <Text style={[styles.followText, p.followStatus && styles.followTextOutline]}>{followLabel}</Text>}
              </TouchableOpacity>
            )}
            {!!error && <Text style={styles.error}>{error}</Text>}
          </View>

          {p.canView ? (
            <>
              <View style={styles.tabs}>
                {(['liked', 'watched'] as const).map(t => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.tab, tab === t && styles.tabOn]}
                    onPress={() => setTab(t)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: tab === t }}
                  >
                    <Text style={[styles.tabText, tab === t && styles.tabTextOn]}>
                      {t === 'liked' ? `To Watch (${p.liked.length})` : `Watched (${p.watched.length})`}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TitleGrid
                items={tab === 'liked' ? p.liked : p.watched}
                empty={tab === 'liked' ? 'Nothing on their watchlist yet.' : 'Nothing watched yet.'}
              />
            </>
          ) : (
            <View style={styles.locked}>
              <Ionicons name="lock-closed" size={36} color={Colors.textMuted} />
              <Text style={styles.lockedTitle}>This account is private</Text>
              <Text style={styles.muted}>
                {p.followStatus === 'pending'
                  ? 'Your request is waiting for approval.'
                  : 'Follow this account to see what they like and watch.'}
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  topBar: { paddingHorizontal: 12, paddingVertical: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  body: { paddingHorizontal: 20, paddingBottom: 40, maxWidth: 600, width: '100%', alignSelf: 'center' },
  header: { alignItems: 'center', gap: 8, paddingBottom: 20 },
  avatar: {
    width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.bgElevated, borderWidth: 2, borderColor: Colors.accent,
  },
  avatarText: { color: Colors.accent, fontSize: 30, fontWeight: '800' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: Colors.textPrimary, fontSize: 22, fontWeight: '800' },
  followsYou: {
    color: Colors.textSecondary, fontSize: 12, fontWeight: '700', backgroundColor: Colors.bgCard,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden',
  },
  counts: { flexDirection: 'row', gap: 18 },
  count: { color: Colors.textSecondary, fontSize: 14 },
  countNum: { color: Colors.textPrimary, fontWeight: '800' },
  followBtn: {
    marginTop: 6, minWidth: 160, alignItems: 'center', paddingVertical: 11, paddingHorizontal: 22,
    borderRadius: 22, backgroundColor: Colors.accent,
  },
  followBtnOutline: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: Colors.border },
  followText: { color: '#000', fontWeight: '800', fontSize: 15 },
  followTextOutline: { color: Colors.textPrimary },
  error: { color: Colors.skip, fontSize: 13 },
  tabs: { flexDirection: 'row', backgroundColor: Colors.bgCard, borderRadius: 12, padding: 4, marginBottom: 16 },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 8 },
  tabOn: { backgroundColor: Colors.accent },
  tabText: { color: Colors.textSecondary, fontWeight: '700' },
  tabTextOn: { color: '#000' },
  locked: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  lockedTitle: { color: Colors.textPrimary, fontSize: 18, fontWeight: '800' },
  muted: { color: Colors.textMuted, fontSize: 14, textAlign: 'center' },
  retry: { backgroundColor: Colors.accent, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 18 },
  retryText: { color: '#000', fontWeight: '800' },
});
