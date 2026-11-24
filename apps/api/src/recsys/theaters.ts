import { isoDaysAgo } from './filters';
import type { CatalogItem } from './types';

/** How long after its first US theatrical release a movie counts as "in theaters". */
export const NEW_RELEASE_RUN_DAYS = 60;
/** How long a re-release (anniversary run, IMAX return…) counts as "back in theaters". */
export const RERELEASE_RUN_DAYS = 30;
/** A film first released (anywhere) longer ago than this is "back in theaters", not new. */
export const NEW_FILM_DAYS = 365;

export type TheaterStatus = 'now' | 'rerelease' | null;

/**
 * US theatrical dates from TMDB's /movie/{id}/release_dates.
 * Types 2 (limited) and 3 (wide) are theatrical; 1 = premiere/festival, 4+ = digital, physical, TV.
 */
export function usTheatricalDates(releaseDates: any): CatalogItem['usTheatrical'] {
  const us = (releaseDates?.results ?? []).find((r: any) => r.iso_3166_1 === 'US');
  const dates: string[] = (us?.release_dates ?? [])
    .filter((d: any) => d.type === 2 || d.type === 3)
    .map((d: any) => String(d.release_date).slice(0, 10))
    .filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return { first: dates[0] ?? null, latest: dates[dates.length - 1] ?? null };
}

/**
 * Worked out when the card is served, never stored, so it can't go stale.
 * undefined = we don't have the release dates yet.
 */
export function theaterStatus(item: CatalogItem, now = Date.now()): TheaterStatus | undefined {
  if (item.type !== 'movie') return null;
  const t = item.usTheatrical;
  if (!t) return undefined;
  const today = isoDaysAgo(0, now);
  // TMDB's US list can miss a film's original run (e.g. a 1991 film whose only US entry is
  // this month's restoration), so "new" also requires the first release anywhere to be recent.
  const newFilm = !item.releaseDate || item.releaseDate >= isoDaysAgo(NEW_FILM_DAYS, now);
  if (newFilm && t.first && t.first <= today && t.first >= isoDaysAgo(NEW_RELEASE_RUN_DAYS, now)) return 'now';
  const recentRun = newFilm ? NEW_RELEASE_RUN_DAYS : RERELEASE_RUN_DAYS;
  if (t.latest && t.latest <= today && t.latest >= isoDaysAgo(recentRun, now)) return newFilm ? 'now' : 'rerelease';
  return null;
}
