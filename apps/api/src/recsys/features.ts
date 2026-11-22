import { SOURCES, type Candidate } from './candidates';
import { canonicalGenres, cosine, decadeOf, itemVector, type UserProfile } from './profile';
import { smooth, type GlobalStats } from './stats';
import { yearOf, type CatalogItem } from './types';

/**
 * Stage 2 input. Bump FEATURE_VERSION whenever the list or a definition changes:
 * logged rows from older versions are then ignored for training.
 */
export const FEATURE_VERSION = 1;

export const FEATURE_NAMES = [
  // Item
  'item_log_popularity',
  'item_vote_average',
  'item_log_vote_count',
  'item_bayes_rating',
  'item_age_years',
  'item_is_movie',
  'item_runtime',
  'item_n_genres',
  'item_has_details',
  // Count + target encoding (cross-user)
  'item_log_swipe_count',
  'item_te_like_rate',
  'genre_te_like_rate',
  // User
  'user_log_n',
  'user_like_rate',
  'user_movie_share',
  // User × item
  'ui_genre_te_mean',
  'ui_genre_te_max',
  'ui_genre_te_min',
  'ui_decade_te',
  'ui_type_te',
  'ui_content_cos',
  'ui_max_sim_liked',
  'ui_mean_top3_sim_liked',
  'ui_max_sim_skipped',
  'ui_keyword_affinity',
  'ui_cast_affinity',
  'ui_provider_affinity',
  'ui_rating_gap',
  'ui_popularity_gap',
  // Retrieval signals
  ...SOURCES.map(s => `src_${s}_rr`),
  ...SOURCES.map(s => `src_${s}_score`),
  'src_count',
] as const;

export const N_FEATURES = FEATURE_NAMES.length;

const BAYES_M = 500;   // votes needed before trusting TMDB's average
const BAYES_C = 6.5;   // prior mean rating
const TE_ITEM_M = 10;  // smoothing strength for per-item like rate
const TE_GENRE_M = 30;
const TE_USER_M = 4;   // per-user genre/decade/type rates shrink toward the user's own like rate

export function computeFeatures(
  item: CatalogItem,
  cand: Candidate | undefined,
  profile: UserProfile,
  stats: GlobalStats,
  now = Date.now(),
): number[] {
  const f: number[] = [];
  const year = yearOf(item);
  const currentYear = new Date(now).getUTCFullYear();
  const genres = canonicalGenres(item);

  // Item
  f.push(Math.log1p(item.popularity));
  f.push(item.voteAverage);
  f.push(Math.log10(1 + item.voteCount));
  f.push((item.voteCount * item.voteAverage + BAYES_M * BAYES_C) / (item.voteCount + BAYES_M));
  f.push(year == null ? 20 : Math.max(0, currentYear - year));
  f.push(item.type === 'movie' ? 1 : 0);
  f.push(item.runtime ?? 0);
  f.push(genres.length);
  f.push(item.keywords ? 1 : 0);

  // Count + target encoding
  const ic = stats.itemCount.get(item.key) ?? 0;
  f.push(Math.log1p(ic));
  f.push(smooth(stats.itemLikes.get(item.key) ?? 0, ic, stats.globalLikeRate, TE_ITEM_M));
  f.push(mean(genres.map(g =>
    smooth(stats.genreLikes.get(g) ?? 0, stats.genreCount.get(g) ?? 0, stats.globalLikeRate, TE_GENRE_M),
  ), stats.globalLikeRate));

  // User
  f.push(Math.log1p(profile.n));
  f.push(profile.likeRate);
  f.push(profile.movieShare);

  // User × item
  const prior = profile.n ? profile.likeRate : 0.5;
  const rate = (m: UserProfile['genre'], k: string | number) => {
    const c = m.get(k);
    return smooth(c?.pos ?? 0, c?.n ?? 0, prior, TE_USER_M);
  };
  const gRates = genres.map(g => rate(profile.genre, g));
  f.push(mean(gRates, prior));
  f.push(gRates.length ? Math.max(...gRates) : prior);
  f.push(gRates.length ? Math.min(...gRates) : prior);
  const dec = decadeOf(item);
  f.push(dec == null ? prior : rate(profile.decade, dec));
  f.push(rate(profile.type, item.type));

  const vec = itemVector(item);
  f.push(profile.tasteVec.size ? cosine(profile.tasteVec, vec) : 0);
  const likedSims = profile.likedVecs.map(v => cosine(v, vec)).sort((a, b) => b - a);
  f.push(likedSims[0] ?? 0);
  f.push(mean(likedSims.slice(0, 3), 0));
  f.push(Math.max(0, ...profile.skippedVecs.map(v => cosine(v, vec))));
  f.push(sumOf(item.keywords, profile.keywordW));
  f.push(sumOf(item.cast, profile.castW));
  const positives = Math.max(1, Math.round(profile.n * profile.likeRate));
  f.push(item.providers?.length
    ? Math.max(...item.providers.map(p => (profile.providerLikes.get(p) ?? 0) / positives))
    : 0);
  f.push(profile.meanLikedRating == null ? 0 : item.voteAverage - profile.meanLikedRating);
  f.push(profile.meanLikedLogVotes == null ? 0
    : Math.abs(Math.log10(1 + item.voteCount) - profile.meanLikedLogVotes));

  // Retrieval signals: reciprocal rank and raw score per source.
  for (const s of SOURCES) {
    const hit = cand?.sources[s];
    f.push(hit ? 1 / (1 + hit.rank) : 0);
  }
  for (const s of SOURCES) f.push(cand?.sources[s]?.score ?? 0);
  f.push(cand ? Object.keys(cand.sources).length : 0);

  return f;
}

function mean(xs: number[], empty: number): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : empty;
}

function sumOf(ids: number[] | undefined, w: Map<number, number>): number {
  if (!ids) return 0;
  let s = 0;
  for (const id of ids) s += w.get(id) ?? 0;
  return s;
}

export function featureIndex(name: typeof FEATURE_NAMES[number]): number {
  return FEATURE_NAMES.indexOf(name);
}
