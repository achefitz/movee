import { cosine, itemVector, type UserProfile } from './profile';
import type { GlobalStats } from './stats';
import type { CatalogItem } from './types';

/**
 * Stage 1 — candidate generation. Each retriever is cheap, high-recall and
 * biased in a different way; the ranker in stage 2 learns how much to trust each.
 */
export const SOURCES = ['popular', 'toprated', 'explore', 'content', 'covisit', 'i2i'] as const;
export type Source = typeof SOURCES[number];

export type Candidate = {
  key: string;
  sources: Partial<Record<Source, { rank: number; score: number }>>;
  /** Item that pulled this candidate in (for "Because you liked X"). */
  becauseOf?: string;
};

export type RetrievalInputs = {
  /** Filter-matched TMDB discover lists, in TMDB order. */
  popular: string[];
  topRated: string[];
  explore: string[];
  /** TMDB "recommendations" for each recently liked item. */
  i2i: Map<string, string[]>;
  /** Locally cached catalog items that pass the filters, for content retrieval. */
  catalogPool: CatalogItem[];
};

const PER_SOURCE = 120;
const RECENT_SEEDS = 25;

export function generateCandidates(
  profile: UserProfile,
  stats: GlobalStats,
  inp: RetrievalInputs,
): Map<string, Candidate> {
  const out = new Map<string, Candidate>();
  const add = (source: Source, ranked: Array<[string, number]>, because?: Map<string, string>) => {
    let rank = 0;
    for (const [key, score] of ranked) {
      if (profile.seen.has(key)) continue;
      let c = out.get(key);
      if (!c) out.set(key, (c = { key, sources: {} }));
      if (c.sources[source]) continue;
      c.sources[source] = { rank, score };
      if (!c.becauseOf && because?.has(key)) c.becauseOf = because.get(key);
      if (++rank >= PER_SOURCE) break;
    }
  };

  // Popularity / quality baselines (already restricted to the user's filters).
  add('popular', inp.popular.map((k, i) => [k, 1 / (1 + i)]));
  add('toprated', inp.topRated.map((k, i) => [k, 1 / (1 + i)]));
  add('explore', inp.explore.map((k, i) => [k, 1 / (1 + i)]));

  const seeds = profile.recentPositives.slice(0, RECENT_SEEDS);

  // Co-visitation: "people who liked what you liked also liked…"
  // Each seed's neighbours are weighted by recency of the seed.
  {
    const agg = new Map<string, number>();
    const because = new Map<string, string>();
    const best = new Map<string, number>();
    seeds.forEach((seed, age) => {
      const recency = Math.pow(0.9, age);
      for (const [nb, w] of stats.covisit.get(seed) ?? []) {
        const s = w * recency;
        agg.set(nb, (agg.get(nb) ?? 0) + s);
        if (s > (best.get(nb) ?? 0)) { best.set(nb, s); because.set(nb, seed); }
      }
    });
    add('covisit', [...agg.entries()].sort((a, b) => b[1] - a[1]), because);
  }

  // Item-to-item from TMDB's recommendation graph, rank-weighted and recency-weighted.
  {
    const agg = new Map<string, number>();
    const because = new Map<string, string>();
    const best = new Map<string, number>();
    seeds.forEach((seed, age) => {
      const recency = Math.pow(0.9, age);
      (inp.i2i.get(seed) ?? []).forEach((k, rank) => {
        const s = recency / (1 + rank * 0.25);
        agg.set(k, (agg.get(k) ?? 0) + s);
        if (s > (best.get(k) ?? 0)) { best.set(k, s); because.set(k, seed); }
      });
    });
    add('i2i', [...agg.entries()].sort((a, b) => b[1] - a[1]), because);
  }

  // Content-based: nearest catalog items to the user's taste vector.
  if (profile.n > 0 && profile.tasteVec.size > 0) {
    const scored = inp.catalogPool
      .filter(it => !profile.seen.has(it.key))
      .map(it => [it.key, cosine(profile.tasteVec, itemVector(it))] as [string, number])
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1]);
    add('content', scored);
  }

  return out;
}
