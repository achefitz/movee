import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../constants/colors';
import { STREAMING_FILTER_LIST, SVC } from '../constants/streaming';
import { useAppContext } from '../context/AppContext';
import { ApiError } from '../services/api';
import {
  acceptParty, declineParty, inviteToParty, leaveParty, listParties, type PartySummary,
} from '../services/parties';
import { confirmAction } from '../utils/confirm';

const POLL_MS = 6000;

export type WatchPartiesHandle = { invite: (username: string) => void };

type Setup =
  | { mode: 'invite'; username: string }
  | { mode: 'accept'; party: PartySummary };

/**
 * The Social tab's watch party section: invites to answer, invites you sent, parties in
 * progress and finished ones. Polls while the tab is open (there are no push notifications).
 * `invite(username)` opens the setup sheet: Movies or TV, then streaming services.
 */
export const WatchParties = forwardRef<WatchPartiesHandle>(function WatchParties(_props, ref) {
  const { filters } = useAppContext();
  const [parties, setParties] = useState<PartySummary[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try { setParties(await listParties()); } catch { /* keep what we have */ }
  }, []);

  useFocusEffect(useCallback(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]));

  useImperativeHandle(ref, () => ({ invite: (username: string) => setSetup({ mode: 'invite', username }) }), []);

  const cancel = (p: PartySummary) => {
    const what = p.status === 'pending' ? 'Cancel this invite?' : `Leave the watch party with ${p.with}?`;
    confirmAction('Watch party', what, p.status === 'pending' ? 'Cancel invite' : 'Leave', async () => {
      setBusyId(p.id);
      try { await leaveParty(p.id); } catch {}
      await refresh();
      setBusyId(null);
    });
  };

  const decline = async (p: PartySummary) => {
    setBusyId(p.id);
    try { await declineParty(p.id); } catch {}
    await refresh();
    setBusyId(null);
  };

  const invites = parties.filter(p => p.status === 'pending' && p.role === 'guest');
  const sent = parties.filter(p => p.status === 'pending' && p.role === 'host');
  const running = parties.filter(p => p.status === 'active' || p.status === 'done');
  const kind = (p: PartySummary) => (p.mediaType === 'movie' ? 'Movies' : 'TV shows');

  return (
    <>
      {parties.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Watch parties</Text>

          {invites.map(p => (
            <View key={p.id} style={[styles.card, styles.inviteCard]}>
              <View style={styles.cardText}>
                <Text style={styles.cardTitle}>🎉 {p.with} invited you</Text>
                <Text style={styles.cardSub}>{kind(p)} · {serviceNames(p.providers)}</Text>
              </View>
              <View style={styles.cardActions}>
                <TouchableOpacity
                  style={styles.ghostBtn}
                  onPress={() => decline(p)}
                  disabled={busyId === p.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Decline ${p.with}'s watch party`}
                >
                  <Text style={styles.ghostText}>Decline</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.goldBtn}
                  onPress={() => setSetup({ mode: 'accept', party: p })}
                  accessibilityRole="button"
                  accessibilityLabel={`Accept ${p.with}'s watch party`}
                >
                  <Text style={styles.goldText}>Accept</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}

          {sent.map(p => (
            <View key={p.id} style={styles.card}>
              <View style={styles.cardText}>
                <Text style={styles.cardTitle}>Waiting for {p.with}</Text>
                <Text style={styles.cardSub}>{kind(p)} · {serviceNames(p.providers)}</Text>
              </View>
              <TouchableOpacity style={styles.ghostBtn} onPress={() => cancel(p)} accessibilityRole="button" accessibilityLabel="Cancel invite">
                <Text style={styles.ghostText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ))}

          {running.map(p => {
            const iDone = p.myProgress >= p.size;
            const label = p.status === 'done' || iDone
              ? `${p.matches.length} match${p.matches.length === 1 ? '' : 'es'}`
              : p.myProgress === 0 ? 'Start swiping' : 'Keep swiping';
            return (
              <TouchableOpacity
                key={p.id}
                style={styles.card}
                onPress={() => router.push({ pathname: '/party/[id]', params: { id: p.id } })}
                onLongPress={() => cancel(p)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={`Watch party with ${p.with}`}
              >
                <View style={styles.cardText}>
                  <Text style={styles.cardTitle}>🍿 With {p.with}</Text>
                  <Text style={styles.cardSub}>
                    {kind(p)} · you {p.myProgress}/{p.size} · {p.with} {p.theirProgress}/{p.size}
                  </Text>
                </View>
                <View style={[styles.pill, (p.status === 'done' || iDone) && styles.pillDone]}>
                  <Text style={[styles.pillText, (p.status === 'done' || iDone) && styles.pillTextDone]}>{label}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      <PartySetupSheet
        setup={setup}
        myServices={filters.streaming ?? []}
        onClose={() => setSetup(null)}
        onDone={async (party) => {
          setSetup(null);
          await refresh();
          if (party.status === 'active') router.push({ pathname: '/party/[id]', params: { id: party.id } });
        }}
      />
    </>
  );
});

function serviceNames(ids: number[]) {
  const names = ids.map(id => SVC[id]?.name).filter(Boolean);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ') || 'Any service';
}

/** Movies or TV (host only), then streaming services, then send / accept. */
function PartySetupSheet({ setup, myServices, onClose, onDone }: {
  setup: Setup | null;
  myServices: number[];
  onClose: () => void;
  onDone: (p: PartySummary) => void;
}) {
  const [mediaType, setMediaType] = useState<'movie' | 'tv'>('movie');
  const [services, setServices] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!setup) return;
    setError(''); setBusy(false);
    if (setup.mode === 'invite') {
      setMediaType('movie');
      setServices(myServices);
    } else {
      setMediaType(setup.party.mediaType);
      setServices([...new Set([...setup.party.providers, ...myServices])]);
    }
  }, [setup, myServices]);

  if (!setup) return null;
  const hostServices = setup.mode === 'accept' ? setup.party.providers : [];
  const toggle = (id: number) => {
    if (hostServices.includes(id)) return; // the host's picks stay in
    setServices(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));
  };

  const submit = async () => {
    if (services.length === 0) { setError('Pick at least one streaming service.'); return; }
    setBusy(true); setError('');
    try {
      const party = setup.mode === 'invite'
        ? await inviteToParty(setup.username, mediaType, services)
        : await acceptParty(setup.party.id, services);
      onDone(party);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't reach the server. Try again.");
      setBusy(false);
    }
  };

  const who = setup.mode === 'invite' ? setup.username : setup.party.with;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>
              {setup.mode === 'invite' ? `Watch party with ${who}` : `Join ${who}'s watch party`}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={24} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ gap: 14, paddingBottom: 8 }}>
            <Text style={styles.label}>What are you watching?</Text>
            {setup.mode === 'invite' ? (
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
              <Text style={styles.fixed}>{mediaType === 'movie' ? 'Movies' : 'TV shows'} (picked by {who})</Text>
            )}

            <Text style={styles.label}>Streaming services</Text>
            <Text style={styles.hint}>
              {setup.mode === 'invite'
                ? "Only titles on these services will show up. Your friend can add theirs when they accept."
                : `${who}'s picks are included; add any you have.`}
            </Text>
            <View style={styles.chips}>
              {STREAMING_FILTER_LIST.map(s => {
                const on = services.includes(s.id);
                const locked = hostServices.includes(s.id);
                return (
                  <TouchableOpacity
                    key={s.id}
                    style={[styles.chip, on && { backgroundColor: SVC[s.id]?.color ?? Colors.accent, borderColor: 'transparent' }]}
                    onPress={() => toggle(s.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on, disabled: locked }}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{s.name}{locked ? ' ✓' : ''}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {!!error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>
          <TouchableOpacity style={[styles.submit, busy && { opacity: 0.7 }]} onPress={submit} disabled={busy} accessibilityRole="button">
            {busy ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <ActivityIndicator color="#000" />
                {setup.mode === 'accept' && <Text style={styles.submitText}>Picking 30 titles for you both…</Text>}
              </View>
            ) : (
              <Text style={styles.submitText}>{setup.mode === 'invite' ? 'Send invite' : 'Start swiping'}</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  section: { marginHorizontal: 16, marginBottom: 24 },
  sectionTitle: { color: Colors.textPrimary, fontSize: 16, fontWeight: '700', marginBottom: 10 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, marginBottom: 8,
    borderRadius: 14, backgroundColor: Colors.bgCard, borderWidth: 1, borderColor: Colors.border,
  },
  inviteCard: { borderColor: Colors.accent, flexDirection: 'column', alignItems: 'stretch' },
  cardText: { flex: 1, minWidth: 0, gap: 3 },
  cardTitle: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  cardSub: { color: Colors.textSecondary, fontSize: 12 },
  cardActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 6 },
  goldBtn: { backgroundColor: Colors.accent, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 18 },
  goldText: { color: '#000', fontWeight: '800', fontSize: 14 },
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
  error: { color: '#E74C3C', fontSize: 13 },
  submit: { backgroundColor: Colors.accent, borderRadius: 16, paddingVertical: 15, alignItems: 'center' },
  submitText: { color: '#000', fontWeight: '800', fontSize: 16 },
});
