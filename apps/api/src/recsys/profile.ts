import { interactionWeight, labelOf, yearOf, type CatalogItem, type Interaction, type SearchClick } from './types';

export type SparseVec = Map<string, number>;

/** TV genre ids folded onto movie genre ids so a sci-fi show and a sci-fi film share a dimension. */
const TV_TO_MOVIE_GENRES: Record<number, number[]> = {
  10759: [28, 12], 10765: [878, 14], 10768: [10752],
};

export function canonicalGenres(item: Pick<CatalogItem, 'genres'>): number[] {
  const out = new Set<number>();
  for (const g of item.genres) for (const c of TV_TO_MOVIE_GENRES[g] ?? [g]) out.add(c);
  return [...out];
}

export function decadeOf(item: CatalogItem): number | null {
  const y = yearOf(item);
  return y == null ? null : Math.floor(y / 10) * 10;
}

/** Content embedding: a sparse, L2-normalised bag of genres, era, keywords, cast and language. */
export function itemVector(item: CatalogItem): SparseVec {
  const v: SparseVec = new Map();
  for (const g of canonicalGenres(item)) v.set(`g:${g}`, 1);
  const dec = decadeOf(item);
  if (dec != null) {
    v.set(`d:${dec}`, 0.6);
    v.set(`d:${dec - 10}`, 0.2); // neighbouring decades are a little similar
    v.set(`d:${dec + 10}`, 0.2);
  }
  v.set(`t:${item.type}`, 0.3);
  if (item.language && item.language !== 'en') v.set(`l:${item.language}`, 0.5);
  for (const k of (item.keywords ?? []).slice(0, 15)) v.set(`k:${k}`, 0.5);
  for (const c of (item.cast ?? []).slice(0, 8)) v.set(`c:${c}`, 0.5);
  return normalise(v);
}

function normalise(v: SparseVec): SparseVec {
  let n = 0;
  for (const x of v.values()) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v;
  for (const [k, x] of v) v.set(k, x / n);
  return v;
}

export function cosine(a: SparseVec, b: SparseVec): number {
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, x] of small) {
    const y = big.get(k);
    if (y !== undefined) dot += x * y;
  }
  return dot; // both are unit vectors
}

type RateCounter = Map<string | number, { n: number; pos: number }>;

function count(m: RateCounter, k: string | number, y: number) {
  const c = m.get(k) ?? { n: 0, pos: 0 };
  c.n += 1;
  c.pos += y;
  m.set(k, c);
}

export type UserProfile = {
  userId: string;
  n: number;
  likeRate: number;
  movieShare: number;
  genre: RateCounter;
  decade: RateCounter;
  type: RateCounter;
  providerLikes: Map<number, number>;
  keywordW: Map<number, number>;
  castW: Map<number, number>;
  tasteVec: SparseVec;
  likedVecs: SparseVec[];
  skippedVecs: SparseVec[];
  recentPositives: string[]; // newest first
  /**
   * Titles added (strength 1) or only opened (0.5) from Search, with when. What they
   * pull in gets boosted in retrieval and ranking.
   */
  searchSeeds: Map<string, { at: number; strength: number }>;
  meanLikedRating: number | null;
  meanLikedLogVotes: number | null;
  seen: Set<string>;
};

const DECAY = 0.97;
const FAVORITE_GENRE_PSEUDO_LIKES = 2;
const FAVORITE_GENRE_TASTE_WEIGHT = 1.5; // per interaction; older swipes fade but never vanish
const MAX_SIM_VECS = 40;
/**
 * Search is deliberate: someone looked a title up by name. Titles added from Search count
 * SEARCH_BOOST× in the taste profile, add an extra genre like, and seed "more like this"
 * retrieval ahead of Discover likes. Search results merely opened are a lighter signal.
 */
export const SEARCH_BOOST = 2;
const SEARCH_SEEDS = 8;
const CLICK_WEIGHT = 0.5;
const CLICK_DECAY = 0.9;
const CLICK_SEEDS = 4;
const CLICK_STRENGTH = 0.5;

