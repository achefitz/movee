import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../constants/colors';
import { STREAMING_FILTER_LIST, SVC } from '../constants/streaming';
import { useAppContext } from '../context/AppContext';
import { ApiError } from '../services/api';
import {
  acceptParty, createParty, declineParty, leaveParty, listParties, MAX_PARTY_GUESTS, partyNames, startParty,
  type PartySummary,
} from '../services/parties';
import { confirmAction } from '../utils/confirm';

const POLL_MS = 6000;

type Setup = { mode: 'create' } | { mode: 'accept'; party: PartySummary };

/**
 * Social tab's watch party section: one "Start a watch party" button (invite up to 6 people),
 * then invites to answer, parties gathering people, in progress and finished. Polls while the
 * tab is open (there are no push notifications).
 */
export function WatchParties({ friends }: { friends: string[] }) {
  const { filters } = useAppContext();
  const [parties, setParties] = useState<PartySummary[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; msg: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try { setParties(await listParties()); } catch { /* keep what we have */ }
  }, []);

  useFocusEffect(useCallback(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]));

  const run = async (p: PartySummary, fn: () => Promise<unknown>) => {
    setBusyId(p.id); setRowError(null);
    try { await fn(); } catch (e) {
      setRowError({ id: p.id, msg: e instanceof ApiError ? e.message : "Couldn't reach the server. Try again." });
    }
    await refresh();
    setBusyId(null);
  };

  const leave = (p: PartySummary) => {
    const host = p.role === 'host';
    confirmAction(
      'Watch party',
      host ? 'Call off this watch party for everyone?' : 'Leave this watch party?',
      host ? 'Call it off' : 'Leave',
      () => run(p, () => leaveParty(p.id)),
    );
  };

  const open = (p: PartySummary) => router.push({ pathname: '/party/[id]', params: { id: p.id } });
  const kind = (p: PartySummary) => (p.mediaType === 'movie' ? 'Movies' : 'TV shows');

  const invites = parties.filter(p => p.status === 'pending' && p.myStatus === 'invited');
  const gathering = parties.filter(p => p.status === 'pending' && p.myStatus === 'joined');
  const running = parties.filter(p => (p.status === 'active' || p.status === 'done') && p.myStatus !== 'invited');
  const lateInvites = parties.filter(p => (p.status === 'active' || p.status === 'done') && p.myStatus === 'invited');

  return (
    <View style={styles.section}>
      <View style={styles.headRow}>
        <Text style={styles.sectionTitle}>Watch parties</Text>
      </View>
      <TouchableOpacity
        style={styles.startBtn}
        onPress={() => setSetup({ mode: 'create' })}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Start a watch party"
      >
        <Text style={styles.startEmoji}>🎉</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.startTitle}>Start a watch party</Text>
          <Text style={styles.startSub}>Invite up to {MAX_PARTY_GUESTS} friends and swipe to pick tonight's watch together</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color="#000" />
      </TouchableOpacity>

      {[...invites, ...lateInvites].map(p => (
        <View key={p.id} style={[styles.card, styles.inviteCard]}>
          <View style={styles.cardText}>
            <Text style={styles.cardTitle}>🎉 {p.host} invited you</Text>
            <Text style={styles.cardSub}>
              {kind(p)} · with {partyNames(p, 3)} · {serviceNames(p.providers)}
              {p.status !== 'pending' ? ' · already swiping' : ''}
            </Text>
          </View>
          <View style={styles.cardActions}>
            <TouchableOpacity
              style={styles.ghostBtn}
              onPress={() => run(p, () => declineParty(p.id))}
              disabled={busyId === p.id}
              accessibilityRole="button"
              accessibilityLabel={`Decline ${p.host}'s watch party`}
            >
              <Text style={styles.ghostText}>Decline</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.goldBtn}
              onPress={() => setSetup({ mode: 'accept', party: p })}
              accessibilityRole="button"
              accessibilityLabel={`Accept ${p.host}'s watch party`}
            >
              <Text style={styles.goldText}>Accept</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}

      {gathering.map(p => {
        const invited = p.members.filter(m => m.role === 'guest' && m.status !== 'left');
        const joinedGuests = invited.filter(m => m.status === 'joined').length;
        return (
          <View key={p.id} style={styles.card}>
            <View style={styles.cardText}>
              <Text style={styles.cardTitle}>
                {p.role === 'host' ? 'Gathering your group' : `Waiting for ${p.host}'s group`}
              </Text>
              <Text style={styles.cardSub}>{kind(p)} · {joinedGuests}/{invited.length} joined</Text>
              <View style={styles.memberChips}>
                {invited.map(m => (
                  <View key={m.username} style={[styles.memberChip, m.status === 'joined' && styles.memberIn, m.status === 'declined' && styles.memberOut]}>
                    <Text style={styles.memberText}>
                      {m.status === 'joined' ? '✓ ' : m.status === 'declined' ? '✕ ' : '… '}{m.isMe ? 'You' : m.username}
                    </Text>
                  </View>
                ))}
              </View>
              {rowError?.id === p.id && <Text style={styles.error}>{rowError.msg}</Text>}
            </View>
            <View style={styles.cardActions}>
              <TouchableOpacity style={styles.ghostBtn} onPress={() => leave(p)} accessibilityRole="button" accessibilityLabel={p.role === 'host' ? 'Call off watch party' : 'Leave watch party'}>
                <Text style={styles.ghostText}>{p.role === 'host' ? 'Call off' : 'Leave'}</Text>
              </TouchableOpacity>
              {p.role === 'host' && (
                <TouchableOpacity
                  style={[styles.goldBtn, joinedGuests === 0 && styles.disabled]}
                  onPress={() => run(p, async () => { open(await startParty(p.id)); })}
                  disabled={joinedGuests === 0 || busyId === p.id}
                  accessibilityRole="button"
                  accessibilityLabel="Start now"
                >
                  {busyId === p.id ? <ActivityIndicator color="#000" /> : <Text style={styles.goldText}>Start now</Text>}
                </TouchableOpacity>
              )}
            </View>
          </View>
        );
      })}

      {running.map(p => {
        const iDone = p.myProgress >= p.size;
        const finished = p.status === 'done' || iDone;
        const label = finished
          ? `${p.matches.length} match${p.matches.length === 1 ? '' : 'es'}`
          : p.myProgress === 0 ? 'Start swiping' : 'Keep swiping';
        return (
          <TouchableOpacity
            key={p.id}
            style={styles.card}
            onPress={() => open(p)}
            onLongPress={() => leave(p)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`Watch party with ${partyNames(p, 6)}`}
          >
            <View style={styles.cardText}>
              <Text style={styles.cardTitle} numberOfLines={1}>🍿 With {partyNames(p)}</Text>
              <Text style={styles.cardSub}>
                {kind(p)} · you {Math.min(p.myProgress, p.size)}/{p.size} · {p.joined} in the group
              </Text>
            </View>
            <View style={[styles.pill, finished && styles.pillDone]}>
              <Text style={[styles.pillText, finished && styles.pillTextDone]}>{label}</Text>
            </View>
          </TouchableOpacity>
        );
      })}

      <PartySetupSheet
        setup={setup}
        friends={friends}
        myServices={filters.streaming ?? []}
        onClose={() => setSetup(null)}
        onDone={async (party) => {
          setSetup(null);
          await refresh();
          if (party.status === 'active' || party.status === 'done') open(party);
        }}
      />
    </View>
  );
}

