import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Catalog } from './catalog';
import { FEATURE_VERSION, featureIndex } from './features';
import { matchesFilters } from './filters';
import { theaterStatus } from './theaters';
import { imdbRatings, imdbUrl } from '../ratings/imdb';
import { fetchRottenTomatoes } from '../ratings/rottenTomatoes';
import { generateCandidates, rerank, scoreCandidates, type Candidate, type Scored } from './pipeline';
import { buildProfile, canonicalGenres, noveltyTest } from './profile';
import { MIN_TRAINING_ROWS, trainRanker, type EnsembleModel, type Ranker, type TrainReport, type TrainingRow } from './ranker';
import { buildGlobalStats, emptyStats, type GlobalStats } from './stats';
import type { RecsStore } from './store';
import { actionForStars, DEFAULT_FILTERS, yearOf, type Action, type CatalogItem, type DeckFilters, type InteractionSource } from './types';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };

const IMG = 'https://image.tmdb.org/t/p/w500';
const BACKDROP = 'https://image.tmdb.org/t/p/w780';
const STATS_TTL = 5 * 60_000;
const MAX_STATS_INTERACTIONS = 200_000;
const MAX_TRAINING_ROWS = 60_000;
const RETRAIN_EVERY_NEW_ROWS = 50;
const RETRAIN_MIN_INTERVAL = 10 * 60_000;
const CONTENT_POOL_MAX = 6000;
const I2I_SEEDS = 12;
const RT_TTL = 14 * 24 * 3600_000;
const COLD_START_SWIPES = 10;
const COLD_START_JITTER = 0.8;
const RT_WAIT_MS = 2500;
const LIBRARY_LIMIT = 2000;
const SEARCH_CLICKS_USED = 30;
const SEARCH_LIFT = 0.25;
export const PARTY_DECK_SIZE = 30;
/** Score multiplier by how many of the two have the title on their Watchlist. */
const PARTY_WATCHLIST_BONUS = [1, 1.35, 1.8];
const SEARCH_LIFT_HALF_LIFE = 14 * 24 * 3600_000;
type MediaItem = ReturnType<typeof toMediaItem>;
const BAYES_IDX = featureIndex('item_bayes_rating');

const GENRE_NAMES: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
  10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
  10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

/** Shape matches the app's MediaItem, plus recommender metadata. */
export type DeckItem = {
  id: number;
  tmdbId: number;
  key: string;
  title: string;
  type: 'movie' | 'tv';
  posterUrl: string;
  backdropUrl: string;
  overview: string;
  rating: number;
  voteCount: number;
  genres: number[];
  genreNames: string[];
  year: string;
  streamingIds: number[];
  inTheaters: boolean;
  /** 'now' = first US theatrical run; 'rerelease' = an older film back in theaters. */
  theaterStatus?: 'now' | 'rerelease';
  /** US age rating, e.g. PG-13 or TV-MA. */
  certification?: string;
  imdbId?: string;
  imdbUrl?: string;
  imdbRating?: number;
  imdbVotes?: number;
  /** Rotten Tomatoes Tomatometer, 0–100. */
  rtScore?: number;
  rtUrl?: string;
  watchLink: string | null;
  runtimeMinutes?: number;
  impressionId: string;
  reason?: string;
};

function ratingsOf(it: CatalogItem) {
  const imdb = imdbRatings.get(it.imdbId);
  return {
    imdbId: it.imdbId ?? undefined,
    imdbUrl: it.imdbId ? imdbUrl(it.imdbId) : undefined,
    imdbRating: imdb?.rating,
    imdbVotes: imdb?.votes,
    rtScore: it.rt?.score ?? undefined,
    rtUrl: it.rt?.url ?? undefined,
  };
}

