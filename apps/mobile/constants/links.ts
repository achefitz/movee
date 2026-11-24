import type { MediaItem } from '../services/tmdb';

/**
 * Letterboxd page for a movie. letterboxd.com/tmdb/<id> redirects to the film's page.
 * Letterboxd only catalogues films, so TV shows get no link.
 */
export function letterboxdUrl(item: Pick<MediaItem, 'type' | 'id' | 'tmdbId'>): string | null {
  if (item.type !== 'movie') return null;
  return `https://letterboxd.com/tmdb/${item.tmdbId ?? item.id}/`;
}
