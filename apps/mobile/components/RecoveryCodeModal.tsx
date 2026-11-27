import React, { useEffect, useState } from 'react';
import { Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import Colors from '../constants/colors';
import { useAuth } from '../context/AuthContext';

/**
 * Shows a new recovery code exactly once (after sign-up, a password reset, or making a new one
 * in Profile). Accounts have no email, so this code is the only way back in after a forgotten
 * password. The server keeps only a hash of it.
 */
export function RecoveryCodeModal() {
  const { recoveryCode, dismissRecoveryCode } = useAuth();
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [recoveryCode]);
  if (!recoveryCode) return null;

  const copy = async () => {
    try { await Clipboard.setStringAsync(recoveryCode); setCopied(true); } catch {}
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Ionicons name="key" size={34} color={Colors.accent} />
          <Text style={styles.title}>Save your recovery code</Text>
          <Text style={styles.body}>
            If you ever forget your password, this code is the only way back into your account.
            Save it somewhere safe, like a password manager or a note.
          </Text>
          <Text selectable style={styles.code} accessibilityLabel={`Recovery code ${recoveryCode.split('').join(' ')}`}>
            {recoveryCode}
          </Text>
          <TouchableOpacity style={styles.copyBtn} onPress={copy} accessibilityRole="button">
            <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={16} color={Colors.textPrimary} />
            <Text style={styles.copyText}>{copied ? 'Copied' : 'Copy code'}</Text>
          </TouchableOpacity>
          <Text style={styles.small}>
            It works once. Using it gives you a new one. You can also make a new code any time in Profile.
          </Text>
          <TouchableOpacity style={styles.doneBtn} onPress={dismissRecoveryCode} accessibilityRole="button">
            <Text style={styles.doneText}>I've saved it</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', alignItems: 'center', justifyContent: 'center', padding: 22 },
  card: {
    width: '100%', maxWidth: 420, backgroundColor: Colors.bgCard, borderRadius: 22, padding: 24, gap: 12,
    alignItems: 'center', borderWidth: 1, borderColor: Colors.accent,
  },
  title: { color: Colors.textPrimary, fontSize: 20, fontWeight: '800' },
  body: { color: Colors.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  code: {
    color: Colors.accent, fontSize: 22, fontWeight: '800', letterSpacing: 2, paddingVertical: 12, paddingHorizontal: 16,
    backgroundColor: Colors.bg, borderRadius: 12, overflow: 'hidden',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' }),
  },
  copyBtn: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: Colors.border },
  copyText: { color: Colors.textPrimary, fontWeight: '700' },
  small: { color: Colors.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 17 },
  doneBtn: { backgroundColor: Colors.accent, borderRadius: 16, paddingVertical: 14, alignSelf: 'stretch', alignItems: 'center', marginTop: 4 },
  doneText: { color: '#000', fontWeight: '800', fontSize: 16 },
});
