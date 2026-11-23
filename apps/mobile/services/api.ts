import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { API_URL } from '../constants/api';

const TOKEN_KEY = 'movee.session';

// Keychain / Keystore on phones; the browser has no secure store, so web uses localStorage.
const secure = Platform.OS !== 'web';

let token: string | null = null;
let loaded: Promise<void> | null = null;

function loadToken(): Promise<void> {
  loaded ??= (secure ? SecureStore.getItemAsync(TOKEN_KEY) : AsyncStorage.getItem(TOKEN_KEY))
    .then(t => { token = t; })
    .catch(() => { token = null; });
  return loaded;
}

export async function getToken(): Promise<string | null> {
  await loadToken();
  return token;
}

export async function setToken(t: string | null): Promise<void> {
  await loadToken();
  token = t;
  try {
    if (t) await (secure ? SecureStore.setItemAsync(TOKEN_KEY, t) : AsyncStorage.setItem(TOKEN_KEY, t));
    else await (secure ? SecureStore.deleteItemAsync(TOKEN_KEY) : AsyncStorage.removeItem(TOKEN_KEY));
  } catch {}
}

// AuthContext subscribes so an expired session anywhere sends the user back to login.
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** fetch() against the Movee API with the session token attached. Throws ApiError on non-2xx. */
export async function apiFetch<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Cache-Control': 'no-cache' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const t = init.auth === false ? null : await getToken();
  if (t) headers.Authorization = `Bearer ${t}`;

  const res = await fetch(API_URL + path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && t) unauthorizedListeners.forEach(fn => fn());
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  }
  return data as T;
}
