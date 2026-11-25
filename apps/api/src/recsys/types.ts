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
  /** US age rating (G, PG-13, TV-14…); null = unrated; undefined = not fetched yet. */
  certification?: string | null;
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
  /** Removed from the user's lists; still a swipe for the recommender. */
  hidden?: boolean;
  /** 'search' = added from the Search tab (weighted up in the taste profile). Default 'deck'. */
  source?: InteractionSource;
  /** 1–5 stars from the Watchlist (watched titles). */
  stars?: number | null;
};

export type InteractionSource = 'deck' | 'search';

/** A search result the user opened. */
export type SearchClick = { userId: string; query: string; itemKey: string; ts: number };

export type Era = 'all' | 'new' | 'classic';

export type DeckFilters = {
  contentType: 'all' | 'movie' | 'tv';
  genres: number[];
  streaming: number[];
  era: Era;
  minRating: number;
  /** US age ratings to allow (movie scale; TV maps onto it, see ratings/certification.ts). Empty = any. */
  ageRatings: string[];
  maxRuntime: number | null;
  inTheaters: boolean;
};

export const DEFAULT_FILTERS: DeckFilters = {
  contentType: 'all',
  genres: [],
  streaming: [],
  era: 'all',
  minRating: 0,
  ageRatings: [],
  maxRuntime: null,
  inTheaters: false,
};

/** Positive = the user wants more like this. "Seen" without a thumbs-down still signals taste. */
export function labelOf(action: Action): 0 | 1 {
  return action === 'skip' || action === 'seen_down' ? 0 : 1;
}

/** Stars → the matching thumbs rating: 1–2 down, 3 so-so, 4–5 up. */
export function actionForStars(stars: number): Action {
  return stars <= 2 ? 'seen_down' : stars === 3 ? 'seen_meh' : 'seen_up';
}

/** Taste-profile weight of 1–5 stars: finer than thumbs (5★ > 👍, 1★ < 👎). */
const STAR_WEIGHT: Record<number, number> = { 1: -1.4, 2: -0.8, 3: 0.4, 4: 1.6, 5: 2.6 };

/** Weight of an interaction: its stars when given, else its action. */
export function interactionWeight(i: Pick<Interaction, 'action' | 'stars'>): number {
  return i.stars && STAR_WEIGHT[i.stars] !== undefined ? STAR_WEIGHT[i.stars] : weightOf(i.action);
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
