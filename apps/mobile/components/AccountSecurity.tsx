import React, { useState } from 'react';
import { ActivityIndicator, Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../constants/colors';
import { MIN_PASSWORD, useAuth } from '../context/AuthContext';
import { confirmAction } from '../utils/confirm';
import { PasswordStrength } from './PasswordStrength';

type Sheet = 'password' | 'code' | null;

/** Profile → Account & security: change password, recovery code, sign out other devices. */
export function AccountSecurity() {
  const { user, signOutOtherDevices } = useAuth();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [note, setNote] = useState('');

  const signOutOthers = () =>
    confirmAction('Sign out other devices', 'Sign out everywhere except this device?', 'Sign out', async () => {
      const r = await signOutOtherDevices();
      setNote(r.success ? 'Signed out of every other device.' : r.error ?? 'Try again.');
    });

  const rows: Array<{ icon: keyof typeof Ionicons.glyphMap; title: string; sub: string; warn?: boolean; onPress: () => void }> = [
    { icon: 'key-outline', title: 'Change password', sub: 'Signs you out on your other devices', onPress: () => setSheet('password') },
    {
      icon: 'shield-checkmark-outline',
      title: user?.hasRecoveryCode ? 'Make a new recovery code' : 'Create a recovery code',
      sub: user?.hasRecoveryCode
        ? "You have one. Make a new one if you've lost it (the old one stops working)."
        : "You don't have one yet: without it, a forgotten password means a lost account.",
      warn: !user?.hasRecoveryCode,
      onPress: () => setSheet('code'),
    },
    { icon: 'phone-portrait-outline', title: 'Sign out of other devices', sub: 'Everywhere except this one', onPress: signOutOthers },
  ];

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Account & security</Text>
      {rows.map((r, i) => (
        <TouchableOpacity key={r.title} style={[styles.row, i > 0 && styles.rowBorder]} onPress={r.onPress} accessibilityRole="button">
          <View style={[styles.icon, r.warn && styles.iconWarn]}>
            <Ionicons name={r.icon} size={19} color={r.warn ? '#E67E22' : Colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{r.title}</Text>
            <Text style={[styles.sub, r.warn && { color: '#E67E22' }]}>{r.sub}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
        </TouchableOpacity>
      ))}
      {!!note && <Text style={styles.note}>{note}</Text>}
      {sheet && <PasswordSheet mode={sheet} onClose={() => setSheet(null)} onDone={msg => { setSheet(null); setNote(msg); }} />}
    </View>
  );
}

function PasswordSheet({ mode, onClose, onDone }: { mode: 'password' | 'code'; onClose: () => void; onDone: (msg: string) => void }) {
  const { changePassword, createRecoveryCode } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    if (!current.trim()) return setError(mode === 'password' ? 'Enter your current password.' : 'Enter your password.');
    if (mode === 'password') {
      if (next.trim().length < MIN_PASSWORD) return setError(`Your new password must be at least ${MIN_PASSWORD} characters.`);
      if (next.trim() !== confirm.trim()) return setError("The new passwords don't match.");
    }
    setBusy(true);
    const r = mode === 'password'
      ? await changePassword(current.trim(), next.trim())
      : await createRecoveryCode(current.trim());
    setBusy(false);
    if (!r.success) return setError(r.error ?? 'Something went wrong.');
    onDone(mode === 'password' ? 'Password changed. Your other devices were signed out.' : 'New recovery code created.');
  };

  const field = (label: string, value: string, set: (v: string) => void, autoComplete: 'current-password' | 'new-password', last = false) => (
    <>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={set}
          secureTextEntry={!show}
          autoComplete={autoComplete}
          autoCapitalize="none"
          returnKeyType={last ? 'done' : 'next'}
          onSubmitEditing={last ? submit : undefined}
          accessibilityLabel={label}
        />
      </View>
    </>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>{mode === 'password' ? 'Change password' : 'Recovery code'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={24} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
          {mode === 'code' && (
            <Text style={styles.sub}>
              Enter your password to make a new recovery code. It's shown once; any older code stops working.
            </Text>
          )}
          {field(mode === 'password' ? 'Current password' : 'Password', current, setCurrent, 'current-password', mode === 'code')}
          {mode === 'password' && (
            <>
              {field('New password', next, setNext, 'new-password')}
              <PasswordStrength password={next.trim()} />
              {field('Confirm new password', confirm, setConfirm, 'new-password', true)}
            </>
          )}
          <TouchableOpacity onPress={() => setShow(v => !v)} style={styles.showBtn} accessibilityRole="button">
            <Ionicons name={show ? 'eye-off' : 'eye'} size={16} color={Colors.textMuted} />
            <Text style={styles.showText}>{show ? 'Hide passwords' : 'Show passwords'}</Text>
          </TouchableOpacity>
          {!!error && <Text style={styles.error}>{error}</Text>}
          <TouchableOpacity style={[styles.primary, busy && { opacity: 0.7 }]} onPress={submit} disabled={busy} accessibilityRole="button">
            {busy ? <ActivityIndicator color="#000" /> : (
              <Text style={styles.primaryText}>{mode === 'password' ? 'Change password' : 'Make a new code'}</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: Colors.bgCard, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, paddingVertical: 6 },
  heading: { color: Colors.textPrimary, fontSize: 16, fontWeight: '700', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(245,197,24,0.12)' },
  iconWarn: { backgroundColor: 'rgba(230,126,34,0.15)' },
  title: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  sub: { color: Colors.textMuted, fontSize: 12, marginTop: 2, lineHeight: 17 },
  note: { color: '#2ECC71', fontSize: 13, paddingHorizontal: 16, paddingBottom: 10 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.bgCard, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 22, paddingBottom: 32,
    gap: 6, borderTopWidth: 1, borderColor: Colors.border, width: '100%', maxWidth: 560, alignSelf: 'center',
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  sheetTitle: { color: Colors.textPrimary, fontSize: 19, fontWeight: '800' },
  label: { color: Colors.textSecondary, fontSize: 13, fontWeight: '700', marginTop: 8 },
  inputRow: { height: 48, borderRadius: 12, backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 12, justifyContent: 'center' },
  input: { color: Colors.textPrimary, fontSize: 16, height: '100%', ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) },
  showBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 8 },
  showText: { color: Colors.textMuted, fontSize: 13 },
  error: { color: '#E74C3C', fontSize: 13, marginTop: 4 },
  primary: { backgroundColor: Colors.accent, borderRadius: 16, paddingVertical: 15, alignItems: 'center', marginTop: 10 },
  primaryText: { color: '#000', fontWeight: '800', fontSize: 16 },
});
