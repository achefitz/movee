import { featureIndex } from './features';
import { canonicalGenres } from './profile';
import type { CatalogItem } from './types';

export type Scored = { item: CatalogItem; score: number; x: number[]; explore?: boolean };

const BAYES = featureIndex('item_bayes_rating');

function jaccard(a: number[], b: Set<number>): number {
  if (a.length === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.length + b.size - inter);
}

/**
 * Final ordering: greedy MMR-style pass that trades a little predicted score
 * for genre variety, plus periodic exploration slots so the profile keeps
 * learning about genres the user hasn't tried. New users get more diversity
 * (the deck doubles as taste calibration).
 */
export function rerank(
  scored: Scored[],
  userN: number,
  limit: number,
  isNovel: (item: CatalogItem) => boolean = () => false,
): Scored[] {
  const remaining = [...scored].sort((a, b) => b.score - a.score);
  const out: Scored[] = [];
  const lambda = userN < 10 ? 0.5 : userN < 40 ? 0.25 : 0.15;
  const exploreEvery = userN < 10 ? 0 : userN < 40 ? 5 : 8;
  const recentGenres: number[][] = [];

  while (out.length < limit && remaining.length > 0) {
    const slot = out.length + 1;
    let pick = -1;

    if (exploreEvery && slot % exploreEvery === 0) {
      // Best-rated title outside the user's favourite genres.
      let best = -Infinity;
      remaining.forEach((s, i) => {
        if (!isNovel(s.item)) return;
        const v = s.x[BAYES] + s.score;
        if (v > best) { best = v; pick = i; }
      });
      if (pick >= 0) {
        const [s] = remaining.splice(pick, 1);
        out.push({ ...s, explore: true });
        recentGenres.push(canonicalGenres(s.item));
        if (recentGenres.length > 3) recentGenres.shift();
        continue;
      }
    }

    const window = new Set(recentGenres.flat());
    let best = -Infinity;
    // Only the top of the list can realistically win; keeps this O(limit · 60).
    const horizon = Math.min(remaining.length, 60);
    for (let i = 0; i < horizon; i++) {
      const s = remaining[i];
      const adj = s.score - lambda * jaccard(canonicalGenres(s.item), window);
      if (adj > best) { best = adj; pick = i; }
    }
    const [s] = remaining.splice(pick, 1);
    out.push(s);
    recentGenres.push(canonicalGenres(s.item));
    if (recentGenres.length > 3) recentGenres.shift();
  }
  return out;
}