/** Catalog item in the app's MediaItem shape. */
export function toMediaItem(it: CatalogItem): Omit<DeckItem, 'impressionId' | 'reason'> {
  return {
    id: it.id,
    tmdbId: it.id,
    key: it.key,
    title: it.title,
    type: it.type,
    posterUrl: it.posterPath ? IMG + it.posterPath : '',
    backdropUrl: it.backdropPath ? BACKDROP + it.backdropPath : '',
    overview: it.overview,
    rating: it.voteAverage,
    voteCount: it.voteCount,
    genres: it.genres,
    genreNames: it.genres.map(g => GENRE_NAMES[g]).filter(Boolean),
    year: String(yearOf(it) ?? ''),
    streamingIds: it.providers ?? [],
    inTheaters: !!theaterStatus(it),
    theaterStatus: theaterStatus(it) || undefined,
    ...ratingsOf(it),
    certification: it.certification || undefined,
    watchLink: it.watchLink ?? null,
    runtimeMinutes: it.runtime ?? undefined,
  };
}

export type ActivityEvent = {
  item: ReturnType<typeof toMediaItem>;
  action: 'liked' | 'watched';
  timestamp: number;
};

export class RecsService {
  readonly catalog: Catalog;
  private stats: GlobalStats = emptyStats();
  private statsBuilding: Promise<void> | null = null;
  private model: Ranker = null;
  private training = false;
  private lastTrainAt = 0;
  private lastTrainRows = 0;
  private lastCountAt = 0;
  lastReport: TrainReport | null = null;

  constructor(private store: RecsStore, private log: Log) {
    this.catalog = new Catalog(store, log);
  }

  async init() {
    imdbRatings.start(this.log);
    await this.catalog.warm();
    this.model = await this.store.loadLatestModel(FEATURE_VERSION);
    if (this.model) this.lastReport = this.model.metrics;
    await this.refreshStats(true);
    this.log.info({ items: this.catalog.known.size, model: !!this.model, users: this.stats.nUsers }, 'recsys ready');
  }

  private async refreshStats(force = false) {
    if (!force && Date.now() - this.stats.builtAt < STATS_TTL) return;
    if (this.statsBuilding) return this.statsBuilding;
    this.statsBuilding = (async () => {
      const all = await this.store.getAllInteractions(MAX_STATS_INTERACTIONS);
      const keys = [...new Set(all.map(i => i.itemKey))];
      const items = new Map<string, CatalogItem>();
      const missing: string[] = [];
      for (const k of keys) { const it = this.catalog.known.get(k); if (it) items.set(k, it); else missing.push(k); }
      for (const [k, it] of await this.store.getItems(missing)) items.set(k, it);
      this.stats = buildGlobalStats(all, items);
    })().finally(() => { this.statsBuilding = null; });
    return this.statsBuilding;
  }

