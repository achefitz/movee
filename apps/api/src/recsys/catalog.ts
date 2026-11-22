import { tmdbJson } from '../lib/tmdb';
import { CLASSIC_BEFORE, filterKey, genresFor, isoDaysAgo, newReleaseCutoff, typesFor } from './filters';
import type { RecsStore } from './store';
import { itemKey, parseKey, type CatalogItem, type DeckFilters, type MediaType } from './types';

const REGION = 'US';
const POOL_TTL = 30 * 60_000;
const I2I_TTL = 24 * 3600_000;
const DETAILS_TTL = 7 * 24 * 3600_000;
const THEATER_WINDOW_DAYS = 45;

export type Pools = { popular: string[]; topRated: string[]; explore: string[] };

async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]);
    }
  }));
  return out;
}

function fromListResult(raw: any, type: MediaType, now = Date.now()): CatalogItem | null {
  if (!raw?.id || !raw.poster_path) return null;
  const title = type === 'movie' ? raw.title || raw.original_title : raw.name || raw.original_name;
  if (!title) return null;
  const releaseDate = (type === 'movie' ? raw.release_date : raw.first_air_date) || null;
  return {
    key: itemKey(type, raw.id),
    id: raw.id,
    type,
    title,
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
    overview: raw.overview ?? '',
    genres: raw.genre_ids ?? (raw.genres ?? []).map((g: any) => g.id),
    releaseDate,
    voteAverage: Math.round((raw.vote_average ?? 0) * 10) / 10,
    voteCount: raw.vote_count ?? 0,
    popularity: raw.popularity ?? 0,
    language: raw.original_language ?? 'en',
    runtime: null,
    inTheaters: type === 'movie' && !!releaseDate
      && releaseDate >= isoDaysAgo(THEATER_WINDOW_DAYS, now) && releaseDate <= isoDaysAgo(0, now),
  };
}

/** New list data refreshes counts/popularity but must not wipe previously fetched details. */
function merge(prev: CatalogItem | undefined, next: CatalogItem): CatalogItem {
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    runtime: next.runtime ?? prev.runtime,
    keywords: next.keywords ?? prev.keywords,
    cast: next.cast ?? prev.cast,
    providers: next.providers ?? prev.providers,
    watchLink: next.watchLink ?? prev.watchLink,
    detailsFetchedAt: next.detailsFetchedAt ?? prev.detailsFetchedAt,
  };
}

type DiscoverMode = 'popular' | 'toprated' | 'explore';

export function discoverQuery(
  type: MediaType, f: DeckFilters, mode: DiscoverMode, page: number, now = Date.now(),
): Record<string, string | number | undefined> {
  const isMovie = type === 'movie';
  const dateField = isMovie ? 'primary_release_date' : 'first_air_date';
  const q: Record<string, string | number | undefined> = {
    language: 'en-US',
    include_adult: 'false',
    page,
    sort_by: mode === 'toprated' ? 'vote_average.desc' : 'popularity.desc',
    'vote_count.gte': mode === 'toprated' ? 300 : f.era === 'new' ? 10 : 50,
  };
  const genres = genresFor(type, f.genres);
  if (genres.length) q.with_genres = genres.join('|'); // OR

  if (f.era === 'new') q[`${dateField}.gte`] = newReleaseCutoff(now);
  if (f.era === 'classic') q[`${dateField}.lte`] = isoDaysAgo(1, Date.parse(CLASSIC_BEFORE));
  else q[`${dateField}.lte`] = isoDaysAgo(0, now); // nothing unreleased

  if (f.minRating > 0) q['vote_average.gte'] = f.minRating;
  if (isMovie && f.maxRuntime != null) { q['with_runtime.lte'] = f.maxRuntime; q['with_runtime.gte'] = 1; }

  if (isMovie && f.inTheaters) {
    q.region = REGION;
    q.with_release_type = '2|3';
    q['release_date.gte'] = isoDaysAgo(THEATER_WINDOW_DAYS, now);
    q['release_date.lte'] = isoDaysAgo(0, now);
    q['vote_count.gte'] = 0;
  }
  if (f.streaming.length) {
    q.watch_region = REGION;
    q.with_watch_providers = f.streaming.join('|');
    q.with_watch_monetization_types = 'flatrate';
  }
  return q;
}

