import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, Platform, ScrollView, TextInput,
  TouchableOpacity, Image, Modal, FlatList, ActivityIndicator,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ApiError, apiFetch } from '@/services/api';
import Colors from '@/constants/colors';
import { useAppContext } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { MediaItem } from '@/services/tmdb';

type Friend = {
  username: string;
  /** 'pending' = waiting for a private account to approve. */
  status: 'accepted' | 'pending';
  since: number;
  isPrivate?: boolean;
};

type FriendEvent = { item: MediaItem; action: 'liked' | 'watched'; timestamp: number; friendUsername: string };

type WpPhase = 'loading' | 'swipe' | 'results';

type FollowLists = { following: Friend[]; followers: Friend[]; requests: Friend[] };

// Follows live on the server. You see likes/watches of accounts you follow once they're
// accepted (public accounts accept automatically; private ones approve each request).
async function loadFollows(): Promise<FollowLists> {
  try {
    return await apiFetch<FollowLists>('/api/follows');
  } catch {
    return { following: [], followers: [], requests: [] };
  }
}

async function loadFriendGenreScores(friendUsername: string): Promise<Record<number, number>> {
  try {
    return (await apiFetch<{ genreScores: Record<number, number> }>(
      `/api/follows/${encodeURIComponent(friendUsername)}/taste`)).genreScores;
  } catch {
    return {};
  }
}

async function loadFriendsActivity(): Promise<FriendEvent[]> {
  try {
    return (await apiFetch<{ events: FriendEvent[] }>('/api/follows/activity?limit=20')).events;
  } catch {
    return [];
  }
}

function mergeGenreScores(
  scoresA: Record<number, number>,
  scoresB: Record<number, number>
): Record<number, number> {
  const hasFriendData = Object.keys(scoresB).length > 0;
  if (!hasFriendData) return scoresA;
  const merged: Record<number, number> = {};
  const allGenres = new Set([
    ...Object.keys(scoresA).map(Number),
    ...Object.keys(scoresB).map(Number),
  ]);
  allGenres.forEach(g => {
    const a = scoresA[g] || 0;
    const b = scoresB[g] || 0;
    if (a > 0 && b > 0) {
      merged[g] = (a + b) * 2;
    } else {
      merged[g] = a + b;
    }
  });
  return merged;
}

function computeGenreScores(items: MediaItem[]): Record<number, number> {
  const scores: Record<number, number> = {};
  items.forEach(item => {
    item.genres.forEach(g => { scores[g] = (scores[g] || 0) + 1; });
  });
  return scores;
}

