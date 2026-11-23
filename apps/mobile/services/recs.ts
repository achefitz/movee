import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Filters } from '../context/AppContext';
import { ApiError, apiFetch, getToken } from './api';
import type { MediaItem } from './tmdb';

export type SwipeAction = 'like' | 'skip' | 'seen' | 'seen_up' | 'seen_meh' | 'seen_down';

export const keyOf = (item: Pick<MediaItem, 'type' | 'id'>) => `${item.type}:${item.id}`;

/** The recommender acts on the signed-in account (from the session token); no user id is sent. */
export async function fetchDeck(
  filters: Filters,
  exclude: string[],
  limit = 20,
  signal?: AbortSignal,
): Promise<MediaItem[]> {
  const { items } = await apiFetch<{ items: MediaItem[] }>('/api/recs/deck', {
    body: {
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
    },
    signal,
  });
  return items;
}

// ---------------------------------------------------------------- feedback queue
// Swipes must not be lost on a flaky connection: queue, persist, retry.
// The queue belongs to the signed-in account and is cleared on logout.

type Pending =
  | { kind: 'feedback'; key: string; action: SwipeAction; impressionId?: string | null }
  | { kind: 'undo'; key: string };

const QUEUE_KEY = 'movee.recsQueue';
let queue: Pending[] = [];
let flushing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (!(await getToken())) return; // signed out: nothing to send to
    while (queue.length > 0) {
      const next = queue[0];
      try {
        if (next.kind === 'feedback') {
          await apiFetch('/api/recs/feedback', { body: { key: next.key, action: next.action, impressionId: next.impressionId ?? null } });
        } else {
          await apiFetch('/api/recs/undo', { body: { key: next.key } });
        }
        queue.shift();
        persist();
      } catch (e) {
        if (e instanceof ApiError && e.status === 400) {
          queue.shift(); // malformed entry; drop it rather than block the queue
          persist();
          continue;
        }
        if (e instanceof ApiError && e.status === 401) return; // logout clears the queue
        retryTimer ??= setTimeout(() => { retryTimer = null; flush(); }, 5000); // offline / server down
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

export function sendFeedback(item: MediaItem, action: SwipeAction) {
  enqueue({ kind: 'feedback', key: keyOf(item), action, impressionId: item.impressionId ?? null });
}

export function sendUndo(item: MediaItem) {
  enqueue({ kind: 'undo', key: keyOf(item) });
}

/** Called on logout so one account's queued swipes are never sent as another's. */
export async function clearPendingFeedback(): Promise<void> {
  await ready;
  queue = [];
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  persist();
}

/**
 * One-time upload of swipes kept on this phone from before server accounts,
 * so long-time users don't start from scratch.
 */
export async function syncHistoryOnce(
  accountId: string,
  liked: MediaItem[],
  skipped: MediaItem[],
  watched: MediaItem[],
  ratings: Record<number, 'up' | 'meh' | 'down'>,
): Promise<void> {
  const flag = `movee.recsSynced:${accountId}`;
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
    if (entries.length > 0) await apiFetch('/api/recs/sync', { body: { entries: entries.slice(-3000) } });
    await AsyncStorage.setItem(flag, '1');
  } catch {
    // Not fatal: the next launch will try again.
  }
}

flush();
