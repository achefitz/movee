import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Colors from '../constants/colors';

/**
 * Rough, local strength estimate to guide people while typing. The server has the final word
 * (it also refuses common and breached passwords).
 */
export function passwordScore(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (pw.length < 8) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  const words = pw.trim().split(/[\s\-_.]+/).filter(w => w.length >= 3).length;
  let s = 1;
  if (pw.length >= 12) s++;
  if (pw.length >= 16 || words >= 3) s++;
  if (classes >= 3) s++;
  if (/^(.)\1+$/.test(pw) || /^(?:0123|1234|abcd|qwer|pass)/i.test(pw)) s = 1;
  return Math.min(4, s) as 1 | 2 | 3 | 4;
}

const LABELS = ['Too short', 'Weak', 'Okay', 'Strong', 'Very strong'];
const COLORS = ['#E74C3C', '#E74C3C', '#F5C518', '#2ECC71', '#2ECC71'];

export function PasswordStrength({ password }: { password: string }) {
  if (!password) {
    return <Text style={styles.tip}>Tip: three or four random words (like "velvet otter cactus") are strong and easy to remember.</Text>;
  }
  const s = passwordScore(password);
  return (
    <View style={styles.wrap} accessibilityLabel={`Password strength: ${LABELS[s]}`}>
      <View style={styles.bars}>
        {[1, 2, 3, 4].map(i => (
          <View key={i} style={[styles.bar, { backgroundColor: i <= s ? COLORS[s] : Colors.border }]} />
        ))}
      </View>
      <Text style={[styles.label, { color: COLORS[s] }]}>{LABELS[s]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  bars: { flex: 1, flexDirection: 'row', gap: 4 },
  bar: { flex: 1, height: 4, borderRadius: 2 },
  label: { fontSize: 12, fontWeight: '700', minWidth: 76, textAlign: 'right' },
  tip: { color: Colors.textMuted, fontSize: 12, marginTop: 8, lineHeight: 17 },
});