  async deck(userId: string, f: DeckFilters, exclude: string[], limit: number, favoriteGenres: number[] = []): Promise<DeckItem[]> {
    const now = Date.now();
    void this.refreshStats(); // stale-while-revalidate
    const [history, clicks] = await Promise.all([
      this.store.getUserInteractions(userId),
      this.store.getSearchClicks(userId, SEARCH_CLICKS_USED),
    ]);
    const histItems = await this.catalog.getItems([...history.slice(-300).map(h => h.itemKey), ...clicks.map(c => c.itemKey)]);
    const profile = buildProfile(userId, history, histItems, favoriteGenres, clicks);
    for (const k of exclude) profile.seen.add(k);

    const [pools, i2i] = await Promise.all([
      this.catalog.getPools(f, now),
      this.catalog.getI2I(profile.recentPositives.slice(0, I2I_SEEDS)),
    ]);
    const poolKeys = new Set([...pools.popular, ...pools.topRated, ...pools.explore]);

    const catalogPool: CatalogItem[] = [];
    for (const it of this.catalog.known.values()) {
      if (matchesFilters(it, f, now) === 'yes') catalogPool.push(it);
      if (catalogPool.length >= CONTENT_POOL_MAX) break;
    }

    const cands = generateCandidates(profile, this.stats, { ...pools, i2i, catalogPool });
    const items = await this.catalog.getItems([...cands.keys()]);

    // A title passes if it provably matches, or if TMDB Discover returned it for these exact
    // filters (Discover already applied the streaming filter even before we have provider lists).
    const keep = (it: CatalogItem) => {
      const m = matchesFilters(it, f, now);
      return m === 'yes' || (m === 'unknown' && poolKeys.has(it.key));
    };

    // Pass 1: rank on cheap metadata, keeping 'unknown' items in play.
    // New accounts all start from the same popular pool; a random nudge that fades out over
    // their first swipes gives each of them a different first deck.
    const coldness = Math.max(0, 1 - profile.n / COLD_START_SWIPES);
    const jitter = <T extends { score: number; cand: Candidate }>(xs: T[]) => {
      // Proportional, so it reshuffles similar-fit cards without burying onboarding picks.
      if (coldness > 0) for (const x of xs) x.score *= 1 + Math.random() * COLD_START_JITTER * coldness;
      // Titles found through Search are deliberate picks: what they pulled in gets a lift
      // that fades over a couple of weeks. A score adjustment, not a feature, so logged
      // features (training data) stay as they are.
      for (const x of xs) {
        const seed = x.cand.becauseOf ? profile.searchSeeds.get(x.cand.becauseOf) : undefined;
        if (seed) x.score *= 1 + SEARCH_LIFT * seed.strength * Math.pow(0.5, Math.max(0, now - seed.at) / SEARCH_LIFT_HALF_LIFE);
      }
      return xs;
    };
    const pass1 = jitter(scoreCandidates(cands, items, it => matchesFilters(it, f, now) !== 'no', profile, this.stats, this.model, now))
      .sort((a, b) => b.score - a.score);
    const topN = Math.max(60, limit * 3);
    // Reserve room for well-rated titles far from the current taste, so the
    // re-ranker's exploration slots have something to choose from.
    const isNovel = noveltyTest(profile);
    const exploration = pass1.slice(topN)
      .filter(s => isNovel(s.item))
      .sort((a, b) => b.x[BAYES_IDX] - a.x[BAYES_IDX])
      .slice(0, Math.ceil(limit / 2));
    const first = [...pass1.slice(0, topN), ...exploration];

    // Pass 2: fetch keywords / cast / providers for the shortlist, then rescore exactly.
    const enriched = await this.catalog.enrich(first.map(s => s.item), now);
    const shortlist = new Map<string, Candidate>(first.map(s => [s.item.key, s.cand]));
    const second = jitter(scoreCandidates(shortlist, enriched, keep, profile, this.stats, this.model, now));
    const ranked = rerank(second, profile.n, limit, isNovel) as Array<Scored & { cand: Candidate }>;

    await this.refreshRottenTomatoes(ranked.map(s => s.item));
    const out = ranked.map(s => this.toDeckItem({ ...s, item: this.catalog.known.get(s.item.key) ?? s.item }, histItems));
    await this.store.logImpressions(ranked.map((s, i) => ({
      id: out[i].impressionId,
      userId,
      itemKey: s.item.key,
      featureVersion: FEATURE_VERSION,
      features: s.x,
      position: i,
      score: s.score,
    })));
    return out;
  }

  private toDeckItem(s: Scored & { cand: Candidate }, histItems: Map<string, CatalogItem>): DeckItem {
    const it = s.item;
    let reason: string | undefined;
    const because = s.cand.becauseOf && (histItems.get(s.cand.becauseOf) ?? this.catalog.known.get(s.cand.becauseOf));
    if (s.explore) reason = 'Something different';
    else if (because) reason = `Because you liked ${because.title}`;
    else if (s.cand.sources.toprated && s.cand.sources.toprated.rank < 15 && it.voteAverage >= 8 && it.voteCount >= 1000) reason = 'Critically acclaimed';
    else if (s.cand.sources.popular && s.cand.sources.popular.rank < 15) reason = 'Trending now';

    return { ...toMediaItem(it), impressionId: randomUUID(), reason };
  }

