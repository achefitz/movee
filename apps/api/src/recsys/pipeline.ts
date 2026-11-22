import { generateCandidates, type Candidate, type RetrievalInputs } from './candidates';
import { computeFeatures } from './features';
import { noveltyTest, type UserProfile } from './profile';
import { scoreRow, type Ranker } from './ranker';
import { rerank, type Scored } from './rerank';
import type { GlobalStats } from './stats';
import type { CatalogItem } from './types';

export { generateCandidates, rerank };
export type { Candidate, RetrievalInputs, Scored };

/** Stage 2: features → model score for every candidate we have metadata for. */
export function scoreCandidates(
  cands: Map<string, Candidate>,
  items: Map<string, CatalogItem>,
  keep: (item: CatalogItem) => boolean,
  profile: UserProfile,
  stats: GlobalStats,
  model: Ranker,
  now = Date.now(),
): Array<Scored & { cand: Candidate }> {
  const out: Array<Scored & { cand: Candidate }> = [];
  for (const cand of cands.values()) {
    const item = items.get(cand.key);
    if (!item || !keep(item)) continue;
    const x = computeFeatures(item, cand, profile, stats, now);
    out.push({ item, x, score: scoreRow(model, x), cand });
  }
  return out;
}

/** Convenience for callers that already have every item's metadata (tests, offline eval). */
export function recommend(args: {
  profile: UserProfile;
  stats: GlobalStats;
  model: Ranker;
  inputs: RetrievalInputs;
  items: Map<string, CatalogItem>;
  keep?: (item: CatalogItem) => boolean;
  limit: number;
  now?: number;
}): Array<Scored & { cand: Candidate }> {
  const cands = generateCandidates(args.profile, args.stats, args.inputs);
  const scored = scoreCandidates(cands, args.items, args.keep ?? (() => true), args.profile, args.stats, args.model, args.now);
  return rerank(scored, args.profile.n, args.limit, noveltyTest(args.profile)) as Array<Scored & { cand: Candidate }>;
}
