import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type User = {
  username: string;
  hasSeenTutorial: boolean;
};

export type AuthContextType = {
  user: User | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signup: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  markTutorialSeen: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const ACCOUNTS_KEY = 'cs:accounts';
const SESSION_KEY = 'cs:session';

type StoredAccount = {
  username: string;
  passwordHash: string;
  hasSeenTutorial: boolean;
};

function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
    hash = hash & hash;
  }
  return hash.toString(16);
}

const USERNAME_REGEX = /^@[a-zA-Z0-9_]+$/;

async function loadAccounts(): Promise<StoredAccount[]> {
  try {
    const raw = await AsyncStorage.getItem(ACCOUNTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveAccounts(accounts: StoredAccount[]) {
  try {
    await AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {}
}

async function loadSession(): Promise<User | null> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function saveSession(user: User | null) {
  try {
    if (user) {
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(user));
    } else {
      await AsyncStorage.removeItem(SESSION_KEY);
    }
  } catch {}
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const session = await loadSession();
      setUser(session);
      setIsLoading(false);
    })();
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<{ success: boolean; error?: string }> => {
    const normalizedUsername = username.startsWith('@') ? username : `@${username}`;
    const accounts = await loadAccounts();
    const account = accounts.find(a => a.username.toLowerCase() === normalizedUsername.toLowerCase());
    if (!account) {
      return { success: false, error: 'No account found with that username.' };
    }
    if (account.passwordHash !== simpleHash(password)) {
      return { success: false, error: 'Incorrect password.' };
    }
    const sessionUser: User = {
      username: account.username,
      hasSeenTutorial: account.hasSeenTutorial ?? true,
    };
    await saveSession(sessionUser);
    setUser(sessionUser);
    return { success: true };
  }, []);

  const signup = useCallback(async (username: string, password: string): Promise<{ success: boolean; error?: string }> => {
    const normalizedUsername = username.startsWith('@') ? username : `@${username}`;
    if (normalizedUsername.length < 2) {
      return { success: false, error: 'Username must be at least 1 character after @.' };
    }
    if (!USERNAME_REGEX.test(normalizedUsername)) {
      return { success: false, error: 'Username can only contain letters, numbers, and underscores.' };
    }
    if (password.length < 6) {
      return { success: false, error: 'Password must be at least 6 characters.' };
    }
    const accounts = await loadAccounts();
    const exists = accounts.find(a => a.username.toLowerCase() === normalizedUsername.toLowerCase());
    if (exists) {
      return { success: false, error: 'That username is already taken.' };
    }
    const newAccount: StoredAccount = {
      username: normalizedUsername,
      passwordHash: simpleHash(password),
      hasSeenTutorial: false,
    };
    await saveAccounts([...accounts, newAccount]);
    const sessionUser: User = { username: normalizedUsername, hasSeenTutorial: false };
    await saveSession(sessionUser);
    setUser(sessionUser);
    return { success: true };
  }, []);

  const logout = useCallback(async () => {
    await saveSession(null);
    setUser(null);
  }, []);

  const markTutorialSeen = useCallback(async () => {
    if (!user) return;
    const updated = { ...user, hasSeenTutorial: true };
    await saveSession(updated);
    setUser(updated);
    const accounts = await loadAccounts();
    const updatedAccounts = accounts.map(a =>
      a.username.toLowerCase() === user.username.toLowerCase()
        ? { ...a, hasSeenTutorial: true }
        : a
    );
    await saveAccounts(updatedAccounts);
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