function rankByGenreScores(pool: MediaItem[], scores: Record<number, number>, limit: number): MediaItem[] {
  const scored = pool.map(item => ({
    item,
    score: item.genres.reduce((acc, g) => acc + (scores[g] || 0), 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.item);
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function SocialScreen() {
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const { user } = useAuth();
  const { savedItems, watchedItems, activityLog, deckCache } = useAppContext();

  const [friends, setFriends] = useState<Friend[]>([]); // accounts you follow
  const [followers, setFollowers] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<Friend[]>([]);
  const [friendActivity, setFriendActivity] = useState<Array<{ item: MediaItem; action: 'liked' | 'watched'; timestamp: number; friendUsername: string }>>([]);
  const [inputUsername, setInputUsername] = useState('');
  const [addError, setAddError] = useState('');
  const [addSuccess, setAddSuccess] = useState('');
  const [loadingFriends, setLoadingFriends] = useState(true);
  const [activityModalVisible, setActivityModalVisible] = useState(false);

  const [watchPartyFriend, setWatchPartyFriend] = useState<Friend | null>(null);
  const [wpPhase, setWpPhase] = useState<WpPhase>('loading');
  const [wpCards, setWpCards] = useState<MediaItem[]>([]);
  const [wpCardIndex, setWpCardIndex] = useState(0);
  const [wpMyLikes, setWpMyLikes] = useState<MediaItem[]>([]);
  const [wpResults, setWpResults] = useState<{ item: MediaItem; matchPct: number }[]>([]);
  const [wpFriendScores, setWpFriendScores] = useState<Record<number, number>>({});

  const slideAnim = useRef(new Animated.Value(0)).current;

  const currentUser = user?.username ?? '';

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    Promise.all([loadFollows(), loadFriendsActivity()]).then(([lists, events]) => {
      if (cancelled) return;
      setFriends(lists.following);
      setFollowers(lists.followers);
      setRequests(lists.requests);
      setFriendActivity(events);
      setLoadingFriends(false);
    });
    return () => { cancelled = true; };
  }, [currentUser]);

  const openProfile = useCallback((username: string) => {
    router.push({ pathname: '/user/[username]', params: { username: username.replace(/^@/, '') } });
  }, []);

  const refreshFollows = useCallback(async () => {
    const [lists, events] = await Promise.all([loadFollows(), loadFriendsActivity()]);
    setFriends(lists.following);
    setFollowers(lists.followers);
    setRequests(lists.requests);
    setFriendActivity(events);
  }, []);

  const handleAddFriend = useCallback(async () => {
    setAddError('');
    setAddSuccess('');
    let username = inputUsername.trim();
    if (!username) {
      setAddError('Please enter a username.');
      return;
    }
    if (!username.startsWith('@')) username = '@' + username;
    if (username.toLowerCase() === currentUser.toLowerCase()) {
      setAddError("You can't follow yourself.");
      return;
    }
    try {
      const { follow } = await apiFetch<{ follow: Friend }>('/api/follows', { body: { username } });
      setFriends(prev => [...prev, follow]);
      setInputUsername('');
      setAddSuccess(follow.status === 'pending'
        ? `${follow.username} is private — request sent.`
        : `Following ${follow.username}!`);
      setTimeout(() => setAddSuccess(''), 3000);
      if (follow.status === 'accepted') setFriendActivity(await loadFriendsActivity());
    } catch (e) {
      setAddError(e instanceof ApiError ? e.message : "Couldn't reach the server. Try again.");
    }
  }, [inputUsername, currentUser]);

  /** Unfollow, or cancel a pending request. */
  const handleRemoveFriend = useCallback(async (username: string) => {
    setFriends(prev => prev.filter(f => f.username !== username));
    setFriendActivity(prev => prev.filter(a => a.friendUsername !== username));
    try {
      await apiFetch(`/api/follows/${encodeURIComponent(username)}`, { method: 'DELETE' });
    } catch {}
  }, []);

  const handleRequest = useCallback(async (username: string, decision: 'approve' | 'decline') => {
    setRequests(prev => prev.filter(r => r.username !== username));
    try {
      await apiFetch(`/api/follows/requests/${encodeURIComponent(username)}/${decision}`, { method: 'POST' });
    } catch {}
    refreshFollows();
  }, [refreshFollows]);

  const handleRemoveFollower = useCallback(async (username: string) => {
    setFollowers(prev => prev.filter(f => f.username !== username));
    try {
      await apiFetch(`/api/follows/followers/${encodeURIComponent(username)}`, { method: 'DELETE' });
    } catch {}
  }, []);

  const handleWatchParty = useCallback(async (friend: Friend) => {
    setWatchPartyFriend(friend);
    setWpPhase('loading');
    setWpCardIndex(0);
    setWpMyLikes([]);
    setWpResults([]);
    setWpCards([]);

    const myScores = computeGenreScores(savedItems);
    const friendScores = await loadFriendGenreScores(friend.username);
    setWpFriendScores(friendScores);
    const merged = mergeGenreScores(myScores, friendScores);

    const pool = deckCache.length > 0 ? deckCache : [...savedItems, ...watchedItems];
    const unique = Array.from(new Map(pool.map(i => [i.id, i])).values());
    const moviesOnly = unique.filter(i => i.type === 'movie');
    const ranked = rankByGenreScores(moviesOnly, merged, 10);
    setWpCards(ranked);
    setWpPhase('swipe');
  }, [savedItems, watchedItems, deckCache]);

  const handleWpSwipe = useCallback((liked: boolean) => {
    const currentCard = wpCards[wpCardIndex];
    const newLikes = liked ? [...wpMyLikes, currentCard] : wpMyLikes;
    const newIndex = wpCardIndex + 1;

    if (newIndex >= wpCards.length) {
      const maxScore = newLikes.reduce((best, item) => {
        const s = item.genres.reduce((acc, g) => acc + (wpFriendScores[g] || 0), 0);
        return Math.max(best, s);
      }, 1);
      const scored = newLikes.map(item => {
        const score = item.genres.reduce((acc, g) => acc + (wpFriendScores[g] || 0), 0);
        return { item, matchPct: Math.round((score / maxScore) * 100) };
      });
      scored.sort((a, b) => b.matchPct - a.matchPct);
      setWpResults(scored.slice(0, 3));
      setWpMyLikes(newLikes);
      setWpPhase('results');
    } else {
      Animated.sequence([
        Animated.timing(slideAnim, { toValue: liked ? 80 : -80, duration: 140, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]).start();
      setWpMyLikes(newLikes);
      setWpCardIndex(newIndex);
    }
  }, [wpCards, wpCardIndex, wpMyLikes, wpFriendScores, slideAnim]);

  const closeWatchParty = useCallback(() => {
    setWatchPartyFriend(null);
    setWpPhase('loading');
    setWpCardIndex(0);
    setWpMyLikes([]);
    setWpResults([]);
    setWpCards([]);
  }, []);

  const recentActivity = useMemo(() => activityLog.slice(0, 10), [activityLog]);

  const combinedActivity = useMemo(() => {
    const myEvents = recentActivity.map(e => ({ ...e, actorLabel: 'You', isMine: true }));
    const frEvents = friendActivity.slice(0, 10).map(e => ({ ...e, actorLabel: e.friendUsername, isMine: false }));
    return [...myEvents, ...frEvents].sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
  }, [recentActivity, friendActivity]);

  const currentWpCard = wpCards[wpCardIndex] ?? null;
  const wpTotal = wpCards.length;

  if (!user) {
    return (
      <View style={[styles.container, { paddingTop: topPad }]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Social</Text>
        </View>
        <View style={styles.centered}>
          <Ionicons name="people-outline" size={56} color={Colors.textMuted} />
          <Text style={styles.emptyText}>Sign in to use the Social tab.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: topPad }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Social</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Follow someone</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder="@username"
              placeholderTextColor={Colors.textMuted}
              value={inputUsername}
              onChangeText={t => { setInputUsername(t); setAddError(''); setAddSuccess(''); }}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={handleAddFriend}
              returnKeyType="done"
            />
            <TouchableOpacity style={styles.addButton} onPress={handleAddFriend} activeOpacity={0.8}>
              <Text style={styles.addButtonText}>Follow</Text>
            </TouchableOpacity>
          </View>
          {!!addError && <Text style={styles.errorText}>{addError}</Text>}
          {!!addSuccess && <Text style={styles.successText}>{addSuccess}</Text>}
        </View>

        {requests.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Requests ({requests.length})</Text>
            {requests.map(r => (
              <View key={r.username} style={styles.friendRow}>
                <TouchableOpacity
                  style={styles.profileLink}
                  onPress={() => openProfile(r.username)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${r.username}'s profile`}
                >
                  <View style={styles.friendAvatar}>
                    <Text style={styles.friendAvatarText}>{r.username[1]?.toUpperCase() ?? '?'}</Text>
                  </View>
                  <Text style={styles.friendName} numberOfLines={1}>{r.username}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.approveBtn}
                  onPress={() => handleRequest(r.username, 'approve')}
                  activeOpacity={0.8}
                  accessibilityLabel={`Approve ${r.username}`}
                >
                  <Text style={styles.approveBtnText}>Approve</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.declineBtn}
                  onPress={() => handleRequest(r.username, 'decline')}
                  activeOpacity={0.8}
                  accessibilityLabel={`Decline ${r.username}`}
                >
                  <Text style={styles.declineBtnText}>Decline</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Following</Text>
          {loadingFriends ? (
            <ActivityIndicator color={Colors.accent} style={{ marginVertical: 12 }} />
          ) : friends.length === 0 ? (
            <Text style={styles.emptySmall}>You're not following anyone yet. Search by @username above.</Text>
          ) : (
            friends.map(friend => (
              <View key={friend.username} style={styles.friendRow}>
                <TouchableOpacity
                  style={styles.profileLink}
                  onPress={() => openProfile(friend.username)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${friend.username}'s profile`}
                >
                  <View style={styles.friendAvatar}>
                    <Text style={styles.friendAvatarText}>{friend.username[1]?.toUpperCase() ?? '?'}</Text>
                  </View>
                  <Text style={styles.friendName} numberOfLines={1}>{friend.username}</Text>
                </TouchableOpacity>
                {friend.status === 'pending' ? (
                  <View style={styles.pendingPill}>
                    <Ionicons name="lock-closed" size={11} color={Colors.textSecondary} />
                    <Text style={styles.pendingPillText}>Requested</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.watchPartyBtn}
                    onPress={() => handleWatchParty(friend)}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.watchPartyBtnText}>Watch Party 🎉</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={styles.removeBtn}
                  onPress={() => handleRemoveFriend(friend.username)}
                  activeOpacity={0.7}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel={friend.status === 'pending' ? `Cancel request to ${friend.username}` : `Unfollow ${friend.username}`}
                >
                  <Ionicons name="close-circle" size={22} color={Colors.textMuted} />
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Followers ({followers.length})</Text>
          {followers.length === 0 ? (
            <Text style={styles.emptySmall}>
              {user?.isPrivate
                ? 'Your account is private: people need your approval to follow you.'
                : 'Nobody follows you yet. Share your @username!'}
            </Text>
          ) : (
            followers.map(f => (
              <View key={f.username} style={styles.friendRow}>
                <TouchableOpacity
                  style={styles.profileLink}
                  onPress={() => openProfile(f.username)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${f.username}'s profile`}
                >
                  <View style={styles.friendAvatar}>
                    <Text style={styles.friendAvatarText}>{f.username[1]?.toUpperCase() ?? '?'}</Text>
                  </View>
                  <Text style={styles.friendName} numberOfLines={1}>{f.username}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.removeBtn}
                  onPress={() => handleRemoveFollower(f.username)}
                  activeOpacity={0.7}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel={`Remove follower ${f.username}`}
                >
                  <Ionicons name="close-circle" size={22} color={Colors.textMuted} />
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        <TouchableOpacity
          style={styles.activityRow}
          onPress={() => setActivityModalVisible(true)}
          activeOpacity={0.8}
        >
          <View style={styles.activityRowIcon}>
            <Ionicons name="pulse" size={20} color={Colors.accent} />
          </View>
          <View style={styles.activityRowContent}>
            <Text style={styles.activityRowTitle}>Activity Feed</Text>
            <Text style={styles.activityRowSubtitle}>
              {combinedActivity.length === 0
                ? 'No activity yet'
                : `${combinedActivity.length} recent events`}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={Colors.textMuted} />
        </TouchableOpacity>
      </ScrollView>

      <Modal
        visible={activityModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setActivityModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { paddingBottom: Math.max(insets.bottom, 24) }]}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderText}>
                <Text style={styles.modalTitle}>Activity Feed</Text>
                <Text style={styles.modalSubtitle}>Your swipes & friends' recent activity</Text>
              </View>
              <TouchableOpacity onPress={() => setActivityModalVisible(false)} hitSlop={8}>
                <Ionicons name="close" size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
            {combinedActivity.length === 0 ? (
              <View style={styles.centered}>
                <Ionicons name="pulse-outline" size={40} color={Colors.textMuted} />
                <Text style={styles.emptyText}>No activity yet — start swiping to see your history here.</Text>
              </View>
            ) : (
              <FlatList
                data={combinedActivity}
                keyExtractor={(item, idx) => `${item.item.id}-${item.action}-${idx}`}
                contentContainerStyle={{ padding: 16, paddingBottom: 8 }}
                renderItem={({ item: event }) => (
                  <View style={styles.activityItem}>
                    {event.item.posterUrl ? (
                      <Image source={{ uri: event.item.posterUrl }} style={styles.activityPoster} />
                    ) : (
                      <View style={[styles.activityPoster, styles.activityPosterPlaceholder]}>
                        <Ionicons name="film-outline" size={20} color={Colors.textMuted} />
                      </View>
                    )}
                    <View style={styles.activityInfo}>
                      <Text
                        style={styles.activityActor}
                        numberOfLines={1}
                        onPress={event.isMine ? undefined : () => { setActivityModalVisible(false); openProfile(event.actorLabel); }}
                      >{event.actorLabel}</Text>
                      <Text style={styles.activityTitle} numberOfLines={1}>{event.item.title}</Text>
                      <View style={styles.activityMeta}>
                        <View style={[styles.typeBadge, event.action === 'liked' ? styles.typeBadgeLiked : styles.typeBadgeWatched]}>
                          <Text style={styles.typeBadgeText}>{event.action === 'liked' ? '❤️ Liked' : '✅ Watched'}</Text>
                        </View>
                        <View style={[styles.mediaBadge, event.item.type === 'movie' ? styles.mediaBadgeMovie : styles.mediaBadgeTV]}>
                          <Text style={styles.mediaBadgeText}>{event.item.type === 'movie' ? 'Movie' : 'TV'}</Text>
                        </View>
                      </View>
                      <Text style={styles.activityTime}>{relativeTime(event.timestamp)}</Text>
                    </View>
                  </View>
                )}
              />
            )}
          </View>
        </View>
      </Modal>

      <Modal
        visible={watchPartyFriend !== null}
        animationType="slide"
        transparent={false}
        onRequestClose={closeWatchParty}
      >
        <View style={[styles.wpFullScreen, { paddingTop: Math.max(insets.top, 20), paddingBottom: Math.max(insets.bottom, 24) }]}>
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderText}>
                <Text style={styles.modalTitle}>Watch Party 🎉</Text>
                <Text style={styles.modalSubtitle}>
                  {wpPhase === 'swipe'
                    ? `Swipe to pick tonight's watch with ${watchPartyFriend?.username}`
                    : wpPhase === 'results'
                    ? `Top picks for you & ${watchPartyFriend?.username}`
                    : `Finding movies for you & ${watchPartyFriend?.username}`}
                </Text>
              </View>
              <TouchableOpacity onPress={closeWatchParty} hitSlop={8}>
                <Ionicons name="close" size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {wpPhase === 'loading' && (
              <View style={[styles.centered, { minHeight: 320 }]}>
                <ActivityIndicator size="large" color={Colors.accent} />
                <Text style={[styles.emptyText, { marginTop: 16 }]}>Building your movie mix…</Text>
              </View>
            )}

            {wpPhase === 'swipe' && wpCards.length === 0 && (
              <View style={[styles.centered, { minHeight: 320 }]}>
                <Ionicons name="film-outline" size={48} color={Colors.textMuted} />
                <Text style={styles.emptyText}>Not enough movies yet. Keep swiping to improve recommendations!</Text>
              </View>
            )}

            {wpPhase === 'swipe' && currentWpCard && (
              <View style={styles.wpSwipeContainer}>
                <Text style={styles.wpProgress}>{wpCardIndex + 1} / {wpTotal}</Text>
                <View style={styles.wpProgressBar}>
                  <View style={[styles.wpProgressFill, { width: `${((wpCardIndex + 1) / wpTotal) * 100}%` }]} />
                </View>

                <Animated.View style={[styles.wpCard, { transform: [{ translateX: slideAnim }] }]}>
                  {currentWpCard.posterUrl ? (
                    <Image source={{ uri: currentWpCard.posterUrl }} style={styles.wpPoster} />
                  ) : (
                    <View style={[styles.wpPoster, styles.wpPosterPlaceholder]}>
                      <Ionicons name="film-outline" size={48} color={Colors.textMuted} />
                    </View>
                  )}
                  <View style={styles.wpCardInfo}>
                    <Text style={styles.wpCardTitle} numberOfLines={2}>{currentWpCard.title}</Text>
                    <Text style={styles.wpCardMeta}>
                      🎬 {currentWpCard.year}
                      {currentWpCard.rating > 0 ? `  ⭐ ${currentWpCard.rating.toFixed(1)}` : ''}
                    </Text>
                  </View>
                </Animated.View>

                <View style={styles.wpButtons}>
                  <TouchableOpacity
                    style={[styles.wpBtn, styles.wpPassBtn]}
                    onPress={() => handleWpSwipe(false)}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="close" size={30} color="#E74C3C" />
                    <Text style={[styles.wpBtnLabel, { color: '#E74C3C' }]}>Pass</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.wpBtn, styles.wpYesBtn]}
                    onPress={() => handleWpSwipe(true)}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="heart" size={30} color="#2ECC71" />
                    <Text style={[styles.wpBtnLabel, { color: '#2ECC71' }]}>Yes!</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {wpPhase === 'results' && (
              <View style={styles.wpResultsContainer}>
                {wpResults.length === 0 ? (
                  <View style={styles.centered}>
                    <Ionicons name="sad-outline" size={48} color={Colors.textMuted} />
                    <Text style={styles.emptyText}>You passed on everything! Try again with different picks.</Text>
                    <TouchableOpacity style={styles.wpRetryBtn} onPress={() => handleWatchParty(watchPartyFriend!)}>
                      <Text style={styles.wpRetryBtnText}>Try Again</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <Text style={styles.wpResultsHeading}>Tonight's picks</Text>
                    {wpResults.map((result, idx) => (
                      <View key={result.item.id} style={styles.wpResultItem}>
                        <View style={styles.wpRankBadge}>
                          <Text style={styles.wpRankText}>{idx + 1}</Text>
                        </View>
                        {result.item.posterUrl ? (
                          <Image source={{ uri: result.item.posterUrl }} style={styles.wpResultPoster} />
                        ) : (
                          <View style={[styles.wpResultPoster, styles.wpPosterPlaceholder]}>
                            <Ionicons name="film-outline" size={24} color={Colors.textMuted} />
                          </View>
                        )}
                        <View style={styles.wpResultInfo}>
                          <Text style={styles.wpResultTitle} numberOfLines={2}>{result.item.title}</Text>
                          <Text style={styles.wpResultMeta}>
                            🎬 {result.item.year}
                          </Text>
                        </View>
                        <View style={styles.wpMatchBadge}>
                          <Text style={styles.wpMatchPct}>{result.matchPct}%</Text>
                          <Text style={styles.wpMatchLabel}>match</Text>
                        </View>
                      </View>
                    ))}
                    <TouchableOpacity style={styles.wpDoneBtn} onPress={closeWatchParty}>
                      <Text style={styles.wpDoneBtnText}>Done</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    paddingTop: 8,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: Colors.textPrimary,
    letterSpacing: -0.5,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 120,
  },
  section: {
    marginHorizontal: 16,
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginBottom: 12,
    letterSpacing: 0.2,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: Colors.bgCard,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: Colors.textPrimary,
    fontSize: 15,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  addButton: {
    backgroundColor: Colors.accent,
    borderRadius: 12,
    paddingHorizontal: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addButtonText: {
    color: '#000',
    fontWeight: '700',
    fontSize: 15,
  },
  errorText: {
    color: Colors.skip,
    fontSize: 13,
    marginTop: 6,
  },
  successText: {
    color: Colors.like,
    fontSize: 13,
    marginTop: 6,
  },
  emptySmall: {
    color: Colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
    paddingVertical: 12,
  },
  profileLink: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.bgCard,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 8,
    gap: 10,
  },
  friendAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(245,197,24,0.15)',
    borderWidth: 1,
    borderColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  friendAvatarText: {
    color: Colors.accent,
    fontWeight: '700',
    fontSize: 16,
  },
  friendName: {
    flex: 1,
    color: Colors.textPrimary,
    fontWeight: '600',
    fontSize: 14,
  },
  pendingPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
    backgroundColor: Colors.bgElevated, borderWidth: 1, borderColor: Colors.border,
  },
  pendingPillText: { color: Colors.textSecondary, fontSize: 12, fontWeight: '600' },
  approveBtn: { backgroundColor: Colors.accent, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14 },
  approveBtnText: { color: '#000', fontWeight: '800', fontSize: 12 },
  declineBtn: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 14, borderWidth: 1, borderColor: Colors.border },
  declineBtnText: { color: Colors.textSecondary, fontWeight: '700', fontSize: 12 },
  watchPartyBtn: {
    backgroundColor: 'rgba(245,197,24,0.15)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(245,197,24,0.3)',
  },
  watchPartyBtnText: {
    color: Colors.accent,
    fontWeight: '700',
    fontSize: 12,
  },
  removeBtn: {
    marginLeft: 2,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.bgCard,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 12,
  },
  activityRowIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(245,197,24,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityRowContent: {
    flex: 1,
  },
  activityRowTitle: {
    color: Colors.textPrimary,
    fontWeight: '700',
    fontSize: 15,
  },
  activityRowSubtitle: {
    color: Colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  activityItem: {
    flexDirection: 'row',
    backgroundColor: Colors.bgCard,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 8,
    gap: 12,
    alignItems: 'center',
  },
  activityPoster: {
    width: 52,
    height: 76,
    borderRadius: 8,
    backgroundColor: Colors.bgElevated,
  },
  activityPosterPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityInfo: {
    flex: 1,
    gap: 4,
  },
  activityActor: {
    color: Colors.accent,
    fontWeight: '700',
    fontSize: 12,
    marginBottom: 1,
  },
  activityTitle: {
    color: Colors.textPrimary,
    fontWeight: '700',
    fontSize: 14,
  },
  activityMeta: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  typeBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  typeBadgeLiked: {
    backgroundColor: 'rgba(46,204,113,0.15)',
  },
  typeBadgeWatched: {
    backgroundColor: 'rgba(52,152,219,0.15)',
  },
  typeBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  mediaBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  mediaBadgeMovie: {
    backgroundColor: 'rgba(155,89,182,0.15)',
  },
  mediaBadgeTV: {
    backgroundColor: 'rgba(230,126,34,0.15)',
  },
  mediaBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  activityTime: {
    color: Colors.textMuted,
    fontSize: 11,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyText: {
    color: Colors.textMuted,
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 22,
    marginTop: 12,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: Colors.bgElevated,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '90%',
  },
  modalHandle: {
    width: 40,
    height: 4,
    backgroundColor: Colors.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  modalHeaderText: {
    flex: 1,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: Colors.textPrimary,
  },
  modalSubtitle: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  wpFullScreen: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  wpSwipeContainer: {
    flex: 1,
    padding: 20,
    alignItems: 'center',
  },
  wpProgress: {
    color: Colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
  },
  wpProgressBar: {
    width: '100%',
    height: 4,
    backgroundColor: Colors.border,
    borderRadius: 2,
    marginBottom: 20,
    overflow: 'hidden',
  },
  wpProgressFill: {
    height: 4,
    backgroundColor: Colors.accent,
    borderRadius: 2,
  },
  wpCard: {
    width: '100%',
    backgroundColor: Colors.bgCard,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 20,
  },
  wpPoster: {
    width: '100%',
    height: 240,
    backgroundColor: Colors.bg,
  },
  wpPosterPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  wpCardInfo: {
    padding: 14,
    gap: 6,
  },
  wpCardTitle: {
    color: Colors.textPrimary,
    fontWeight: '800',
    fontSize: 17,
  },
  wpCardMeta: {
    color: Colors.textMuted,
    fontSize: 13,
  },
  wpButtons: {
    flexDirection: 'row',
    gap: 20,
    width: '100%',
    justifyContent: 'center',
  },
  wpBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 16,
    borderWidth: 2,
    gap: 4,
  },
  wpPassBtn: {
    borderColor: '#E74C3C',
    backgroundColor: 'rgba(231,76,60,0.1)',
  },
  wpYesBtn: {
    borderColor: '#2ECC71',
    backgroundColor: 'rgba(46,204,113,0.1)',
  },
  wpBtnLabel: {
    fontWeight: '700',
    fontSize: 14,
  },
  wpResultsContainer: {
    flex: 1,
    padding: 20,
  },
  wpResultsHeading: {
    fontSize: 17,
    fontWeight: '800',
    color: Colors.textPrimary,
    marginBottom: 16,
    textAlign: 'center',
  },
  wpResultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.bgCard,
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    gap: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  wpRankBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wpRankText: {
    color: '#000',
    fontWeight: '800',
    fontSize: 13,
  },
  wpResultPoster: {
    width: 48,
    height: 72,
    borderRadius: 8,
    backgroundColor: Colors.bg,
  },
  wpResultInfo: {
    flex: 1,
    gap: 4,
  },
  wpResultTitle: {
    color: Colors.textPrimary,
    fontWeight: '700',
    fontSize: 14,
  },
  wpResultMeta: {
    color: Colors.textMuted,
    fontSize: 12,
  },
  wpMatchBadge: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245,197,24,0.12)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(245,197,24,0.3)',
  },
  wpMatchPct: {
    color: Colors.accent,
    fontWeight: '800',
    fontSize: 16,
  },
  wpMatchLabel: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },
  wpDoneBtn: {
    backgroundColor: Colors.accent,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  wpDoneBtnText: {
    color: '#000',
    fontWeight: '800',
    fontSize: 16,
  },
  wpRetryBtn: {
    backgroundColor: Colors.bgCard,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 28,
    alignItems: 'center',
    marginTop: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  wpRetryBtnText: {
    color: Colors.textPrimary,
    fontWeight: '700',
    fontSize: 15,
  },
});