export class Catalog {
  /** Everything we've ever fetched, kept in memory for content-based retrieval. */
  readonly known = new Map<string, CatalogItem>();
  private pools = new Map<string, { at: number; pools: Pools }>();
  private i2i = new Map<string, { at: number; keys: string[] }>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private store: RecsStore, private log: { warn: (o: object, m: string) => void }) {}

  async warm(limit = 20000) {
    for (const it of await this.store.getRecentItems(limit)) this.known.set(it.key, it);
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async remember(items: CatalogItem[]): Promise<void> {
    // The same title often arrives from several lists at once; merge them into one row.
    const merged = new Map<string, CatalogItem>();
    for (const it of items) {
      const m = merge(merged.get(it.key) ?? this.known.get(it.key), it);
      merged.set(it.key, m);
      this.known.set(it.key, m);
    }
    await this.store.upsertItems([...merged.values()]);
  }

  async getItems(keys: string[]): Promise<Map<string, CatalogItem>> {
    const out = new Map<string, CatalogItem>();
    const missing: string[] = [];
    for (const k of keys) {
      const it = this.known.get(k);
      if (it) out.set(k, it); else missing.push(k);
    }
    if (missing.length) {
      const fromDb = await this.store.getItems(missing);
      for (const [k, it] of fromDb) { out.set(k, it); this.known.set(k, it); }
      const still = missing.filter(k => !fromDb.has(k));
      if (still.length) {
        const fetched = await this.fetchDetails(still.slice(0, 40));
        for (const it of fetched) out.set(it.key, it);
      }
    }
    return out;
  }

  /** Filter-matched discover lists. Cached per filter set. */
  async getPools(f: DeckFilters, now = Date.now()): Promise<Pools> {
    const key = filterKey(f);
    const hit = this.pools.get(key);
    if (hit && now - hit.at < POOL_TTL) return hit.pools;

    return this.once(`pools:${key}`, async () => {
      const types = typesFor(f);
      const jobs: Array<{ type: MediaType; mode: DiscoverMode; page: number }> = [];
      // Explore pages are random deeper pages so long sessions keep finding new things.
      const deep = () => 4 + Math.floor(Math.random() * 12);
      for (const type of types) {
        for (const page of [1, 2, 3]) jobs.push({ type, mode: 'popular', page });
        for (const page of [1, 2]) jobs.push({ type, mode: 'toprated', page });
        for (const page of [deep(), deep()]) jobs.push({ type, mode: 'explore', page });
      }
      const results = await mapLimit(jobs, 8, async j => {
        try {
          const path = j.type === 'movie' ? '/discover/movie' : '/discover/tv';
          const data = await tmdbJson(path, discoverQuery(j.type, f, j.mode, j.page, now));
          return { ...j, items: (data.results ?? []).map((r: any) => fromListResult(r, j.type, now)).filter(Boolean) as CatalogItem[] };
        } catch (err: any) {
          this.log.warn({ err: err.message, job: j }, 'discover failed');
          return { ...j, items: [] as CatalogItem[] };
        }
      });

      const all = results.flatMap(r => r.items);
      if (f.inTheaters) for (const it of all) it.inTheaters = true;
      await this.remember(all);

      // Interleave movie/TV per mode so neither type dominates the top of the list.
      const collect = (mode: DiscoverMode) => {
        const lists = types.map(t => results.filter(r => r.mode === mode && r.type === t).sort((a, b) => a.page - b.page).flatMap(r => r.items.map(i => i.key)));
        const out: string[] = [];
        const seen = new Set<string>();
        for (let i = 0; i < Math.max(0, ...lists.map(l => l.length)); i++) {
          for (const l of lists) if (l[i] && !seen.has(l[i])) { seen.add(l[i]); out.push(l[i]); }
        }
        return out;
      };
      const pools = { popular: collect('popular'), topRated: collect('toprated'), explore: collect('explore') };
      this.pools.set(key, { at: now, pools });
      if (this.pools.size > 200) this.pools.delete(this.pools.keys().next().value!);
      return pools;
    });
  }

  /** TMDB's own item→item recommendations, cached for a day. */
  async getI2I(keys: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const now = Date.now();
    const todo = keys.filter(k => {
      const hit = this.i2i.get(k);
      if (hit && now - hit.at < I2I_TTL) { out.set(k, hit.keys); return false; }
      return true;
    });
    const fetched = await mapLimit(todo, 6, k => this.once(`i2i:${k}`, async () => {
      const p = parseKey(k);
      if (!p) return [] as CatalogItem[];
      try {
        const data = await tmdbJson(`/${p.type}/${p.id}/recommendations`, { language: 'en-US', page: 1 });
        return (data.results ?? []).map((r: any) => fromListResult(r, p.type)).filter(Boolean) as CatalogItem[];
      } catch (err: any) {
        this.log.warn({ err: err.message, k }, 'recommendations failed');
        return [] as CatalogItem[];
      }
    }));
    const newItems: CatalogItem[] = [];
    todo.forEach((k, i) => {
      const list = fetched[i] ?? [];
      newItems.push(...list);
      const ks = list.map(it => it.key);
      this.i2i.set(k, { at: now, keys: ks });
      out.set(k, ks);
    });
    if (this.i2i.size > 20000) this.i2i.delete(this.i2i.keys().next().value!);
    if (newItems.length) await this.remember(newItems);
    return out;
  }

  /**
   * Keywords, cast/director, runtime and US streaming providers in one call per title
   * (append_to_response). Only re-fetched after a week.
   */
  async enrich(items: CatalogItem[], now = Date.now()): Promise<Map<string, CatalogItem>> {
    const stale = items.filter(it => !it.detailsFetchedAt || now - it.detailsFetchedAt > DETAILS_TTL);
    const fresh = await this.fetchDetails(stale.map(it => it.key));
    const out = new Map(items.map(it => [it.key, this.known.get(it.key) ?? it]));
    for (const it of fresh) out.set(it.key, it);
    return out;
  }

  private async fetchDetails(keys: string[]): Promise<CatalogItem[]> {
    const got = await mapLimit(keys, 8, k => this.once(`details:${k}`, async (): Promise<CatalogItem | null> => {
      const p = parseKey(k);
      if (!p) return null;
      try {
        const credits = p.type === 'movie' ? 'credits' : 'aggregate_credits';
        const d = await tmdbJson(`/${p.type}/${p.id}`, { language: 'en-US', append_to_response: `keywords,${credits},watch/providers` });
        const base = fromListResult({ ...d, genre_ids: (d.genres ?? []).map((g: any) => g.id) }, p.type);
        if (!base) return null;
        const kw = p.type === 'movie' ? d.keywords?.keywords : d.keywords?.results;
        const c = d[credits] ?? {};
        const actors = (c.cast ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0)).slice(0, 6).map((x: any) => x.id);
        const directors = (c.crew ?? []).filter((x: any) => x.job === 'Director').slice(0, 2).map((x: any) => x.id);
        const creators = (d.created_by ?? []).slice(0, 2).map((x: any) => x.id);
        const us = d['watch/providers']?.results?.[REGION];
        const runtime = p.type === 'movie' ? d.runtime : d.episode_run_time?.[0];
        return {
          ...base,
          runtime: typeof runtime === 'number' && runtime > 0 ? runtime : null,
          keywords: (kw ?? []).map((x: any) => x.id).slice(0, 25),
          cast: [...new Set<number>([...actors, ...directors, ...creators])],
          providers: (us?.flatrate ?? []).map((x: any) => x.provider_id),
          watchLink: us?.link ?? null,
          detailsFetchedAt: Date.now(),
        };
      } catch (err: any) {
        this.log.warn({ err: err.message, k }, 'details failed');
        return null;
      }
    }));
    const items = got.filter((x): x is CatalogItem => !!x);
    if (items.length) await this.remember(items);
    return items.map(it => this.known.get(it.key) ?? it);
  }
}