  /**
   * Popular titles for the "pick your favorites" onboarding step: round-robin across the
   * chosen genres so one genre doesn't fill the grid, topped up from overall popularity.
   */
  async onboardingTitles(genres: number[], limit = 20, exclude: Set<string> = new Set()): Promise<Array<ReturnType<typeof toMediaItem>>> {
    const ordered: CatalogItem[] = [];
    const seen = new Set<string>(exclude);
    const add = (it: CatalogItem | undefined) => {
      if (!it || seen.has(it.key) || !it.posterPath) return;
      seen.add(it.key);
      ordered.push(it);
    };
    const byKeys = async (keys: string[]) => {
      const m = await this.catalog.getItems(keys);
      return keys.map(k => m.get(k)).filter((x): x is CatalogItem => !!x);
    };
    if (genres.length) {
      const pools = await this.catalog.getPools({ ...DEFAULT_FILTERS, genres });
      const pool = await byKeys([...pools.popular, ...pools.topRated]);
      const perGenre = genres.map(g => pool.filter(it => canonicalGenres(it).includes(g)));
      for (let i = 0; perGenre.some(l => i < l.length); i++) for (const l of perGenre) add(l[i]);
    }
    const all = await this.catalog.getPools(DEFAULT_FILTERS);
    for (const it of await byKeys([...all.popular, ...all.topRated, ...all.explore])) add(it);
    // Well-known titles first, but shuffled within the top few dozen so everyone's grid differs.
    const head = ordered.slice(0, limit * 3);
    for (let i = head.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [head[i], head[j]] = [head[j], head[i]];
    }
    return head.slice(0, limit).map(toMediaItem);
  }

  /** Titles chosen at onboarding are recorded as watched-and-loved. */
  async recordFavorites(userId: string, keys: string[]) {
    const now = Date.now();
    for (let i = 0; i < keys.length; i++) {
      await this.store.upsertInteraction({ userId, itemKey: keys[i], action: 'seen_up', ts: now - keys.length + i }, null);
    }
  }

  /**
   * Fill in Rotten Tomatoes scores for cards about to be served (cached 14 days, so
   * this is usually a no-op). Never holds the deck up for more than RT_WAIT_MS.
   */
  private async refreshRottenTomatoes(items: CatalogItem[]) {
    const now = Date.now();
    const need = items.filter(it => it.imdbId && (!it.rt || now - it.rt.at > RT_TTL));
    if (!need.length) return;
    const work = fetchRottenTomatoes(need.map(it => it.imdbId!)).then(async found => {
      const updated = need.map(it => ({ ...it, rt: { ...(found.get(it.imdbId!) ?? { score: null, url: null }), at: Date.now() } }));
      await this.catalog.remember(updated);
    }).catch(err => this.log.warn({ err: err.message }, 'Rotten Tomatoes lookup failed'));
    await Promise.race([work, new Promise(r => setTimeout(r, RT_WAIT_MS))]);
  }

  /** A user's recent likes and watches (newest first), for friends' activity feeds. */
  async recentActivity(userId: string, limit: number): Promise<ActivityEvent[]> {
    const hist = (await this.store.getUserInteractions(userId))
      .filter(i => !i.hidden && (i.action === 'like' || i.action.startsWith('seen')))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
    const items = await this.catalog.getItems(hist.map(h => h.itemKey));
    return hist.flatMap(h => {
      const it = items.get(h.itemKey);
      return it ? [{ item: toMediaItem(it), action: h.action === 'like' ? 'liked' as const : 'watched' as const, timestamp: h.ts }] : [];
    });
  }

  /** Genre id → number of liked titles in that genre (the Friends tab's watch-party input). */
  async likedGenreScores(userId: string): Promise<Record<number, number>> {
    const liked = (await this.store.getUserInteractions(userId)).filter(i => i.action === 'like');
    const items = await this.catalog.getItems(liked.map(l => l.itemKey));
    const scores: Record<number, number> = {};
    for (const it of items.values()) for (const g of it.genres) scores[g] = (scores[g] ?? 0) + 1;
    return scores;
  }

  async feedback(userId: string, key: string, action: Action, impressionId: string | null, source: InteractionSource = 'deck') {
    await this.store.upsertInteraction({ userId, itemKey: key, action, ts: Date.now(), source }, impressionId);
    void this.maybeTrain();
  }

