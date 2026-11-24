import { theaterStatus } from './theaters';
import { allowedCertifications } from '../ratings/certification';
import type { CatalogItem, DeckFilters, MediaType } from './types';

/** "New release" = released within the last 2 years. */
export const NEW_RELEASE_YEARS = 2;
/** "Oldie" = released before 2000. */
export const CLASSIC_BEFORE = '2000-01-01';

/**
 * TMDB uses different genre ids for TV. Movie genre picks are mapped onto the
 * closest TV genre; genres with no TV equivalent (Horror, Romance, ...) map to nothing.
 */
const MOVIE_TO_TV_GENRE: Record<number, number> = {
  28: 10759, 12: 10759, 16: 16, 35: 35, 80: 80, 99: 99, 18: 18, 10751: 10751,
  14: 10765, 878: 10765, 9648: 9648, 10752: 10768, 37: 37,
};

export function genresFor(type: MediaType, movieGenres: number[]): number[] {
  if (type === 'movie') return movieGenres;
  return [...new Set(movieGenres.map(g => MOVIE_TO_TV_GENRE[g]).filter((g): g is number => !!g))];
}

export function isoDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 86400_000).toISOString().slice(0, 10);
}

export function newReleaseCutoff(now = Date.now()): string {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - NEW_RELEASE_YEARS);
  return d.toISOString().slice(0, 10);
}

/** Which media types a filter set can return at all. */
export function typesFor(f: DeckFilters): MediaType[] {
  let types: MediaType[] = f.contentType === 'all' ? ['movie', 'tv'] : [f.contentType];
  if (f.inTheaters) types = types.filter(t => t === 'movie');
  // A genre filter made only of movie-only genres can't match any TV show.
  if (f.genres.length > 0) types = types.filter(t => genresFor(t, f.genres).length > 0);
  return types;
}

export type MatchResult = 'yes' | 'no' | 'unknown';

/**
 * Exact filter check. Returns 'unknown' when the only open questions need the detail
 * fetch (streaming providers, US theatrical dates) and that hasn't happened yet.
 */
export function matchesFilters(item: CatalogItem, f: DeckFilters, now = Date.now()): MatchResult {
  if (!typesFor(f).includes(item.type)) return 'no';

  if (f.genres.length > 0) {
    const wanted = genresFor(item.type, f.genres);
    if (!item.genres.some(g => wanted.includes(g))) return 'no';
  }

  if (f.era !== 'all') {
    if (!item.releaseDate) return 'no';
    if (f.era === 'new' && item.releaseDate < newReleaseCutoff(now)) return 'no';
    if (f.era === 'classic' && item.releaseDate >= CLASSIC_BEFORE) return 'no';
  }
  // Never show titles that aren't out yet unless "in theaters" asked for current releases.
  if (item.releaseDate && item.releaseDate > isoDaysAgo(0, now)) return 'no';

  if (f.minRating > 0 && item.voteAverage < f.minRating) return 'no';

  let unknown = false;
  if (f.ageRatings.length > 0) {
    if (item.certification === undefined) unknown = true; // details not fetched yet
    else if (!item.certification || !allowedCertifications(item.type, f.ageRatings).includes(item.certification)) return 'no';
  }

  if (f.maxRuntime != null && item.type === 'movie' && item.runtime && item.runtime > f.maxRuntime) {
    return 'no';
  }

  if (f.inTheaters) {
    // New releases and re-releases currently showing in US theaters.
    const status = theaterStatus(item, now);
    if (status === undefined) unknown = true;
    else if (status === null) return 'no';
  }

  if (f.streaming.length > 0) {
    if (!item.providers) unknown = true;
    else if (!item.providers.some(p => f.streaming.includes(p))) return 'no';
  }
  return unknown ? 'unknown' : 'yes';
}

/** Stable cache key for a filter set (order-insensitive). */
export function filterKey(f: DeckFilters): string {
  return JSON.stringify({
    ...f,
    genres: [...f.genres].sort((a, b) => a - b),
    streaming: [...f.streaming].sort((a, b) => a - b),
  });
}
