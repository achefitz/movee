import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MediaItem } from '../services/tmdb';

export type Era = 'all' | 'new' | 'classic';

export type Filters = {
  contentType: 'all' | 'movie' | 'tv';
  /** 'new' = released in the last 2 years, 'classic' = released before 2000. */
  era: Era;
  genres: number[];
  minRating: number;
  /** US age ratings to allow (G, PG, PG-13, R, NC-17; TV shows use the matching TV rating). Empty = any. */
  ageRatings: string[];
  streaming: number[];
  inTheaters: boolean;
  maxRuntime: number | null;
};

export type ActivityEvent = {
  item: MediaItem;
  action: 'liked' | 'watched';
  timestamp: number;
};

export type AppContextType = {
  profileName: string;
  setProfileName: (name: string) => Promise<void>;
  swipedIds: Set<number>;
  likedIds: Set<number>;
  watchedIds: Set<number>;
  savedItems: MediaItem[];
  skippedItems: MediaItem[];
  watchedItems: MediaItem[];
  activityLog: ActivityEvent[];
  deckCache: MediaItem[];
  cacheDeckItems: (items: MediaItem[]) => void;
  filters: Filters;
  setFilters: (filters: Filters) => Promise<void>;
  recordSwipe: (item: MediaItem, liked: boolean) => Promise<void>;
  markWatched: (item: MediaItem) => Promise<void>;
  undoLastSwipe: () => void;
  removeFromSaved: (id: number) => Promise<void>;
  removeFromWatched: (id: number) => Promise<void>;
  resetHistory: () => Promise<void>;
  getTopGenres: () => number[];
  watchedRatings: Record<number, 'up' | 'meh' | 'down'>;
  rateWatched: (id: number, rating: 'up' | 'meh' | 'down') => Promise<void>;
  stats: {
    totalSwiped: number;
    totalLiked: number;
    totalWatched: number;
    movieLikes: number;
    tvLikes: number;
  };
};

export const defaultFilters: Filters = {
  contentType: 'all',
  era: 'all',
  genres: [],
  minRating: 0,
  ageRatings: [],
  streaming: [],
  inTheaters: false,
  maxRuntime: null,
};

const AppContext = createContext<AppContextType | undefined>(undefined);