  /**
   * The signed-in user's own lists, newest first: liked titles (Watchlist) and watched titles
   * with their rating. `known` is every title the server has a swipe for, hidden or not, so the
   * app can tell "removed on another device" from "not uploaded yet".
   */
  async library(userId: string) {
    const hist = (await this.store.getUserInteractions(userId)).sort((a, b) => b.ts - a.ts);
    const shown = hist.filter(i => !i.hidden && (i.action === 'like' || i.action.startsWith('seen'))).slice(0, LIBRARY_LIMIT);
    const items = await this.catalog.getItems(shown.map(h => h.itemKey));
    const liked: Array<MediaItem & { at: number }> = [];
    const watched: Array<MediaItem & { at: number; myRating: 'up' | 'meh' | 'down' | null; myStars: number | null }> = [];
    for (const h of shown) {
      const it = items.get(h.itemKey);
      if (!it) continue;
      if (h.action === 'like') liked.push({ ...toMediaItem(it), at: h.ts });
      else watched.push({ ...toMediaItem(it), at: h.ts, myRating: (h.action.slice(5) || null) as 'up' | 'meh' | 'down' | null, myStars: h.stars ?? null });
    }
    return { liked, watched, known: hist.map(h => h.itemKey) };
  }

  /**
   * Re-rate a watched title from the Watchlist: thumbs and/or 1–5 stars. Stars set the matching
   * thumbs; a thumbs change keeps the stars only if they still agree. Marks it watched if it wasn't.
   */
  async rate(userId: string, key: string, r: { rating?: 'up' | 'meh' | 'down'; stars?: number | null }) {
    const cur = (await this.store.getUserInteractions(userId)).find(i => i.itemKey === key);
    let stars = cur?.stars ?? null;
    let action: Action;
    if (r.stars !== undefined && r.stars !== null) {
      stars = r.stars;
      action = actionForStars(r.stars);
    } else if (r.rating) {
      action = `seen_${r.rating}` as Action;
      if (stars !== null && actionForStars(stars) !== action) stars = null;
      if (r.stars === null) stars = null;
    } else {
      stars = null; // stars cleared, thumbs unchanged
      action = cur && cur.action.startsWith('seen') ? cur.action : 'seen';
    }
    if (!cur) {
      await this.store.upsertInteraction({ userId, itemKey: key, action, ts: Date.now() }, null);
      if (stars !== null) await this.store.setRating(userId, key, action, stars);
    } else {
      await this.store.setRating(userId, key, action, stars);
    }
    return { rating: (action.slice(5) || null) as 'up' | 'meh' | 'down' | null, stars };
  }

  async hide(userId: string, key: string) {
    await this.store.setHidden(userId, key, true);
  }

