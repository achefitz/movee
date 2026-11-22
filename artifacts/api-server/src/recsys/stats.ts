import { labelOf, type CatalogItem, type Interaction } from './types';

/**
 * Cross-user statistics, rebuilt periodically from the full interaction log.
 *
 * - Count encoding: how often each item / genre has been swiped.
 * - Target encoding: smoothed like-rate per item and per genre (a Bayesian mean
 *   pulled toward the global rate so rarely-seen items don't get extreme values).
 * - Co-visitation: item pairs liked by the same user, cosine-normalised so that
 *   blockbusters everyone likes don't dominate every neighbour list.
 */
export type GlobalStats = {
  builtAt: number;
  globalLikeRate: number;
  itemCount: Map<string, number>;
  itemLikes: Map<string, number>;
  genreCount: Map<number, number>;
  genreLikes: Map<number, number>;
  covisit: Map<string, Array<[string, number]>>;
  nUsers: number;
};

const COVISIT_WINDOW = 30; // pair each like with up to N neighbouring likes
const COVISIT_TOP_K = 50;
const MAX_POSITIVES_PER_USER = 200;

export function buildGlobalStats(
  interactions: Interaction[],
  items: Map<string, CatalogItem>,
  now = Date.now(),
): GlobalStats {
  const itemCount = new Map<string, number>();
  const itemLikes = new Map<string, number>();
  const genreCount = new Map<number, number>();
  const genreLikes = new Map<number, number>();
  const positivesByUser = new Map<string, Interaction[]>();
  let likes = 0;

  for (const it of interactions) {
    const y = labelOf(it.action);
    likes += y;
    itemCount.set(it.itemKey, (itemCount.get(it.itemKey) ?? 0) + 1);
    itemLikes.set(it.itemKey, (itemLikes.get(it.itemKey) ?? 0) + y);
    for (const g of items.get(it.itemKey)?.genres ?? []) {
      genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
      genreLikes.set(g, (genreLikes.get(g) ?? 0) + y);
    }
    if (y === 1) {
      let list = positivesByUser.get(it.userId);
      if (!list) positivesByUser.set(it.userId, (list = []));
      list.push(it);
    }
  }

  // Co-visitation counts.
  const pairs = new Map<string, Map<string, number>>();
  const degree = new Map<string, number>();
  const bump = (a: string, b: string, w: number) => {
    let row = pairs.get(a);
    if (!row) pairs.set(a, (row = new Map()));
    row.set(b, (row.get(b) ?? 0) + w);
  };
  for (const list of positivesByUser.values()) {
    const seq = list.sort((a, b) => a.ts - b.ts).slice(-MAX_POSITIVES_PER_USER);
    const uniq = [...new Set(seq.map(s => s.itemKey))];
    for (const k of uniq) degree.set(k, (degree.get(k) ?? 0) + 1);
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < Math.min(uniq.length, i + 1 + COVISIT_WINDOW); j++) {
        // Likes close together in a session are stronger evidence than distant ones.
        const w = 1 / Math.log2(2 + (j - i - 1));
        bump(uniq[i], uniq[j], w);
        bump(uniq[j], uniq[i], w);
      }
    }
  }
  const covisit = new Map<string, Array<[string, number]>>();
  for (const [a, row] of pairs) {
    const da = degree.get(a) ?? 1;
    const list = [...row.entries()]
      .map(([b, w]) => [b, w / Math.sqrt(da * (degree.get(b) ?? 1))] as [string, number])
      .sort((x, y) => y[1] - x[1])
      .slice(0, COVISIT_TOP_K);
    covisit.set(a, list);
  }

  return {
    builtAt: now,
    globalLikeRate: interactions.length ? likes / interactions.length : 0.5,
    itemCount, itemLikes, genreCount, genreLikes, covisit,
    nUsers: new Set(interactions.map(i => i.userId)).size,
  };
}

export const emptyStats = (): GlobalStats => buildGlobalStats([], new Map());

/** Bayesian-smoothed rate: (hits + m·prior) / (n + m). */
export function smooth(hits: number, n: number, prior: number, m: number): number {
  return (hits + m * prior) / (n + m);
}
