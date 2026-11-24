/**
 * US age ratings. The filter uses the movie scale; TV ratings map onto it:
 * G = TV-Y, TV-Y7, TV-G · PG = TV-PG · PG-13 = TV-14 · R and NC-17 = TV-MA.
 */
export const MOVIE_RATINGS = ['G', 'PG', 'PG-13', 'R', 'NC-17'] as const;
export type MovieRating = typeof MOVIE_RATINGS[number];

const TV_FOR: Record<MovieRating, string[]> = {
  G: ['TV-Y', 'TV-Y7', 'TV-G'],
  PG: ['TV-PG'],
  'PG-13': ['TV-14'],
  R: ['TV-MA'],
  'NC-17': ['TV-MA'],
};

/** Certifications (movie or TV) allowed by a set of movie-scale picks. */
export function allowedCertifications(type: 'movie' | 'tv', picks: string[]): string[] {
  const valid = picks.filter((p): p is MovieRating => (MOVIE_RATINGS as readonly string[]).includes(p));
  return type === 'movie' ? valid : [...new Set(valid.flatMap(p => TV_FOR[p]))];
}

/** US movie rating from TMDB release_dates: theatrical (3, then 2) first, then any US release. */
export function movieCertification(releaseDates: any): string | null {
  const us = (releaseDates?.results ?? []).find((r: any) => r.iso_3166_1 === 'US');
  const rated = (us?.release_dates ?? []).filter((d: any) => d.certification && d.certification !== 'NR');
  const pick = rated.find((d: any) => d.type === 3) ?? rated.find((d: any) => d.type === 2) ?? rated[0];
  return pick?.certification?.trim() || null;
}

/** US TV rating from TMDB content_ratings. */
export function tvCertification(contentRatings: any): string | null {
  const us = (contentRatings?.results ?? []).find((r: any) => r.iso_3166_1 === 'US');
  return us?.rating?.trim() || null;
}
