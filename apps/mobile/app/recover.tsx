import React, { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Colors from '@/constants/colors';
import { MIN_PASSWORD, useAuth } from '@/context/AuthContext';
import { PasswordStrength } from '@/components/PasswordStrength';

/**
 * Forgot password: username + the recovery code saved at sign-up + a new password.
 * On success you're signed in (everywhere else is signed out) and shown a new code.
 */
export default function RecoverScreen() {
  const insets = useSafeAreaInsets();
  const { recover } = useAuth();
  const [username, setUsername] = useState('@');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError('');
    const pw = password.trim();
    if (username.trim().length < 2) return setError('Enter your username.');
    if (code.replace(/[^A-Za-z0-9]/g, '').length < 16) return setError('Enter the 16-character recovery code.');
    if (pw.length < MIN_PASSWORD) return setError(`Your new password must be at least ${MIN_PASSWORD} characters.`);
    if (pw !== confirm.trim()) return setError("The new passwords don't match.");
    setLoading(true);
    const r = await recover(username.trim(), code, pw);
    setLoading(false);
    if (!r.success) setError(r.error ?? 'Something went wrong.');
    // On success the sign-in gate takes you into the app and the new code is shown.
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[styles.body, { paddingTop: Math.max(insets.top, 16) + 8 }]} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/login'))} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Forgot your password?</Text>
        <Text style={styles.sub}>
          Use the recovery code you saved when you signed up. If you don't have it, the account can't be
          recovered, since accounts have no email.
        </Text>

        <Text style={styles.label}>Username</Text>
        <View style={styles.inputRow}>
          <Ionicons name="person" size={18} color={Colors.textMuted} />
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={t => setUsername('@' + t.replace(/@/g, ''))}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            accessibilityLabel="Username"
          />
        </View>

        <Text style={styles.label}>Recovery code</Text>
        <View style={styles.inputRow}>
          <Ionicons name="key" size={18} color={Colors.textMuted} />
          <TextInput
            style={[styles.input, styles.mono]}
            value={code}
            onChangeText={setCode}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            accessibilityLabel="Recovery code"
          />
        </View>

        <Text style={styles.label}>New password</Text>
        <View style={styles.inputRow}>
          <Ionicons name="lock-closed" size={18} color={Colors.textMuted} />
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!show}
            placeholder={`At least ${MIN_PASSWORD} characters`}
            placeholderTextColor={Colors.textMuted}
            autoComplete="new-password"
            textContentType="newPassword"
            accessibilityLabel="New password"
          />
          <TouchableOpacity onPress={() => setShow(v => !v)} accessibilityRole="button" accessibilityLabel={show ? 'Hide password' : 'Show password'}>
            <Ionicons name={show ? 'eye-off' : 'eye'} size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        </View>
        <PasswordStrength password={password.trim()} />

        <Text style={styles.label}>Confirm new password</Text>
        <View style={styles.inputRow}>
          <Ionicons name="lock-closed" size={18} color={Colors.textMuted} />
          <TextInput
            style={styles.input}
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry={!show}
            autoComplete="new-password"
            returnKeyType="done"
            onSubmitEditing={submit}
            accessibilityLabel="Confirm new password"
          />
        </View>

        {!!error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color={Colors.skip} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <TouchableOpacity style={[styles.primary, loading && { opacity: 0.7 }]} onPress={submit} disabled={loading} accessibilityRole="button">
          {loading ? <ActivityIndicator color="#000" /> : <Text style={styles.primaryText}>Reset password and sign in</Text>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  body: { padding: 24, gap: 8, maxWidth: 480, width: '100%', alignSelf: 'center' },
  title: { color: Colors.textPrimary, fontSize: 26, fontWeight: '800', marginTop: 12 },
  sub: { color: Colors.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 12 },
  label: { color: Colors.textSecondary, fontSize: 13, fontWeight: '700', marginTop: 10 },
  inputRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, height: 50,
    borderRadius: 14, backgroundColor: Colors.bgCard, borderWidth: 1, borderColor: Colors.border,
  },
  input: {
    flex: 1, color: Colors.textPrimary, fontSize: 16, height: '100%',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
  },
  mono: { letterSpacing: 1.5, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' }) },
  errorBox: {
    flexDirection: 'row', gap: 8, alignItems: 'center', padding: 12, borderRadius: 12, marginTop: 10,
    backgroundColor: 'rgba(231,76,60,0.12)',
  },
  errorText: { color: Colors.skip, fontSize: 13, flex: 1 },
  primary: { backgroundColor: Colors.accent, borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 18 },
  primaryText: { color: '#000', fontWeight: '800', fontSize: 16 },
});
