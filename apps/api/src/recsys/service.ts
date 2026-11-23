import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Catalog } from './catalog';
import { FEATURE_VERSION, featureIndex } from './features';
import { matchesFilters } from './filters';
import { generateCandidates, rerank, scoreCandidates, type Candidate, type Scored } from './pipeline';
import { buildProfile, noveltyTest } from './profile';
import { MIN_TRAINING_ROWS, trainRanker, type EnsembleModel, type Ranker, type TrainReport, type TrainingRow } from './ranker';
import { buildGlobalStats, emptyStats, type GlobalStats } from './stats';
import type { RecsStore } from './store';
import { yearOf, type Action, type CatalogItem, type DeckFilters } from './types';

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
  watchLink: string | null;
  runtimeMinutes?: number;
  impressionId: string;
  reason?: string;
};

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
    inTheaters: !!it.inTheaters,
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

  async deck(userId: string, f: DeckFilters, exclude: string[], limit: number): Promise<DeckItem[]> {
    const now = Date.now();
    void this.refreshStats(); // stale-while-revalidate
    const history = await this.store.getUserInteractions(userId);
    const histItems = await this.catalog.getItems(history.slice(-300).map(h => h.itemKey));
    const profile = buildProfile(userId, history, histItems);
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
    const pass1 = scoreCandidates(cands, items, it => matchesFilters(it, f, now) !== 'no', profile, this.stats, this.model, now)
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
    const second = scoreCandidates(shortlist, enriched, keep, profile, this.stats, this.model, now);
    const ranked = rerank(second, profile.n, limit, isNovel) as Array<Scored & { cand: Candidate }>;

    const out = ranked.map(s => this.toDeckItem(s, histItems));
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

  /** A user's recent likes and watches (newest first), for friends' activity feeds. */
  async recentActivity(userId: string, limit: number): Promise<ActivityEvent[]> {
    const hist = (await this.store.getUserInteractions(userId))
      .filter(i => i.action === 'like' || i.action.startsWith('seen'))
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

  async feedback(userId: string, key: string, action: Action, impressionId: string | null) {
    await this.store.upsertInteraction({ userId, itemKey: key, action, ts: Date.now() }, impressionId);
    void this.maybeTrain();
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
