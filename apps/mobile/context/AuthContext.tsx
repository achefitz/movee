import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, apiFetch, getToken, onUnauthorized, setToken } from '../services/api';
import { clearPendingFeedback } from '../services/recs';

export type User = {
  id: string;
  username: string;
  hasSeenTutorial: boolean;
};

type AuthResult = { success: boolean; error?: string };

export type AuthContextType = {
  user: User | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<AuthResult>;
  signup: (username: string, password: string) => Promise<AuthResult>;
  logout: () => Promise<void>;
  markTutorialSeen: () => Promise<void>;
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

  const startSession = useCallback(async (res: { token: string; user: User }) => {
    await setToken(res.token);
    await cacheUser(res.user);
    setUser(res.user);
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

  return (
    <AuthContext.Provider value={{ user, isLoading, login, signup, logout, markTutorialSeen }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
