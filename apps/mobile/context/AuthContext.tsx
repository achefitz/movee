import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, apiFetch, getToken, onUnauthorized, setToken } from '../services/api';
import { clearPendingFeedback } from '../services/recs';

export type User = {
  id: string;
  username: string;
  hasSeenTutorial: boolean;
  favoriteGenres: number[];
  /** False until the first-run questions are answered or skipped. */
  onboarded: boolean;
  /** Private accounts approve each follower. */
  isPrivate: boolean;
  /** A recovery code exists for "Forgot password?" (the code itself is never stored). */
  hasRecoveryCode?: boolean;
};

type AuthResult = { success: boolean; error?: string };

export type AuthContextType = {
  user: User | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<AuthResult>;
  signup: (username: string, password: string) => Promise<AuthResult>;
  logout: () => Promise<void>;
  markTutorialSeen: () => Promise<void>;
  completeOnboarding: (genres: number[], favoriteKeys: string[]) => Promise<AuthResult>;
  setPrivate: (isPrivate: boolean) => Promise<AuthResult>;
  /** A recovery code to show the user once (after sign-up, recovery or making a new one). */
  recoveryCode: string | null;
  dismissRecoveryCode: () => void;
  /** Forgot password: username + recovery code + new password; signs in. */
  recover: (username: string, code: string, newPassword: string) => Promise<AuthResult>;
  /** Signs out every other device. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<AuthResult>;
  /** Makes a new recovery code (the old one stops working) and shows it. */
  createRecoveryCode: (password: string) => Promise<AuthResult>;
  signOutOtherDevices: () => Promise<AuthResult>;
};

export const MIN_PASSWORD = 8;
const USERNAME_REGEX = /^@[a-zA-Z0-9_]{1,30}$/;

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Last known account, so the app opens instantly (and offline) while /me revalidates.
const USER_KEY = 'movee.user';

async function cacheUser(u: User | null) {
  try {
    if (u) await AsyncStorage.setItem(USER_KEY, JSON.stringify(u));
    else await AsyncStorage.removeItem(USER_KEY);
  } catch {}
}

const normalise = (username: string) => {
  const t = username.trim();
  return t.startsWith('@') ? t : `@${t}`;
};

const messageOf = (e: unknown) =>
  e instanceof ApiError ? e.message : "Can't reach the server. Check your connection and try again.";

// ---------------------------------------------------------------- legacy on-device accounts
// Before server accounts, usernames + a weak hash lived in AsyncStorage. On a failed login we
// check there once and, if the password matches, create the server account with it.
const LEGACY_ACCOUNTS_KEY = 'cs:accounts';

function legacyHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
    hash = hash & hash;
  }
  return hash.toString(16);
}

async function matchLegacyAccount(username: string, password: string): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(LEGACY_ACCOUNTS_KEY);
    const accounts: Array<{ username: string; passwordHash: string }> = raw ? JSON.parse(raw) : [];
    const acct = accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
    return !!acct && acct.passwordHash === legacyHash(password);
  } catch {
    return false;
  }
}

async function forgetLegacyAccount(username: string) {
  try {
    const raw = await AsyncStorage.getItem(LEGACY_ACCOUNTS_KEY);
    const accounts: Array<{ username: string }> = raw ? JSON.parse(raw) : [];
    const rest = accounts.filter(a => a.username.toLowerCase() !== username.toLowerCase());
    if (rest.length) await AsyncStorage.setItem(LEGACY_ACCOUNTS_KEY, JSON.stringify(rest));
    else await AsyncStorage.removeItem(LEGACY_ACCOUNTS_KEY);
  } catch {}
}