  /**
   * A watch party deck for two people: titles on either Watchlist first (both = best), then
   * candidates retrieved for either person, each scored with both taste profiles and combined
   * with a geometric mean so a title has to suit both. Nothing either has watched or skipped.
   * Restricted to the party's type and streaming services, genre-diversified.
   */
  async partyDeck(
    a: { id: string; favoriteGenres: number[] },
    b: { id: string; favoriteGenres: number[] },
    mediaType: 'movie' | 'tv',
    providers: number[],
    size = PARTY_DECK_SIZE,
  ): Promise<string[]> {
    const now = Date.now();
    const f: DeckFilters = { ...DEFAULT_FILTERS, contentType: mediaType, streaming: providers };
    const [ha, hb] = await Promise.all([this.store.getUserInteractions(a.id), this.store.getUserInteractions(b.id)]);
    const histItems = await this.catalog.getItems([...ha.slice(-300), ...hb.slice(-300)].map(h => h.itemKey));
    const pa = buildProfile(a.id, ha, histItems, a.favoriteGenres);
    const pb = buildProfile(b.id, hb, histItems, b.favoriteGenres);

    // Watched or skipped by either: out. Liked (on a Watchlist): in, and favoured.
    const out = new Set<string>();
    const liked = new Map<string, number>(); // key → how many of the two saved it
    for (const h of [...ha, ...hb]) {
      if (h.action === 'like' && !h.hidden) liked.set(h.itemKey, (liked.get(h.itemKey) ?? 0) + 1);
      else out.add(h.itemKey);
    }

    const [pools, i2i] = await Promise.all([
      this.catalog.getPools(f, now),
      this.catalog.getI2I([...pa.recentPositives.slice(0, 6), ...pb.recentPositives.slice(0, 6)]),
    ]);
    const poolKeys = new Set([...pools.popular, ...pools.topRated, ...pools.explore]);
    const catalogPool: CatalogItem[] = [];
    for (const it of this.catalog.known.values()) {
      if (matchesFilters(it, f, now) === 'yes') catalogPool.push(it);
      if (catalogPool.length >= CONTENT_POOL_MAX) break;
    }
    const cands = new Map<string, Candidate>();
    for (const p of [pa, pb]) {
      for (const [k, c] of generateCandidates(p, this.stats, { ...pools, i2i, catalogPool })) {
        const prev = cands.get(k);
        cands.set(k, prev ? { ...prev, sources: { ...c.sources, ...prev.sources } } : c);
      }
    }
    for (const k of liked.keys()) if (!cands.has(k)) cands.set(k, { key: k, sources: {} });
    for (const k of out) cands.delete(k);

    const combine = async (keys: Map<string, Candidate>, keep: (it: CatalogItem) => boolean, items: Map<string, CatalogItem>) => {
      const sa = new Map(scoreCandidates(keys, items, keep, pa, this.stats, this.model, now).map(s => [s.item.key, s]));
      return scoreCandidates(keys, items, keep, pb, this.stats, this.model, now).flatMap(sb => {
        const s1 = sa.get(sb.item.key);
        if (!s1) return [];
        const both = Math.sqrt(s1.score * sb.score) * (PARTY_WATCHLIST_BONUS[liked.get(sb.item.key) ?? 0] ?? 1);
        return [{ ...sb, score: both }];
      });
    };

    const items = await this.catalog.getItems([...cands.keys()]);
    const first = (await combine(cands, it => matchesFilters(it, f, now) !== 'no', items))
      .sort((x, y) => y.score - x.score)
      .slice(0, size * 3);
    // Exact streaming/type check needs provider lists: enrich the shortlist, then rescore.
    const enriched = await this.catalog.enrich(first.map(s => s.item), now);
    const shortlist = new Map(first.map(s => [s.item.key, s.cand]));
    const keep = (it: CatalogItem) => {
      const m = matchesFilters(it, f, now);
      return m === 'yes' || (m === 'unknown' && poolKeys.has(it.key));
    };
    const second = await combine(shortlist, keep, enriched);
    const novel = noveltyTest(pa), novelB = noveltyTest(pb);
    const ranked = rerank(second, Math.min(pa.n, pb.n), size, it => novel(it) && novelB(it)).map(s => s.item.key);
    // Titles you both already saved are the surest picks: always first, never pushed down for variety.
    const both = second.filter(s => (liked.get(s.item.key) ?? 0) >= 2).sort((x, y) => y.score - x.score).map(s => s.item.key);
    return [...new Set([...both, ...ranked])].slice(0, size);
  }

  /** Catalog items for a stored party deck, in deck order, with fresh ratings. */
  async partyItems(keys: string[]) {
    const got = await this.catalog.getItems(keys);
    const items = keys.flatMap(k => got.get(k) ?? []);
    await this.refreshRottenTomatoes(items);
    return items.map(it => toMediaItem(this.catalog.known.get(it.key) ?? it));
  }

  /** Movies and shows matching `query` (TMDB search), with the user's own status on each. */
  async search(userId: string, query: string) {
    const [found, hist] = await Promise.all([this.catalog.search(query), this.store.getUserInteractions(userId)]);
    const status = new Map(hist.filter(h => !h.hidden).map(h => [h.itemKey, h.action]));
    return found.map(it => {
      const a = status.get(it.key);
      return {
        ...toMediaItem(it),
        myStatus: a === 'like' ? 'saved' as const : a?.startsWith('seen') ? 'watched' as const : null,
      };
    });
  }

