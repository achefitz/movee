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
        ageRatings: filters.ageRatings ?? [],
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
  | { kind: 'feedback'; key: string; action: SwipeAction; impressionId?: string | null; source?: 'deck' | 'search' }
  | { kind: 'undo'; key: string }
  | { kind: 'hide'; key: string }
  | { kind: 'rate'; key: string; rating?: 'up' | 'meh' | 'down'; stars?: number | null };

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
          await apiFetch('/api/recs/feedback', {
            body: { key: next.key, action: next.action, impressionId: next.impressionId ?? null, source: next.source ?? 'deck' },
          });
        } else if (next.kind === 'rate') {
          await apiFetch('/api/recs/rate', { body: { key: next.key, rating: next.rating, stars: next.stars } });
        } else if (next.kind === 'hide') {
          await apiFetch('/api/recs/hide', { body: { key: next.key } });
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

/** A title added from the Search tab: the server weighs these more when learning your taste. */
export function sendSearchFeedback(item: MediaItem, action: 'like' | 'seen') {
  enqueue({ kind: 'feedback', key: keyOf(item), action, source: 'search' });
}

export type SearchResult = MediaItem & { myStatus: 'saved' | 'watched' | null };

export async function searchTitles(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const { items } = await apiFetch<{ items: SearchResult[] }>(`/api/recs/search?q=${encodeURIComponent(query)}`, { signal });
  return items;
}

/** Opening a search result is a light interest signal for recommendations. Best effort. */
export function logSearchClick(item: MediaItem, query: string) {
  apiFetch('/api/recs/search/click', { body: { key: keyOf(item), query: query.slice(0, 100) } }).catch(() => {});
}

export function sendUndo(item: MediaItem) {
  enqueue({ kind: 'undo', key: keyOf(item) });
}

/** Removed from the Watchlist / Watched list: hidden on every device, still counts for recommendations. */
export function sendHide(item: Pick<MediaItem, 'type' | 'id'>) {
  enqueue({ kind: 'hide', key: keyOf(item) });
}

/** Change a watched title's thumbs rating or 1–5 stars (from the Watchlist). */
export function sendRating(item: Pick<MediaItem, 'type' | 'id'>, r: { rating?: 'up' | 'meh' | 'down'; stars?: number | null }) {
  enqueue({ kind: 'rate', key: keyOf(item), ...r });
}

export type Library = {
  liked: Array<MediaItem & { at: number }>;
  watched: Array<MediaItem & { at: number; myRating: 'up' | 'meh' | 'down' | null; myStars: number | null }>;
  /** Every title the server has a swipe for (including removed ones). */
  known: string[];
};

/**
 * The account's saved and watched lists as the server has them, plus the keys of
 * changes still waiting in this device's queue (so they aren't overwritten).
 */
export async function fetchLibrary(): Promise<{ lib: Library; pending: Set<string>; pendingHides: Set<string> }> {
  const lib = await apiFetch<Library>('/api/recs/library');
  await ready;
  return {
    lib,
    pending: new Set(queue.map(p => p.key)),
    pendingHides: new Set(queue.filter(p => p.kind === 'hide').map(p => p.key)),
  };
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
