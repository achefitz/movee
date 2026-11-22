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
  /** Set on cards served by the recommender (/api/recs/deck). */
  key?: string;
  impressionId?: string;
  reason?: string;
};


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
