import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL } from '../constants/api';
import type { Filters } from '../context/AppContext';
import type { MediaItem } from './tmdb';

export type SwipeAction = 'like' | 'skip' | 'seen' | 'seen_up' | 'seen_meh' | 'seen_down';

export function getRecsBase(): string {
  return API_URL + '/api/recs';
}

export const keyOf = (item: Pick<MediaItem, 'type' | 'id'>) => `${item.type}:${item.id}`;

/** Logged-in username, or a random per-device id for guests. */
export async function getRecsUserId(username?: string): Promise<string> {
  if (username) return username;
  const k = 'cs:deviceId';
  try {
    const existing = await AsyncStorage.getItem(k);
    if (existing) return existing;
    const id = 'guest:' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    await AsyncStorage.setItem(k, id);
    return id;
  } catch {
    return 'guest:anonymous';
  }
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(getRecsBase() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`recs ${path} ${res.status}`);
  return res.json();
}

export async function fetchDeck(
  userId: string,
  filters: Filters,
  exclude: string[],
  limit = 20,
  signal?: AbortSignal,
): Promise<MediaItem[]> {
  const { items } = await post<{ items: MediaItem[] }>('/deck', {
    userId,
    filters: {
      contentType: filters.contentType,
      genres: filters.genres,
      streaming: filters.streaming,
      era: filters.era,
      minRating: filters.minRating,
      maxRuntime: filters.maxRuntime,
      inTheaters: filters.inTheaters,
    },
    exclude: exclude.slice(-300),
    limit,
  }, signal);
  return items;
}

// ---------------------------------------------------------------- feedback queue
// Swipes must not be lost on a flaky connection: queue, persist, retry.

type Pending =
  | { kind: 'feedback'; userId: string; key: string; action: SwipeAction; impressionId?: string | null }
  | { kind: 'undo'; userId: string; key: string };

const QUEUE_KEY = 'cs:recsQueue';
let queue: Pending[] = [];
let flushing = false;

// Every queue mutation chains on this one promise, so the persisted queue is
// always restored first and swipes keep their order.
const ready: Promise<void> = AsyncStorage.getItem(QUEUE_KEY)
  .then(raw => { if (raw) queue = JSON.parse(raw); })
  .catch(() => {});

function persist() {
  AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-500))).catch(() => {});
}

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    await ready;
    while (queue.length > 0) {
      const next = queue[0];
      try {
        if (next.kind === 'feedback') {
          await post('/feedback', { userId: next.userId, key: next.key, action: next.action, impressionId: next.impressionId ?? null });
        } else {
          await post('/undo', { userId: next.userId, key: next.key });
        }
        queue.shift();
        persist();
      } catch {
        setTimeout(flush, 5000); // offline / server down — retry later
        return;
      }
    }
  } finally {
    flushing = false;
  }
}

function enqueue(p: Pending) {
  ready.then(() => {
    queue.push(p);
    persist();
    flush();
  });
}

export function sendFeedback(userId: string, item: MediaItem, action: SwipeAction) {
  enqueue({ kind: 'feedback', userId, key: keyOf(item), action, impressionId: item.impressionId ?? null });
}

export function sendUndo(userId: string, item: MediaItem) {
  enqueue({ kind: 'undo', userId, key: keyOf(item) });
}

/**
 * One-time upload of swipes made before the recommender existed, so long-time
 * users don't start from scratch.
 */
export async function syncHistoryOnce(
  userId: string,
  liked: MediaItem[],
  skipped: MediaItem[],
  watched: MediaItem[],
  ratings: Record<number, 'up' | 'meh' | 'down'>,
): Promise<void> {
  const flag = `cs:recsSynced:${userId}`;
  try {
    if (await AsyncStorage.getItem(flag)) return;
    const entries = [
      ...skipped.map(i => ({ key: keyOf(i), action: 'skip' as SwipeAction })),
      ...liked.map(i => ({ key: keyOf(i), action: 'like' as SwipeAction })),
      ...watched.map(i => ({
        key: keyOf(i),
        action: (ratings[i.id] ? `seen_${ratings[i.id]}` : 'seen') as SwipeAction,
      })),
    ];
    if (entries.length > 0) await post('/sync', { userId, entries: entries.slice(-3000) });
    await AsyncStorage.setItem(flag, '1');
  } catch {
    // Not fatal: the next launch will try again.
  }
}

flush();
