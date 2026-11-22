export type MediaItem = {
  id: number;
  tmdbId: number;
  title: string;
  type: 'movie' | 'tv';
  posterUrl: string;
  backdropUrl: string;
  overview: string;
  rating: number;
  voteCount: number;
  genres: number[];
  genreNames: string[];
  year: string;
  trailerKey?: string | null;
  streamingIds: number[];
  inTheaters: boolean;
  watchLink: string | null;
  runtimeMinutes?: number;
};

const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const BACKDROP_BASE = 'https://image.tmdb.org/t/p/w780';

export function getApiBase(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return 'https://' + domain + '/api/tmdb';
  return 'http://localhost:8080/api/tmdb';
}

async function tmdbGet(path: string): Promise<any> {
  const url = getApiBase() + path;
  const res = await fetch(url, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${path}`);
  return res.json();
}

function mapItem(raw: any, kind: 'movie' | 'tv', inTheaters = false, presetStreamingIds?: number[]): MediaItem {
  const isMovie = kind === 'movie';
  const runtime = typeof raw.runtime === 'number' && raw.runtime > 0 ? raw.runtime : undefined;
  return {
    id: raw.id,
    tmdbId: raw.id,
    title: (isMovie ? raw.title || raw.original_title : raw.name || raw.original_name) || 'Unknown',
    type: kind,
    posterUrl: raw.poster_path ? `${IMAGE_BASE}${raw.poster_path}` : '',
    backdropUrl: raw.backdrop_path ? `${BACKDROP_BASE}${raw.backdrop_path}` : '',
    overview: raw.overview || '',
    rating: Math.round((raw.vote_average || 0) * 10) / 10,
    voteCount: raw.vote_count || 0,
    genres: raw.genre_ids || [],
    genreNames: [],
    year: isMovie
      ? (raw.release_date ? raw.release_date.substring(0, 4) : '')
      : (raw.first_air_date ? raw.first_air_date.substring(0, 4) : ''),
    trailerKey: undefined,
    streamingIds: presetStreamingIds || [],
    inTheaters,
    watchLink: null,
    runtimeMinutes: runtime,
  };
}

async function fetchPage(
  endpoint: string,
  kind: 'movie' | 'tv',
  inTheaters = false,
  presetStreamingIds?: number[]
): Promise<MediaItem[]> {
  try {
    const data = await tmdbGet(endpoint);
    return (data.results || [])
      .map((r: any) => mapItem(r, kind, inTheaters, presetStreamingIds))
      .filter((m: MediaItem) => m.posterUrl !== '' && m.title !== 'Unknown');
  } catch {
    return [];
  }
}

export type BulkLoadProgress = {
  loaded: number;
  total: number;
  items: MediaItem[];
};

const STREAMING_PROVIDER_IDS: Array<{ id: number; type: 'movie' | 'tv' }> = [
  { id: 8,    type: 'movie' }, { id: 8,    type: 'tv' },
  { id: 9,    type: 'movie' }, { id: 9,    type: 'tv' },
  { id: 15,   type: 'movie' }, { id: 15,   type: 'tv' },
  { id: 337,  type: 'movie' }, { id: 337,  type: 'tv' },
  { id: 350,  type: 'movie' }, { id: 350,  type: 'tv' },
  { id: 386,  type: 'movie' }, { id: 386,  type: 'tv' },
  { id: 531,  type: 'movie' }, { id: 531,  type: 'tv' },
  { id: 1899, type: 'movie' }, { id: 1899, type: 'tv' },
];

export async function fetchBulkContent(
  onBatch: (items: MediaItem[]) => void,
  signal?: AbortSignal,
  options?: { maxRuntime?: number }
): Promise<void> {
  const PAGES = 8;
  const SECONDARY_PAGES = 5;
  const DISCOVER_PAGES = 2;

  const rp = options?.maxRuntime
    ? `&with_runtime.lte=${options.maxRuntime}&with_runtime.gte=1`
    : '';

  type EndpointEntry = [string, 'movie' | 'tv', boolean, number[]?];
  const endpoints: EndpointEntry[] = [];

  for (let p = 1; p <= PAGES; p++) {
    if (options?.maxRuntime) {
      endpoints.push([`/discover/movie?language=en-US&sort_by=popularity.desc${rp}&page=${p}`, 'movie', false]);
    } else {
      endpoints.push([`/movie/popular?language=en-US&page=${p}`, 'movie', false]);
      endpoints.push([`/trending/movie/week?language=en-US&page=${p}`, 'movie', false]);
    }
    endpoints.push([`/tv/popular?language=en-US&page=${p}`, 'tv', false]);
    endpoints.push([`/trending/tv/week?language=en-US&page=${p}`, 'tv', false]);
  }
  for (let p = 1; p <= SECONDARY_PAGES; p++) {
    if (options?.maxRuntime) {
      endpoints.push([`/discover/movie?language=en-US&sort_by=vote_average.desc&vote_count.gte=100${rp}&page=${p}`, 'movie', false]);
      endpoints.push([`/discover/movie?language=en-US&sort_by=popularity.desc&with_release_type=3${rp}&page=${p}`, 'movie', true]);
    } else {
      endpoints.push([`/movie/top_rated?language=en-US&page=${p}`, 'movie', false]);
      endpoints.push([`/movie/now_playing?language=en-US&page=${p}`, 'movie', true]);
      endpoints.push([`/movie/upcoming?language=en-US&page=${p}`, 'movie', false]);
    }
    endpoints.push([`/tv/top_rated?language=en-US&page=${p}`, 'tv', false]);
    endpoints.push([`/tv/on_the_air?language=en-US&page=${p}`, 'tv', false]);
  }
  for (const { id, type } of STREAMING_PROVIDER_IDS) {
    for (let p = 1; p <= DISCOVER_PAGES; p++) {
      const base = type === 'movie' ? '/discover/movie' : '/discover/tv';
      const runtimeExtra = type === 'movie' ? rp : '';
      const ep = `${base}?language=en-US&watch_region=US&with_watch_providers=${id}&sort_by=popularity.desc${runtimeExtra}&page=${p}`;
      endpoints.push([ep, type, false, [id]]);
    }
  }

  const BATCH = 8;
  const seenIds = new Set<string>();

  for (let i = 0; i < endpoints.length; i += BATCH) {
    if (signal?.aborted) return;

    const batch = endpoints.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(([ep, kind, theaters, presetIds]) => fetchPage(ep, kind, theaters, presetIds))
    );

    const newItems: MediaItem[] = [];
    for (const items of results) {
      for (const item of items) {
        const key = `${item.type}_${item.id}`;
        if (!seenIds.has(key)) {
          seenIds.add(key);
          newItems.push(item);
        } else if (item.streamingIds.length > 0) {
          newItems.push(item);
        }
      }
    }

    if (newItems.length > 0) {
      onBatch(shuffle(newItems));
    }

    if (i + BATCH < endpoints.length) {
      await new Promise(r => setTimeout(r, 150));
    }
  }
}

export async function fetchTrailerKey(type: 'movie' | 'tv', id: number): Promise<string | null> {
  try {
    const data = await tmdbGet(`/${type}/${id}/videos?language=en-US`);
    const results: any[] = data.results || [];
    const priority = ['Trailer', 'Teaser', 'Clip', 'Featurette'];
    for (const p of priority) {
      const v = results.find(r => r.site === 'YouTube' && r.type === p);
      if (v) return v.key;
    }
    const yt = results.find(r => r.site === 'YouTube');
    return yt?.key ?? null;
  } catch {
    return null;
  }
}

export async function fetchWatchProviders(
  type: 'movie' | 'tv',
  id: number
): Promise<{ streamingIds: number[]; watchLink: string | null }> {
  try {
    const data = await tmdbGet(`/${type}/${id}/watch/providers`);
    const us = data.results?.US;
    if (!us) return { streamingIds: [], watchLink: null };
    const flatrate: any[] = us.flatrate || [];
    const streamingIds = flatrate.map((p: any) => p.provider_id as number);
    return { streamingIds, watchLink: us.link || null };
  } catch {
    return { streamingIds: [], watchLink: null };
  }
}

export async function fetchKeywords(type: 'movie' | 'tv', id: number): Promise<string[]> {
  try {
    const data = await tmdbGet(`/${type}/${id}/keywords`);
    const list: any[] = type === 'movie' ? (data.keywords || []) : (data.results || []);
    return list.map((k: any) => k.name as string).filter(Boolean);
  } catch {
    return [];
  }
}

export async function fetchCredits(type: 'movie' | 'tv', id: number): Promise<number[]> {
  try {
    const endpoint = type === 'movie'
      ? `/movie/${id}/credits`
      : `/tv/${id}/aggregate_credits`;
    const data = await tmdbGet(endpoint);
    const cast: any[] = data.cast || [];
    const crew: any[] = data.crew || [];

    const actors = cast
      .filter((c: any) => c.id)
      .sort((a: any, b: any) => (a.order || 0) - (b.order || 0))
      .slice(0, 5)
      .map((c: any) => c.id as number);

    const directors = crew
      .filter((c: any) => c.id && (c.job === 'Director' || c.department === 'Directing'))
      .slice(0, 3)
      .map((c: any) => c.id as number);

    return [...new Set([...actors, ...directors])];
  } catch {
    return [];
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function fetchGenres(type: 'movie' | 'tv'): Promise<Array<{ id: number; name: string }>> {
  try {
    const data = await tmdbGet(`/genre/${type}/list?language=en-US`);
    return data.genres || [];
  } catch {
    return [];
  }
}

export async function fetchSimilarIds(type: 'movie' | 'tv', id: number): Promise<number[]> {
  try {
    const data = await tmdbGet(`/${type}/${id}/similar?language=en-US&page=1`);
    return (data.results || []).map((r: any) => r.id as number);
  } catch {
    return [];
  }
}

export function getViewerTypeApiBase(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return 'https://' + domain + '/api/viewer-type';
  return 'http://localhost:8080/api/viewer-type';
}

export type MediaDetails = {
  director: string;
  cast: string[];
  runtime: string;
};

export async function fetchMediaDetails(type: 'movie' | 'tv', id: number): Promise<MediaDetails> {
  try {
    if (type === 'movie') {
      const data = await tmdbGet(`/movie/${id}?append_to_response=credits`);
      const crew: any[] = data.credits?.crew || [];
      const cast: any[] = data.credits?.cast || [];
      const director = crew.find((c: any) => c.job === 'Director')?.name || '';
      const castNames = cast.slice(0, 5).map((c: any) => c.name as string).filter(Boolean);
      const runtime = data.runtime ? `${data.runtime} min` : '';
      return { director, cast: castNames, runtime };
    } else {
      const data = await tmdbGet(`/tv/${id}?append_to_response=aggregate_credits`);
      const createdBy: any[] = data.created_by || [];
      const cast: any[] = data.aggregate_credits?.cast || [];
      const director = createdBy.map((c: any) => c.name as string).filter(Boolean).join(', ');
      const castNames = cast.slice(0, 5).map((c: any) => c.name as string).filter(Boolean);
      const runtimes: number[] = data.episode_run_time || [];
      const runtime = runtimes.length > 0 ? `${runtimes[0]} min/ep` : '';
      return { director, cast: castNames, runtime };
    }
  } catch {
    return { director: '', cast: [], runtime: '' };
  }
}