function serviceNames(ids: number[]) {
  const names = ids.map(id => SVC[id]?.name).filter(Boolean);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ') || 'Any service';
}

/** Create: pick friends (up to 6), Movies or TV, services. Accept: add your services. */
function PartySetupSheet({ setup, friends, myServices, onClose, onDone }: {
  setup: Setup | null;
  friends: string[];
  myServices: number[];
  onClose: () => void;
  onDone: (p: PartySummary) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [mediaType, setMediaType] = useState<'movie' | 'tv'>('movie');
  const [services, setServices] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!setup) return;
    setError(''); setBusy(false);
    if (setup.mode === 'create') {
      setPicked([]);
      setMediaType('movie');
      setServices(myServices);
    } else {
      setMediaType(setup.party.mediaType);
      setServices([...new Set([...setup.party.providers, ...myServices])]);
    }
  }, [setup, myServices]);

  if (!setup) return null;
  const locked = setup.mode === 'accept' ? setup.party.providers : [];
  const lateJoin = setup.mode === 'accept' && setup.party.status !== 'pending';

  const togglePerson = (u: string) => {
    setError('');
    setPicked(p => {
      if (p.includes(u)) return p.filter(x => x !== u);
      if (p.length >= MAX_PARTY_GUESTS) { setError(`You can invite up to ${MAX_PARTY_GUESTS} people.`); return p; }
      return [...p, u];
    });
  };
  const toggleService = (id: number) => {
    if (locked.includes(id) || lateJoin) return;
    setServices(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));
  };

  const submit = async () => {
    if (setup.mode === 'create' && picked.length === 0) { setError('Pick at least one friend.'); return; }
    if (services.length === 0) { setError('Pick at least one streaming service.'); return; }
    setBusy(true); setError('');
    try {
      const party = setup.mode === 'create'
        ? await createParty(picked, mediaType, services)
        : await acceptParty(setup.party.id, lateJoin ? [] : services);
      onDone(party);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't reach the server. Try again.");
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>
              {setup.mode === 'create' ? 'New watch party' : `Join ${setup.party.host}'s watch party`}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={24} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ gap: 14, paddingBottom: 8 }}>
            {setup.mode === 'create' && (
              <>
                <Text style={styles.label}>Who's coming? ({picked.length}/{MAX_PARTY_GUESTS})</Text>
                {friends.length === 0 ? (
                  <Text style={styles.hint}>Follow someone (or get a follower) to invite them.</Text>
                ) : (
                  <View style={styles.chips}>
                    {friends.map(u => {
                      const on = picked.includes(u);
                      return (
                        <TouchableOpacity
                          key={u}
                          style={[styles.chip, on && styles.personOn]}
                          onPress={() => togglePerson(u)}
                          accessibilityRole="button"
                          accessibilityLabel={`${on ? 'Remove' : 'Invite'} ${u}`}
                          accessibilityState={{ selected: on }}
                        >
                          <Text style={[styles.chipText, on && styles.personTextOn]}>{on ? '✓ ' : ''}{u}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </>
            )}

            {setup.mode === 'accept' && (
              <Text style={styles.hint}>With {partyNames(setup.party, 6)}</Text>
            )}

            <Text style={styles.label}>What are you watching?</Text>
            {setup.mode === 'create' ? (
              <View style={styles.segment}>
                {(['movie', 'tv'] as const).map(t => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.segmentBtn, mediaType === t && styles.segmentOn]}
                    onPress={() => setMediaType(t)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: mediaType === t }}
                  >
                    <Ionicons name={t === 'movie' ? 'film' : 'tv'} size={16} color={mediaType === t ? '#000' : Colors.textSecondary} />
                    <Text style={[styles.segmentText, mediaType === t && styles.segmentTextOn]}>{t === 'movie' ? 'Movies' : 'TV shows'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : (
              <Text style={styles.fixed}>{mediaType === 'movie' ? 'Movies' : 'TV shows'} (picked by {setup.party.host})</Text>
            )}

            <Text style={styles.label}>Streaming services</Text>
            <Text style={styles.hint}>
              {setup.mode === 'create'
                ? 'Only titles on these services will show up. Friends can add theirs when they accept.'
                : lateJoin
                  ? 'The group already started swiping, so the services are set.'
                  : `${setup.party.host}'s picks are included; add any you have.`}
            </Text>
            <View style={styles.chips}>
              {STREAMING_FILTER_LIST.map(s => {
                const on = services.includes(s.id);
                const isLocked = locked.includes(s.id);
                return (
                  <TouchableOpacity
                    key={s.id}
                    style={[styles.chip, on && { backgroundColor: SVC[s.id]?.color ?? Colors.accent, borderColor: 'transparent' }]}
                    onPress={() => toggleService(s.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on, disabled: isLocked || lateJoin }}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{s.name}{isLocked ? ' ✓' : ''}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {!!error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>
          <TouchableOpacity style={[styles.submit, busy && { opacity: 0.7 }]} onPress={submit} disabled={busy} accessibilityRole="button">
            {busy ? <ActivityIndicator color="#000" /> : (
              <Text style={styles.submitText}>
                {setup.mode === 'create'
                  ? picked.length ? `Invite ${picked.length} friend${picked.length === 1 ? '' : 's'}` : 'Send invites'
                  : 'Join'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  section: { marginHorizontal: 16, marginBottom: 24 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sectionTitle: { color: Colors.textPrimary, fontSize: 16, fontWeight: '700' },
  startBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, marginBottom: 10,
    borderRadius: 16, backgroundColor: Colors.accent,
  },
  startEmoji: { fontSize: 26 },
  startTitle: { color: '#000', fontSize: 16, fontWeight: '800' },
  startSub: { color: 'rgba(0,0,0,0.7)', fontSize: 12, marginTop: 2 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, marginBottom: 8,
    borderRadius: 14, backgroundColor: Colors.bgCard, borderWidth: 1, borderColor: Colors.border, flexWrap: 'wrap',
  },
  inviteCard: { borderColor: Colors.accent, flexDirection: 'column', alignItems: 'stretch' },
  cardText: { flex: 1, minWidth: 180, gap: 3 },
  cardTitle: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  cardSub: { color: Colors.textSecondary, fontSize: 12 },
  cardActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginLeft: 'auto' },
  memberChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  memberChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.border },
  memberIn: { borderColor: '#2ECC71' },
  memberOut: { opacity: 0.5 },
  memberText: { color: Colors.textSecondary, fontSize: 11, fontWeight: '600' },
  goldBtn: { backgroundColor: Colors.accent, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 18, minWidth: 92, alignItems: 'center' },
  goldText: { color: '#000', fontWeight: '800', fontSize: 14 },
  disabled: { opacity: 0.4 },
  ghostBtn: { borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18 },
  ghostText: { color: Colors.textSecondary, fontWeight: '700', fontSize: 13 },
  pill: { backgroundColor: 'rgba(245,197,24,0.14)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12 },
  pillDone: { backgroundColor: 'rgba(46,204,113,0.16)' },
  pillText: { color: Colors.accent, fontWeight: '800', fontSize: 12 },
  pillTextDone: { color: '#2ECC71' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '88%', backgroundColor: Colors.bgCard, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 22, paddingBottom: 30, gap: 14, borderTopWidth: 1, borderColor: Colors.border,
    width: '100%', maxWidth: 640, alignSelf: 'center',
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  sheetTitle: { color: Colors.textPrimary, fontSize: 19, fontWeight: '800', flex: 1 },
  label: { color: Colors.textPrimary, fontSize: 14, fontWeight: '700' },
  hint: { color: Colors.textMuted, fontSize: 12, marginTop: -8 },
  fixed: { color: Colors.textSecondary, fontSize: 14 },
  segment: { flexDirection: 'row', backgroundColor: Colors.bg, borderRadius: 12, padding: 4 },
  segmentBtn: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingVertical: 11, borderRadius: 9 },
  segmentOn: { backgroundColor: Colors.accent },
  segmentText: { color: Colors.textSecondary, fontWeight: '700' },
  segmentTextOn: { color: '#000' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bg },
  chipText: { color: Colors.textSecondary, fontWeight: '600', fontSize: 13 },
  chipTextOn: { color: '#fff', fontWeight: '800' },
  personOn: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  personTextOn: { color: '#000', fontWeight: '800' },
  error: { color: '#E74C3C', fontSize: 13 },
  submit: { backgroundColor: Colors.accent, borderRadius: 16, paddingVertical: 15, alignItems: 'center' },
  submitText: { color: '#000', fontWeight: '800', fontSize: 16 },
});