  async searchClick(userId: string, query: string, key: string) {
    await this.store.logSearchClick({ userId, query: query.slice(0, 100), itemKey: key, ts: Date.now() });
  }

  async undo(userId: string, key: string) {
    await this.store.deleteInteraction(userId, key);
  }

  /**
   * Imports swipes made before the server knew about this user (they lived only on the device).
   * Existing server-side swipes win; metadata is fetched from TMDB, never trusted from the client.
   */
  async sync(userId: string, entries: Array<{ key: string; action: Action }>) {
    const existing = new Set((await this.store.getUserInteractions(userId)).map(i => i.itemKey));
    const fresh = entries.filter(e => !existing.has(e.key));
    const base = Date.now() - fresh.length;
    for (let i = 0; i < fresh.length; i++) {
      await this.store.upsertInteraction({ userId, itemKey: fresh[i].key, action: fresh[i].action, ts: base + i }, null);
    }
    // Hydrate metadata in the background, 40 titles at a time.
    void (async () => {
      const keys = fresh.map(e => e.key);
      for (let i = 0; i < keys.length; i += 40) await this.catalog.getItems(keys.slice(i, i + 40));
    })().catch(err => this.log.warn({ err: err.message }, 'sync hydrate failed'));
    return { imported: fresh.length };
  }

  async maybeTrain(force = false) {
    if (this.training) return;
    const now = Date.now();
    if (!force && now - this.lastTrainAt < RETRAIN_MIN_INTERVAL) return;
    // Don't count rows on every single swipe.
    if (!force && now - this.lastCountAt < 15_000) return;
    this.lastCountAt = now;
    const n = await this.store.countTrainingRows(FEATURE_VERSION);
    if (n < MIN_TRAINING_ROWS) return;
    if (!force && n - this.lastTrainRows < RETRAIN_EVERY_NEW_ROWS) return;

    this.training = true;
    try {
      const rows = await this.store.getTrainingRows(FEATURE_VERSION, MAX_TRAINING_ROWS);
      const { model, report } = await trainOffThread(rows);
      this.lastTrainRows = n;
      // No report = not enough likes/skips in the validation window yet; try again
      // after more swipes rather than waiting out the full cooldown.
      if (!report) return;
      this.lastTrainAt = Date.now();
      this.lastReport = report;
      this.log.info({ report }, 'ranker retrained');
      if (model) {
        this.model = model;
        await this.store.saveModel(model);
      }
      await this.store.pruneImpressions(7);
    } catch (err: any) {
      this.log.error({ err: err.message }, 'ranker training failed');
    } finally {
      this.training = false;
    }
  }

  status() {
    return {
      featureVersion: FEATURE_VERSION,
      model: this.model ? { trainedAt: new Date(this.model.trainedAt).toISOString(), wGbdt: this.model.wGbdt } : 'prior',
      lastReport: this.lastReport,
      catalogItems: this.catalog.known.size,
      users: this.stats.nUsers,
      statsBuiltAt: new Date(this.stats.builtAt).toISOString(),
    };
  }
}

/** Training is CPU-heavy; run it in a worker so swipes keep being served. */
function trainOffThread(rows: TrainingRow[]): Promise<{ model: EnsembleModel | null; report: TrainReport | null }> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerFile = path.join(here, 'train-worker.mjs');
  return new Promise(resolve => {
    let worker: Worker;
    try {
      worker = new Worker(workerFile, { workerData: { rows } });
    } catch {
      resolve(trainRanker(rows)); // e.g. running from source without a build
      return;
    }
    let done = false;
    const finish = (r: { model: EnsembleModel | null; report: TrainReport | null }) => {
      if (!done) { done = true; resolve(r); }
    };
    worker.once('message', finish);
    // Missing worker file (unbuilt dev run) or a crash: fall back to training inline.
    worker.once('error', () => finish(trainRanker(rows)));
    worker.once('exit', () => { if (!done) finish(trainRanker(rows)); });
  });
}