// ---------------------------------------------------------------- provider

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const signOutLocally = useCallback(async () => {
    await setToken(null);
    await cacheUser(null);
    await clearPendingFeedback();
    setUser(null);
  }, []);

  // Any 401 from the API means the session is gone.
  useEffect(() => onUnauthorized(() => { signOutLocally(); }), [signOutLocally]);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) {
        await cacheUser(null);
        setIsLoading(false);
        return;
      }
      let cached: User | null = null;
      try {
        const raw = await AsyncStorage.getItem(USER_KEY);
        cached = raw ? JSON.parse(raw) : null;
      } catch {}
      if (cached) {
        setUser(cached);
        setIsLoading(false);
      }
      try {
        const { user: fresh } = await apiFetch<{ user: User }>('/api/auth/me');
        setUser(fresh);
        await cacheUser(fresh);
      } catch (e) {
        // 401 already signed us out via onUnauthorized; other errors: stay on the cached account.
        if (!cached && !(e instanceof ApiError && e.status === 401)) setUser(null);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const startSession = useCallback(async (res: { token: string; user: User; recoveryCode?: string }) => {
    await setToken(res.token);
    await cacheUser(res.user);
    setUser(res.user);
    if (res.recoveryCode) setRecoveryCode(res.recoveryCode);
  }, []);

  const recover = useCallback(async (username: string, code: string, newPassword: string): Promise<AuthResult> => {
    try {
      await startSession(await apiFetch('/api/auth/recover', {
        body: { username: normalise(username), code, newPassword }, auth: false,
      }));
      return { success: true };
    } catch (e) {
      return { success: false, error: messageOf(e) };
    }
  }, [startSession]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string): Promise<AuthResult> => {
    try {
      await apiFetch('/api/auth/password', { body: { currentPassword, newPassword } });
      return { success: true };
    } catch (e) {
      return { success: false, error: messageOf(e) };
    }
  }, []);

  const createRecoveryCode = useCallback(async (password: string): Promise<AuthResult> => {
    try {
      const r = await apiFetch<{ recoveryCode: string; user: User }>('/api/auth/recovery-code', { body: { password } });
      setUser(r.user);
      await cacheUser(r.user);
      setRecoveryCode(r.recoveryCode);
      return { success: true };
    } catch (e) {
      return { success: false, error: messageOf(e) };
    }
  }, []);

  const signOutOtherDevices = useCallback(async (): Promise<AuthResult> => {
    try {
      await apiFetch('/api/auth/logout-others', { body: {} });
      return { success: true };
    } catch (e) {
      return { success: false, error: messageOf(e) };
    }
  }, []);

  const signup = useCallback(async (username: string, password: string): Promise<AuthResult> => {
    const name = normalise(username);
    if (!USERNAME_REGEX.test(name)) {
      return { success: false, error: 'Username can only contain letters, numbers, and underscores (max 30).' };
    }
    if (password.length < MIN_PASSWORD) {
      return { success: false, error: `Password must be at least ${MIN_PASSWORD} characters.` };
    }
    try {
      await startSession(await apiFetch('/api/auth/signup', { body: { username: name, password }, auth: false }));
      await forgetLegacyAccount(name);
      return { success: true };
    } catch (e) {
      return { success: false, error: messageOf(e) };
    }
  }, [startSession]);

  const login = useCallback(async (username: string, password: string): Promise<AuthResult> => {
    const name = normalise(username);
    try {
      await startSession(await apiFetch('/api/auth/login', { body: { username: name, password }, auth: false }));
      await forgetLegacyAccount(name);
      return { success: true };
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && await matchLegacyAccount(name, password)) {
        if (password.length < MIN_PASSWORD) {
          return {
            success: false,
            error: `Accounts now live on our server and need a password of at least ${MIN_PASSWORD} characters. Tap "Sign up" and create ${name} again with a longer password — your swipes on this phone carry over.`,
          };
        }
        const moved = await signup(name, password);
        if (moved.success) return moved;
      }
      return { success: false, error: messageOf(e) };
    }
  }, [startSession, signup]);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    await signOutLocally();
  }, [signOutLocally]);

  const markTutorialSeen = useCallback(async () => {
    if (!user) return;
    const updated = { ...user, hasSeenTutorial: true };
    setUser(updated);
    await cacheUser(updated);
    try {
      await apiFetch('/api/auth/me', { method: 'PATCH', body: { hasSeenTutorial: true } });
    } catch {}
  }, [user]);

  const completeOnboarding = useCallback(async (genres: number[], favoriteKeys: string[]): Promise<AuthResult> => {
    try {
      const { user: updated } = await apiFetch<{ user: User }>('/api/onboarding', { body: { genres, favorites: favoriteKeys } });
      setUser(updated);
      await cacheUser(updated);
      return { success: true };
    } catch (e) {
      return { success: false, error: messageOf(e) };
    }
  }, []);

  const setPrivate = useCallback(async (isPrivate: boolean): Promise<AuthResult> => {
    try {
      const { user: updated } = await apiFetch<{ user: User }>('/api/auth/me', { method: 'PATCH', body: { isPrivate } });
      setUser(updated);
      await cacheUser(updated);
      return { success: true };
    } catch (e) {
      return { success: false, error: messageOf(e) };
    }
  }, []);

  return (
    <AuthContext.Provider value={{
      user, isLoading, login, signup, logout, markTutorialSeen, completeOnboarding, setPrivate,
      recoveryCode, dismissRecoveryCode: () => setRecoveryCode(null),
      recover, changePassword, createRecoveryCode, signOutOtherDevices,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