export function buildProfile(
  userId: string,
  interactions: Interaction[],
  items: Map<string, CatalogItem>,
  favoriteGenres: number[] = [],
  searchClicks: SearchClick[] = [], // newest first; their items must be in `items`
): UserProfile {
  const hist = [...interactions].sort((a, b) => a.ts - b.ts);
  const genre: RateCounter = new Map();
  const decade: RateCounter = new Map();
  const type: RateCounter = new Map();
  const providerLikes = new Map<number, number>();
  const keywordW = new Map<number, number>();
  const castW = new Map<number, number>();
  const tasteVec: SparseVec = new Map();
  const likedVecs: SparseVec[] = [];
  const skippedVecs: SparseVec[] = [];
  const recentPositives: string[] = [];
  const searchPositives: string[] = [];
  const searchSeeds = new Map<string, { at: number; strength: number }>();
  let pos = 0, movies = 0, ratingSum = 0, ratingN = 0, votesSum = 0, votesN = 0;

  hist.forEach((it, idx) => {
    const item = items.get(it.itemKey);
    const y = labelOf(it.action);
    pos += y;
    if (!item) return;
    if (item.type === 'movie') movies++;
    const age = hist.length - 1 - idx;
    const fromSearch = it.source === 'search';
    const w = interactionWeight(it) * Math.pow(DECAY, age) * (fromSearch ? SEARCH_BOOST : 1);

    for (const g of canonicalGenres(item)) {
      count(genre, g, y);
      if (fromSearch && y === 1) count(genre, g, 1);
    }
    const dec = decadeOf(item);
    if (dec != null) count(decade, dec, y);
    count(type, item.type, y);

    const vec = itemVector(item);
    for (const [k, x] of vec) tasteVec.set(k, (tasteVec.get(k) ?? 0) + w * x);

    if (y === 1) {
      likedVecs.push(vec);
      (fromSearch ? searchPositives : recentPositives).unshift(it.itemKey);
      if (fromSearch) searchSeeds.set(it.itemKey, { at: it.ts, strength: 1 });
      for (const p of item.providers ?? []) providerLikes.set(p, (providerLikes.get(p) ?? 0) + 1);
      for (const k of item.keywords ?? []) keywordW.set(k, (keywordW.get(k) ?? 0) + w);
      for (const c of item.cast ?? []) castW.set(c, (castW.get(c) ?? 0) + w);
      if (item.voteAverage > 0) { ratingSum += item.voteAverage; ratingN++; }
      if (item.voteCount > 0) { votesSum += Math.log10(item.voteCount); votesN++; }
    } else {
      skippedVecs.push(vec);
      for (const k of item.keywords ?? []) keywordW.set(k, (keywordW.get(k) ?? 0) + w * 0.5);
      for (const c of item.cast ?? []) castW.set(c, (castW.get(c) ?? 0) + w * 0.5);
    }
  });

  // Opened search results lean the taste vector their way and seed retrieval, but
  // never count as likes (no genre like-rate, not "seen", can still be dealt).
  const swiped = new Set(hist.map(h => h.itemKey));
  const clickSeeds: string[] = [];
  searchClicks.forEach((c, i) => {
    const item = items.get(c.itemKey);
    if (!item) return;
    const w = CLICK_WEIGHT * Math.pow(CLICK_DECAY, i);
    for (const [k, x] of itemVector(item)) tasteVec.set(k, (tasteVec.get(k) ?? 0) + w * x);
    for (const k of item.keywords ?? []) keywordW.set(k, (keywordW.get(k) ?? 0) + w);
    for (const ca of item.cast ?? []) castW.set(ca, (castW.get(ca) ?? 0) + w);
    if (!swiped.has(c.itemKey) && !clickSeeds.includes(c.itemKey)) {
      clickSeeds.push(c.itemKey);
      if (!searchSeeds.has(c.itemKey)) searchSeeds.set(c.itemKey, { at: c.ts, strength: CLICK_STRENGTH });
    }
  });

  // Genres picked at onboarding count as a couple of likes each, so a brand-new
  // user's first deck already leans their way. Real swipes outweigh them quickly.
  for (const g of favoriteGenres) {
    for (let i = 0; i < FAVORITE_GENRE_PSEUDO_LIKES; i++) count(genre, g, 1);
    tasteVec.set(`g:${g}`, (tasteVec.get(`g:${g}`) ?? 0) + FAVORITE_GENRE_TASTE_WEIGHT);
  }

  return {
    userId,
    n: hist.length,
    likeRate: hist.length ? pos / hist.length : 0.5,
    movieShare: hist.length ? movies / hist.length : 0.5,
    genre, decade, type, providerLikes, keywordW, castW,
    tasteVec: normalise(tasteVec),
    likedVecs: likedVecs.slice(-MAX_SIM_VECS),
    skippedVecs: skippedVecs.slice(-MAX_SIM_VECS),
    // Retrieval seeds, most telling first: search adds, opened search results, then Discover likes.
    recentPositives: [...new Set([
      ...searchPositives.slice(0, SEARCH_SEEDS),
      ...clickSeeds.slice(0, CLICK_SEEDS),
      ...recentPositives,
      ...searchPositives.slice(SEARCH_SEEDS),
    ])],
    searchSeeds,
    meanLikedRating: ratingN ? ratingSum / ratingN : null,
    meanLikedLogVotes: votesN ? votesSum / votesN : null,
    seen: new Set(hist.map(h => h.itemKey)),
  };
}

/**
 * "Something different": none of the item's genres are among the user's top liked
 * genres. Used for exploration slots so the profile keeps learning.
 */
export function noveltyTest(profile: UserProfile, topK = 3): (item: CatalogItem) => boolean {
  const top = new Set(
    [...profile.genre.entries()]
      .filter(([, c]) => c.pos > 0)
      .sort((a, b) => b[1].pos - a[1].pos)
      .slice(0, topK)
      .map(([g]) => Number(g)),
  );
  return item => top.size > 0 && !canonicalGenres(item).some(g => top.has(g));
}
