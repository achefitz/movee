export type MediaType = 'movie' | 'tv';

/** Normalised TMDB title, cached in the DB so every stage can read it without refetching. */
export type CatalogItem = {
  key: string; // `${type}:${tmdbId}`
  id: number;
  type: MediaType;
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string;
  genres: number[];
  releaseDate: string | null; // YYYY-MM-DD
  voteAverage: number;
  voteCount: number;
  popularity: number;
  language: string;
  runtime: number | null;
  /** Filled by the detail fetch; undefined means "not fetched yet". */
  keywords?: number[];
  cast?: number[];
  providers?: number[]; // US flatrate provider ids
  watchLink?: string | null;
  /** First and latest US theatrical (limited or wide) release dates; movies only. */
  usTheatrical?: { first: string | null; latest: string | null };
  /** IMDb id (tt…), null when TMDB has none. */
  imdbId?: string | null;
  /** Rotten Tomatoes Tomatometer (from Wikidata), cached; score null = none recorded. */
  rt?: { score: number | null; url: string | null; at: number };
  detailsFetchedAt?: number;
};

export type Action = 'like' | 'skip' | 'seen' | 'seen_up' | 'seen_meh' | 'seen_down';

export type Interaction = {
  userId: string;
  itemKey: string;
  action: Action;
  ts: number;
};

export type Era = 'all' | 'new' | 'classic';

export type DeckFilters = {
  contentType: 'all' | 'movie' | 'tv';
  genres: number[];
  streaming: number[];
  era: Era;
  minRating: number;
  maxRuntime: number | null;
  inTheaters: boolean;
};

export const DEFAULT_FILTERS: DeckFilters = {
  contentType: 'all',
  genres: [],
  streaming: [],
  era: 'all',
  minRating: 0,
  maxRuntime: null,
  inTheaters: false,
};

/** Positive = the user wants more like this. "Seen" without a thumbs-down still signals taste. */
export function labelOf(action: Action): 0 | 1 {
  return action === 'skip' || action === 'seen_down' ? 0 : 1;
}

/** How strongly an interaction moves the taste profile. */
export function weightOf(action: Action): number {
  switch (action) {
    case 'seen_up': return 2;
    case 'like': return 1;
    case 'seen': return 1.2;
    case 'seen_meh': return 0.5;
    case 'skip': return -0.6;
    case 'seen_down': return -1;
  }
}

export const itemKey = (type: MediaType, id: number) => `${type}:${id}`;

export function parseKey(key: string): { type: MediaType; id: number } | null {
  const [type, idStr] = key.split(':');
  const id = Number(idStr);
  if ((type !== 'movie' && type !== 'tv') || !Number.isInteger(id) || id <= 0) return null;
  return { type, id };
}

export function yearOf(item: Pick<CatalogItem, 'releaseDate'>): number | null {
  if (!item.releaseDate) return null;
  const y = parseInt(item.releaseDate.slice(0, 4), 10);
  return Number.isFinite(y) && y > 1800 ? y : null;
}
