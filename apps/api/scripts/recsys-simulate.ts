/**
 * Offline simulation of the recommender against synthetic users with hidden tastes.
 *
 *   pnpm --filter @movee/api run recsys:simulate
 *
 * Each round, every user is served a 10-card deck and "swipes" according to a
 * hidden preference function. Swipes feed the cross-user stats and the logged
 * features feed the ranker, which retrains every few rounds. We report the
 * like-rate of served decks against random and popularity baselines.
 */
import { FEATURE_VERSION } from '../src/recsys/features';
import { mulberry32, sigmoid } from '../src/recsys/gbdt';
import { recommend } from '../src/recsys/pipeline';
import { buildProfile, canonicalGenres } from '../src/recsys/profile';
import { trainRanker, type Ranker, type TrainingRow } from '../src/recsys/ranker';
import { buildGlobalStats } from '../src/recsys/stats';
import { yearOf, type CatalogItem, type Interaction } from '../src/recsys/types';

const rng = mulberry32(7);
const gauss = () => {
  const u = 1 - rng(), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const pick = <T>(a: T[]) => a[Math.floor(rng() * a.length)];

const GENRES = [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 53, 10752, 37];
const N_ITEMS = 1500, N_USERS = 120, ROUNDS = 14, DECK = 10;

// ---- synthetic catalog
const items = new Map<string, CatalogItem>();
const kwByGenre = new Map(GENRES.map(g => [g, Array.from({ length: 25 }, (_, i) => g * 100 + i)]));
for (let i = 1; i <= N_ITEMS; i++) {
  const type = rng() < 0.6 ? 'movie' : 'tv';
  const gs = [...new Set(Array.from({ length: 1 + Math.floor(rng() * 3) }, () => pick(GENRES)))];
  const year = Math.round(2026 - Math.abs(gauss()) * 18);
  const key = `${type}:${i}`;
  items.set(key, {
    key, id: i, type: type as 'movie' | 'tv', title: `Title ${i}`, posterPath: null, backdropPath: null, overview: '',
    genres: gs, releaseDate: `${year}-06-01`,
    voteAverage: Math.max(1, Math.min(9.5, 6.6 + gauss() * 0.9)),
    voteCount: Math.round(Math.exp(5 + gauss() * 1.5)),
    popularity: Math.exp(2.5 + gauss()),
    language: rng() < 0.85 ? 'en' : pick(['ko', 'ja', 'fr', 'es']),
    runtime: type === 'movie' ? 85 + Math.round(rng() * 70) : null,
    keywords: gs.flatMap(g => Array.from({ length: 3 }, () => pick(kwByGenre.get(g)!))),
    cast: Array.from({ length: 4 }, () => Math.floor(rng() * 400)),
    providers: [pick([8, 9, 15, 337, 350, 386, 531, 1899])],
  });
}
const all = [...items.values()];

// ---- hidden user tastes
type Hidden = { genre: Map<number, number>; decade: number; quality: number; foreign: number; bias: number; kw: Set<number> };
const users = Array.from({ length: N_USERS }, (_, u) => {
  const genre = new Map(GENRES.map(g => [g, gauss() * 0.3]));
  for (let k = 0; k < 2; k++) genre.set(pick(GENRES), 1.6);
  for (let k = 0; k < 2; k++) genre.set(pick(GENRES), -1.6);
  const kw = new Set(Array.from({ length: 15 }, () => pick(pick([...kwByGenre.values()]))));
  return {
    id: `u${u}`,
    hidden: { genre, decade: pick([1970, 1990, 2010, 2020]), quality: rng(), foreign: gauss() * 0.6, bias: -0.6 + gauss() * 0.3, kw } as Hidden,
  };
});

function pLike(h: Hidden, it: CatalogItem): number {
  const gs = canonicalGenres(it);
  let z = h.bias;
  z += gs.reduce((s, g) => s + (h.genre.get(g) ?? 0), 0) / Math.max(1, gs.length) * 1.6;
  z -= Math.abs((yearOf(it) ?? 2000) - h.decade) / 25;
  z += (it.voteAverage - 6.5) * h.quality;
  if (it.language !== 'en') z += h.foreign;
  z += (it.keywords ?? []).filter(k => h.kw.has(k)).length * 0.4;
  return sigmoid(z);
}

// ---- retrieval inputs shared by everyone (filters off)
const popular = [...all].sort((a, b) => b.popularity - a.popularity).map(i => i.key).slice(0, 300);
const topRated = [...all].filter(i => i.voteCount > 200).sort((a, b) => b.voteAverage - a.voteAverage).map(i => i.key).slice(0, 200);
const i2iAll = new Map<string, string[]>();
for (const it of all) {
  const g = new Set(it.genres);
  const k = new Set(it.keywords);
  i2iAll.set(it.key, all
    .filter(o => o.key !== it.key)
    .map(o => [o.key, o.genres.filter(x => g.has(x)).length + (o.keywords ?? []).filter(x => k.has(x)).length * 0.5 + o.popularity / 200] as [string, number])
    .sort((a, b) => b[1] - a[1]).slice(0, 20).map(([key]) => key));
}

// ---- run
const log: Interaction[] = [];
const rows: TrainingRow[] = [];
let model: Ranker = null;
let ts = 1;

console.log(`feature version ${FEATURE_VERSION}; ${N_ITEMS} items, ${N_USERS} users, ${ROUNDS} rounds of ${DECK}\n`);
console.log('round | pipeline like% | popular like% | random like% | model');

for (let round = 1; round <= ROUNDS; round++) {
  const stats = buildGlobalStats(log, items, ts);
  let hits = 0, served = 0, popHits = 0, randHits = 0;

  for (const u of users) {
    const mine = log.filter(l => l.userId === u.id);
    const profile = buildProfile(u.id, mine, items);
    const explore = Array.from({ length: 150 }, () => pick(all).key);
    const deck = recommend({
      profile, stats, model, items, limit: DECK, now: Date.UTC(2026, 10, 22),
      inputs: { popular, topRated, explore, i2i: i2iAll, catalogPool: all },
    });
    for (const s of deck) {
      const y = rng() < pLike(u.hidden, s.item) ? 1 : 0;
      hits += y; served++;
      log.push({ userId: u.id, itemKey: s.item.key, action: y ? 'like' : 'skip', ts: ts });
      rows.push({ x: s.x, y: y as 0 | 1, ts: ts++, userId: u.id });
    }
    // Baselines on the same user (expected like-rate, unseen items only).
    const popDeck = popular.filter(k => !profile.seen.has(k)).slice(0, DECK);
    popHits += popDeck.reduce((s, k) => s + pLike(u.hidden, items.get(k)!), 0);
    for (let i = 0; i < DECK; i++) randHits += pLike(u.hidden, pick(all));
  }

  const pct = (x: number) => (100 * x / (N_USERS * DECK)).toFixed(1).padStart(5);
  console.log(`${String(round).padStart(5)} |         ${pct(hits)} |        ${pct(popHits)} |       ${pct(randHits)} | ${model ? `ensemble (w_gbdt=${model.wGbdt})` : 'prior'}`);

  if (round % 3 === 0) {
    const { model: m, report } = trainRanker(rows);
    if (report) {
      const a = report.auc;
      console.log(`      retrain on ${report.nTrain}+${report.nVal} rows → val AUC prior ${a.prior.toFixed(3)} | linear ${a.linear.toFixed(3)} | gbdt ${a.gbdt.toFixed(3)} | ensemble ${a.ensemble.toFixed(3)} (${report.gbdtTrees} trees) adopted=${report.adopted}`);
      if (round === ROUNDS - (ROUNDS % 3)) {
        console.log('      top features:', report.topFeatures.slice(0, 6).map(([n, g]) => `${n}(${g.toFixed(0)})`).join(', '));
      }
    }
    if (m) model = m;
  }
}
