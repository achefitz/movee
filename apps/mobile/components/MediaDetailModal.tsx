import React, { useState, useEffect } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Platform, Linking, ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MediaItem, fetchMediaDetails, MediaDetails } from '../services/tmdb';
import Colors from '../constants/colors';
import { SVC, AMC_URL } from '../constants/streaming';
import { letterboxdUrl } from '../constants/links';
import { Ratings } from './Ratings';
import { shareItem } from '../utils/share';

interface Props {
  visible: boolean;
  item: MediaItem | null;
  onClose: () => void;
  onLike?: () => void;
  onSkip?: () => void;
  onWatched?: () => void;
}

export function MediaDetailModal({ visible, item, onClose, onLike, onSkip, onWatched }: Props) {
  const insets = useSafeAreaInsets();
  const [details, setDetails] = useState<MediaDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  useEffect(() => {
    if (!visible || !item) {
      setDetails(null);
      return;
    }
    let cancelled = false;
    setLoadingDetails(true);
    fetchMediaDetails(item.type, item.id).then(d => {
      if (!cancelled) {
        setDetails(d);
        setLoadingDetails(false);
      }
    });
    return () => { cancelled = true; };
  }, [visible, item?.id, item?.type]);

  if (!item) return null;

  const streamingBadges = (item.streamingIds || []).filter(id => SVC[id]).slice(0, 4);
  const openLink = (url: string) => Linking.openURL(url).catch(() => {});
  const lbUrl = letterboxdUrl(item);

  const hasDetails = details && (details.director || details.cast.length > 0 || details.runtime);

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom + 16 }]}>
          <View style={styles.backdropContainer}>
            <Image
              source={item.backdropUrl || item.posterUrl}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
            />
            <LinearGradient
              colors={['rgba(0,0,0,0.1)', 'rgba(20,20,32,0.97)']}
              style={StyleSheet.absoluteFill}
            />
            <View style={[styles.headerBtns, { top: Platform.OS === 'web' ? 48 : insets.top + 12 }]}>
              <TouchableOpacity style={styles.iconBtn} onPress={() => shareItem(item)} activeOpacity={0.8}>
                <Ionicons name="share-outline" size={20} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.iconBtn} onPress={onClose}>
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.contentInner}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.metaRow}>
              <View style={styles.typeBadge}>
                <Text style={styles.typeBadgeText}>{item.type === 'movie' ? 'MOVIE' : 'TV'}</Text>
              </View>
              {item.year ? <Text style={styles.year}>{item.year}</Text> : null}
            </View>

            <Text style={styles.title}>{item.title}</Text>

            <View style={styles.ratingsBlock}>
              <Ratings item={item} size="lg" linked />
            </View>

            {lbUrl && (
              <TouchableOpacity
                style={styles.letterboxdBtn}
                onPress={() => openLink(lbUrl)}
                activeOpacity={0.85}
                accessibilityLabel={`Open ${item.title} on Letterboxd`}
              >
                <View style={styles.lbDots}>
                  <View style={[styles.lbDot, { backgroundColor: '#FF8000' }]} />
                  <View style={[styles.lbDot, { backgroundColor: '#00E054' }]} />
                  <View style={[styles.lbDot, { backgroundColor: '#40BCF4' }]} />
                </View>
                <Text style={styles.letterboxdText}>Reviews & rating on Letterboxd</Text>
                <Ionicons name="open-outline" size={16} color="#9AB" />
              </TouchableOpacity>
            )}

            {item.genreNames.length > 0 && (
              <View style={styles.genres}>
                {item.genreNames.map(g => (
                  <View key={g} style={styles.genreTag}>
                    <Text style={styles.genreText}>{g}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Rich metadata */}
            {loadingDetails ? (
              <View style={styles.detailsLoading}>
                <ActivityIndicator size="small" color={Colors.accent} />
              </View>
            ) : hasDetails ? (
              <View style={styles.detailsSection}>
                {details!.runtime ? (
                  <View style={styles.detailRow}>
                    <Ionicons name="time-outline" size={14} color={Colors.textMuted} />
                    <Text style={styles.detailValue}>{details!.runtime}</Text>
                  </View>
                ) : null}
                {details!.director ? (
                  <View style={styles.detailRow}>
                    <Ionicons name="videocam-outline" size={14} color={Colors.textMuted} />
                    <Text style={styles.detailLabel}>{item.type === 'tv' ? 'Created by' : 'Director'}:</Text>
                    <Text style={styles.detailValue} numberOfLines={1}>{details!.director}</Text>
                  </View>
                ) : null}
                {details!.cast.length > 0 ? (
                  <View style={styles.castRow}>
                    <Ionicons name="people-outline" size={14} color={Colors.textMuted} style={styles.castIcon} />
                    <View style={styles.castChips}>
                      {details!.cast.map(name => (
                        <View key={name} style={styles.castChip}>
                          <Text style={styles.castChipText}>{name}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                ) : null}
              </View>
            ) : null}

            {(streamingBadges.length > 0 || item.inTheaters) && (
              <View style={styles.watchSection}>
                <Text style={styles.watchLabel}>Where to Watch</Text>
                <View style={styles.streamingRow}>
                  {streamingBadges.map(id => {
                    const svc = SVC[id];
                    const url = svc.url;
                    return (
                      <TouchableOpacity
                        key={id}
                        style={[styles.streamingBadge, { backgroundColor: svc.color }]}
                        onPress={() => openLink(url)}
                        activeOpacity={0.8}
                      >
                        <Text style={styles.streamingBadgeText}>{svc.name}</Text>
                      </TouchableOpacity>
                    );
                  })}
                  {item.inTheaters && (
                    <TouchableOpacity
                      style={styles.theaterBadge}
                      onPress={() => openLink(AMC_URL)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="film" size={12} color={Colors.accent} style={{ marginRight: 4 }} />
                      <Text style={styles.theaterBadgeText}>
                        {item.theaterStatus === 'rerelease' ? 'BACK IN THEATERS' : 'IN THEATERS'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}

            {item.overview ? (
              <Text style={styles.overview}>{item.overview}</Text>
            ) : null}
          </ScrollView>

          {(onLike || onSkip || onWatched) ? (
            <View style={styles.actions}>
              {onSkip && (
                <TouchableOpacity style={[styles.actionBtn, styles.skipBtn]} onPress={onSkip}>
                  <Ionicons name="close" size={28} color={Colors.skip} />
                </TouchableOpacity>
              )}
              {onWatched && (
                <TouchableOpacity style={[styles.actionBtn, styles.watchedBtn]} onPress={onWatched}>
                  <Ionicons name="checkmark-done" size={24} color="#7B68EE" />
                  <Text style={styles.watchedBtnText}>Watched</Text>
                </TouchableOpacity>
              )}
              {onLike && (
                <TouchableOpacity style={[styles.actionBtn, styles.likeBtn]} onPress={onLike}>
                  <Ionicons name="heart" size={28} color={Colors.like} />
                </TouchableOpacity>
              )}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.bgCard,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '92%',
    overflow: 'hidden',
  },
  backdropContainer: {
    height: 200,
    position: 'relative',
  },
  headerBtns: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    gap: 8,
    zIndex: 10,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
  },
  contentInner: {
    padding: 20,
    paddingTop: 12,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  typeBadge: {
    backgroundColor: Colors.accent,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  typeBadgeText: {
    color: '#000',
    fontSize: 10,
    fontWeight: '800',
  },
  year: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  ratingsBlock: {
    marginTop: 2,
    marginBottom: 12,
  },
  letterboxdBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: '#14181C',
    borderWidth: 1,
    borderColor: '#2C3440',
    marginTop: 4,
    marginBottom: 12,
  },
  lbDots: { flexDirection: 'row', gap: 3 },
  lbDot: { width: 9, height: 9, borderRadius: 5 },
  letterboxdText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  rating: {
    color: Colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.textPrimary,
    marginBottom: 12,
  },
  genres: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 14,
  },
  genreTag: {
    backgroundColor: Colors.bgElevated,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  genreText: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '500',
  },
  detailsLoading: {
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  detailsSection: {
    backgroundColor: Colors.bgElevated,
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  detailLabel: {
    color: Colors.textMuted,
    fontSize: 12,
    fontWeight: '500',
  },
  detailValue: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  castRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  castIcon: {
    marginTop: 3,
  },
  castChips: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  castChip: {
    backgroundColor: Colors.bgCard,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  castChipText: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: '500',
  },
  watchSection: {
    marginBottom: 14,
  },
  watchLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  streamingRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  streamingBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  streamingBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  theaterBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(245,197,24,0.15)',
    borderWidth: 1,
    borderColor: Colors.accent,
  },
  theaterBadgeText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  overview: {
    color: Colors.textSecondary,
    fontSize: 14,
    lineHeight: 22,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  actionBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    borderWidth: 2,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minWidth: 64,
  },
  skipBtn: {
    borderColor: Colors.skip,
    backgroundColor: 'rgba(231,76,60,0.1)',
  },
  likeBtn: {
    borderColor: Colors.like,
    backgroundColor: 'rgba(46,204,113,0.1)',
  },
  watchedBtn: {
    borderColor: '#7B68EE',
    backgroundColor: 'rgba(123,104,238,0.1)',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 18,
  },
  watchedBtnText: {
    color: '#7B68EE',
    fontWeight: '700',
    fontSize: 13,
  },
});