async function load<T>(key: string, fallback: T): Promise<T> {
  try {
    const v = await AsyncStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

async function save(key: string, value: any) {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const MAX_ACTIVITY_LOG = 50;

function userKey(username: string | undefined, suffix: string): string {
  return username ? `cs:${username}:${suffix}` : `cs:guest:${suffix}`;
}

export function AppProvider({ children, username }: { children: ReactNode; username?: string }) {
  const [profileName, setProfileNameState] = useState<string>('Guest');
  const [swipedIds, setSwipedIds] = useState<Set<number>>(new Set());
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  const [watchedIds, setWatchedIds] = useState<Set<number>>(new Set());
  const [savedItems, setSavedItems] = useState<MediaItem[]>([]);
  const [skippedItems, setSkippedItems] = useState<MediaItem[]>([]);
  const [watchedItems, setWatchedItems] = useState<MediaItem[]>([]);
  const [activityLog, setActivityLog] = useState<ActivityEvent[]>([]);
  const [deckCache, setDeckCache] = useState<MediaItem[]>([]);
  const [filters, setFiltersState] = useState<Filters>(defaultFilters);
  const [watchedRatings, setWatchedRatings] = useState<Record<number, 'up' | 'meh' | 'down'>>({});
  const [isLoaded, setIsLoaded] = useState(false);
  const lastActionRef = useRef<{ item: MediaItem; direction: 'left' | 'right' | 'up' } | null>(null);

  useEffect(() => {
    (async () => {
      const [name, swiped, liked, watched, saved, skipped, watchedList, storedFilters, log, ratings] = await Promise.all([
        load(userKey(username, 'profileName'), username ?? 'Guest'),
        load(userKey(username, 'swipedIds'), [] as number[]),
        load(userKey(username, 'likedIds'), [] as number[]),
        load(userKey(username, 'watchedIds'), [] as number[]),
        load(userKey(username, 'savedItems'), [] as MediaItem[]),
        load(userKey(username, 'skippedItems'), [] as MediaItem[]),
        load(userKey(username, 'watchedItems'), [] as MediaItem[]),
        load(userKey(username, 'filters'), defaultFilters),
        load(userKey(username, 'activityLog'), [] as ActivityEvent[]),
        load(userKey(username, 'watchedRatings'), {} as Record<number, 'up' | 'meh' | 'down'>),
      ]);
      setProfileNameState(name);
      setSwipedIds(new Set(swiped));
      setLikedIds(new Set(liked));
      setWatchedIds(new Set(watched));
      setSavedItems(saved);
      setSkippedItems(skipped);
      setWatchedItems(watchedList);
      setActivityLog(log);
      setWatchedRatings(ratings);
      const merged: Filters = { ...defaultFilters, ...storedFilters };
      setFiltersState(merged);
      setIsLoaded(true);
    })();
  }, [username]);

  const setProfileName = useCallback(async (name: string) => {
    setProfileNameState(name);
    await save(userKey(username, 'profileName'), name);
  }, [username]);

  const setFilters = useCallback(async (f: Filters) => {
    setFiltersState(f);
    await save(userKey(username, 'filters'), f);
  }, [username]);

  const recordSwipe = useCallback(async (item: MediaItem, liked: boolean) => {
    lastActionRef.current = { item, direction: liked ? 'right' : 'left' };
    setSwipedIds(prev => {
      const next = new Set(prev);
      next.add(item.id);
      save(userKey(username, 'swipedIds'), Array.from(next));
      return next;
    });
    if (liked) {
      setLikedIds(prev => {
        const next = new Set(prev);
        next.add(item.id);
        save(userKey(username, 'likedIds'), Array.from(next));
        return next;
      });
      setSavedItems(prev => {
        if (prev.find(i => i.id === item.id)) return prev;
        const next = [...prev, item];
        save(userKey(username, 'savedItems'), next);
        return next;
      });
      setActivityLog(prev => {
        const event: ActivityEvent = { item, action: 'liked', timestamp: Date.now() };
        const next = [event, ...prev].slice(0, MAX_ACTIVITY_LOG);
        save(userKey(username, 'activityLog'), next);
        return next;
      });
    } else {
      setSkippedItems(prev => {
        if (prev.find(i => i.id === item.id)) return prev;
        const next = [...prev, item];
        save(userKey(username, 'skippedItems'), next);
        return next;
      });
    }
  }, [username]);

  const markWatched = useCallback(async (item: MediaItem) => {
    lastActionRef.current = { item, direction: 'up' };
    setSwipedIds(prev => {
      const next = new Set(prev);
      next.add(item.id);
      save(userKey(username, 'swipedIds'), Array.from(next));
      return next;
    });
    setWatchedIds(prev => {
      const next = new Set(prev);
      next.add(item.id);
      save(userKey(username, 'watchedIds'), Array.from(next));
      return next;
    });
    setWatchedItems(prev => {
      if (prev.find(i => i.id === item.id)) return prev;
      const next = [...prev, item];
      save(userKey(username, 'watchedItems'), next);
      return next;
    });
    setSavedItems(prev => {
      const next = prev.filter(i => i.id !== item.id);
      save(userKey(username, 'savedItems'), next);
      return next;
    });
    setActivityLog(prev => {
      const event: ActivityEvent = { item, action: 'watched', timestamp: Date.now() };
      const next = [event, ...prev].slice(0, MAX_ACTIVITY_LOG);
      save(userKey(username, 'activityLog'), next);
      return next;
    });
  }, [username]);

  const rateWatched = useCallback(async (id: number, rating: 'up' | 'meh' | 'down') => {
    setWatchedRatings(prev => {
      const next = { ...prev, [id]: rating };
      save(userKey(username, 'watchedRatings'), next);
      return next;
    });
  }, [username]);

  const undoLastSwipe = useCallback(() => {
    const action = lastActionRef.current;
    if (!action) return;
    lastActionRef.current = null;
    const { item, direction } = action;

    setSwipedIds(prev => {
      const next = new Set(prev);
      next.delete(item.id);
      save(userKey(username, 'swipedIds'), Array.from(next));
      return next;
    });

    if (direction === 'right') {
      setLikedIds(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        save(userKey(username, 'likedIds'), Array.from(next));
        return next;
      });
      setSavedItems(prev => {
        const next = prev.filter(i => i.id !== item.id);
        save(userKey(username, 'savedItems'), next);
        return next;
      });
      setActivityLog(prev => {
        const idx = prev.findIndex(e => e.item.id === item.id && e.action === 'liked');
        if (idx === -1) return prev;
        const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        save(userKey(username, 'activityLog'), next);
        return next;
      });
    } else if (direction === 'left') {
      setSkippedItems(prev => {
        const next = prev.filter(i => i.id !== item.id);
        save(userKey(username, 'skippedItems'), next);
        return next;
      });
    } else {
      setWatchedIds(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        save(userKey(username, 'watchedIds'), Array.from(next));
        return next;
      });
      setWatchedItems(prev => {
        const next = prev.filter(i => i.id !== item.id);
        save(userKey(username, 'watchedItems'), next);
        return next;
      });
      setActivityLog(prev => {
        const idx = prev.findIndex(e => e.item.id === item.id && e.action === 'watched');
        if (idx === -1) return prev;
        const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        save(userKey(username, 'activityLog'), next);
        return next;
      });
    }
  }, [username]);

  const removeFromSaved = useCallback(async (id: number) => {
    setSavedItems(prev => {
      const next = prev.filter(i => i.id !== id);
      save(userKey(username, 'savedItems'), next);
      return next;
    });
    setLikedIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      save(userKey(username, 'likedIds'), Array.from(next));
      return next;
    });
  }, [username]);

  const removeFromWatched = useCallback(async (id: number) => {
    setWatchedItems(prev => {
      const next = prev.filter(i => i.id !== id);
      save(userKey(username, 'watchedItems'), next);
      return next;
    });
    setWatchedIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      save(userKey(username, 'watchedIds'), Array.from(next));
      return next;
    });
    setWatchedRatings(prev => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      save(userKey(username, 'watchedRatings'), next);
      return next;
    });
  }, [username]);

  const resetHistory = useCallback(async () => {
    setSwipedIds(new Set());
    setLikedIds(new Set());
    setWatchedIds(new Set());
    setSavedItems([]);
    setSkippedItems([]);
    setWatchedItems([]);
    setActivityLog([]);
    setWatchedRatings({});
    await AsyncStorage.multiRemove([
      userKey(username, 'swipedIds'),
      userKey(username, 'likedIds'),
      userKey(username, 'watchedIds'),
      userKey(username, 'savedItems'),
      userKey(username, 'skippedItems'),
      userKey(username, 'watchedItems'),
      userKey(username, 'activityLog'),
      userKey(username, 'watchedRatings'),
    ]);
  }, [username]);

  const cacheDeckItems = useCallback((items: MediaItem[]) => {
    setDeckCache(prev => {
      const existingIds = new Set(prev.map(i => i.id));
      const newItems = items.filter(i => !existingIds.has(i.id));
      if (newItems.length === 0) return prev;
      return [...prev, ...newItems].slice(-500);
    });
  }, []);

  const getTopGenres = useCallback((): number[] => {
    const counts: Record<number, number> = {};
    savedItems.forEach(item => item.genres.forEach(g => { counts[g] = (counts[g] || 0) + 1; }));
    return Object.entries(counts)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 5)
      .map(e => Number(e[0]));
  }, [savedItems]);

  const stats = {
    totalSwiped: swipedIds.size,
    totalLiked: likedIds.size,
    totalWatched: watchedIds.size,
    movieLikes: savedItems.filter(i => i.type === 'movie').length,
    tvLikes: savedItems.filter(i => i.type === 'tv').length,
  };

  if (!isLoaded) return null;

  return (
    <AppContext.Provider value={{
      profileName, setProfileName,
      swipedIds, likedIds, watchedIds,
      savedItems, skippedItems, watchedItems, activityLog,
      deckCache, cacheDeckItems,
      filters, setFilters,
      recordSwipe, markWatched, undoLastSwipe,
      removeFromSaved, removeFromWatched,
      resetHistory, getTopGenres,
      watchedRatings, rateWatched,
      stats,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
}
