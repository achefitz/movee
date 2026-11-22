/**
 * End-to-end check of the /api/recs routes against a fake TMDB (no network,
 * no database — uses the in-memory store).
 *
 *   pnpm test
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { mulberry32 } from '../src/recsys/gbdt';
import { CLASSIC_BEFORE, newReleaseCutoff } from '../src/recsys/filters';

delete process.env.DATABASE_URL;
process.env.TMDB_API_KEY = 'fake';

// ------------------------------------------------------------------ fake TMDB
const rng = mulberry32(3);
const GENRES = [28, 12, 16, 35, 80, 18, 14, 27, 9648, 10749, 878, 53];
const TV_GENRES = [10759, 16, 35, 80, 18, 9648, 10765];
const PROVIDERS = [8, 9, 15, 337, 350, 386, 531, 1899];
type Fake = { id: number; type: 'movie' | 'tv'; genres: number[]; date: string; vote: number; votes: number; pop: number; providers: number[]; kw: number[] };
const fakes: Fake[] = [];
for (let i = 1; i <= 900; i++) {
  const type = i % 3 === 0 ? 'tv' : 'movie';
  const pool = type === 'movie' ? GENRES : TV_GENRES;
  const year = 1950 + Math.floor(rng() * 77);
  const month = String(1 + Math.floor(rng() * 12)).padStart(2, '0');
  fakes.push({
    id: i, type, genres: [...new Set([pool[Math.floor(rng() * pool.length)], pool[Math.floor(rng() * pool.length)]])],
    date: `${Math.min(year, 2026)}-${month}-10`, vote: Math.round((4 + rng() * 5) * 10) / 10,
    votes: Math.floor(rng() * 5000), pop: rng() * 200,
    providers: PROVIDERS.filter(() => rng() < 0.2), kw: [Math.floor(rng() * 50), Math.floor(rng() * 50)],
  });
}
const list = (f: Fake) => ({
  id: f.id, title: f.type === 'movie' ? `Movie ${f.id}` : undefined, name: f.type === 'tv' ? `Show ${f.id}` : undefined,
  poster_path: `/p${f.id}.jpg`, backdrop_path: null, overview: 'x', genre_ids: f.genres,
  release_date: f.type === 'movie' ? f.date : undefined, first_air_date: f.type === 'tv' ? f.date : undefined,
  vote_average: f.vote, vote_count: f.votes, popularity: f.pop, original_language: 'en',
});
let tmdbCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.themoviedb.org') return realFetch(input, init);
  tmdbCalls++;
  const q = url.searchParams;
  const p = url.pathname.replace('/3', '');
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  let m = p.match(/^\/discover\/(movie|tv)$/);
  if (m) {
    const type = m[1];
    const df = type === 'movie' ? 'primary_release_date' : 'first_air_date';
    let r = fakes.filter(f => f.type === type);
    const g = q.get('with_genres'); if (g) { const gs = g.split('|').map(Number); r = r.filter(f => f.genres.some(x => gs.includes(x))); }
    const prov = q.get('with_watch_providers'); if (prov) { const ps = prov.split('|').map(Number); r = r.filter(f => f.providers.some(x => ps.includes(x))); }
    const gte = q.get(`${df}.gte`); if (gte) r = r.filter(f => f.date >= gte);
    const lte = q.get(`${df}.lte`); if (lte) r = r.filter(f => f.date <= lte);
    const va = q.get('vote_average.gte'); if (va) r = r.filter(f => f.vote >= Number(va));
    const vc = q.get('vote_count.gte'); if (vc) r = r.filter(f => f.votes >= Number(vc));
    r.sort((a, b) => q.get('sort_by') === 'vote_average.desc' ? b.vote - a.vote : b.pop - a.pop);
    const page = Number(q.get('page') ?? 1);
    return json({ page, results: r.slice((page - 1) * 20, page * 20).map(list) });
  }
  m = p.match(/^\/(movie|tv)\/(\d+)\/recommendations$/);
  if (m) {
    const src = fakes.find(f => f.id === Number(m![2]))!;
    const recs = fakes.filter(f => f.type === src.type && f.id !== src.id && f.genres.some(g => src.genres.includes(g))).slice(0, 20);
    return json({ results: recs.map(list) });
  }
  m = p.match(/^\/(movie|tv)\/(\d+)$/);
  if (m) {
    const f = fakes.find(x => x.id === Number(m![2]) && x.type === m![1]);
    if (!f) return new Response('nope', { status: 404 });
    const base = { ...list(f), genres: f.genres.map(id => ({ id })), runtime: 100, episode_run_time: [45] };
    return json({
      ...base,
      keywords: f.type === 'movie' ? { keywords: f.kw.map(id => ({ id })) } : { results: f.kw.map(id => ({ id })) },
      credits: { cast: [{ id: f.id % 40, order: 0 }], crew: [] },
      aggregate_credits: { cast: [{ id: f.id % 40, order: 0 }] },
      'watch/providers': { results: { US: { flatrate: f.providers.map(provider_id => ({ provider_id })), link: 'https://x' } } },
    });
  }
  return new Response('unknown', { status: 404 });
}) as typeof fetch;

// ------------------------------------------------------------------ server
const { default: recsRouter } = await import('../src/routes/recs');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/recs', recsRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/recs`;
const post = async (path: string, body: unknown) => {
  const r = await realFetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};
const byKey = new Map(fakes.map(f => [`${f.type}:${f.id}`, f]));
let passed = 0;
const ok = (msg: string) => { passed++; console.log(`  ✓ ${msg}`); };

try {
  // 1. Cold start deck
  const r1 = await post('/deck', { userId: 'alice', limit: 20 });
  assert.equal(r1.status, 200);
  const d1 = r1.body.items as any[];
  assert.equal(d1.length, 20);
  assert.equal(new Set(d1.map(i => i.key)).size, 20);
  assert.ok(d1.every(i => i.impressionId && i.posterUrl.startsWith('https://image.tmdb.org')));
  ok('cold-start deck: 20 unique, fully-formed cards');

  // 2. Each filter is honoured exactly
  const checks: Array<[string, object, (f: Fake) => boolean]> = [
    ['new releases only', { era: 'new' }, f => f.date >= newReleaseCutoff()],
    ['oldies only (pre-2000)', { era: 'classic' }, f => f.date < CLASSIC_BEFORE],
    ['Netflix or Hulu only', { streaming: [8, 15] }, f => f.providers.some(p => p === 8 || p === 15)],
    ['horror only (movie-only genre → no TV)', { genres: [27] }, f => f.type === 'movie' && f.genres.includes(27)],
    ['sci-fi incl. TV mapping', { genres: [878] }, f => f.genres.includes(878) || f.genres.includes(10765)],
    ['TV + 7.5★ + Max', { contentType: 'tv', minRating: 7.5, streaming: [1899] }, f => f.type === 'tv' && f.vote >= 7.5 && f.providers.includes(1899)],
    ['oldie comedies on Prime', { era: 'classic', genres: [35], streaming: [9] }, f => f.date < CLASSIC_BEFORE && f.genres.includes(35) && f.providers.includes(9)],
  ];
  for (const [name, filt, pred] of checks) {
    const r = await post('/deck', { userId: 'filter-tester', filters: filt, limit: 20 });
    assert.equal(r.status, 200, name);
    const items = r.body.items as any[];
    assert.ok(items.length > 0, `${name}: got no items`);
    for (const it of items) assert.ok(pred(byKey.get(it.key)!), `${name}: ${it.key} violates filter`);
    ok(`filter "${name}": ${items.length} cards, all match`);
  }

  // 3. Swipes are excluded and personalise the deck
  const likedGenre = 878;
  for (const it of d1) {
    const f = byKey.get(it.key)!;
    const action = f.genres.includes(likedGenre) || f.genres.includes(10765) ? 'like' : 'skip';
    assert.equal((await post('/feedback', { userId: 'alice', key: it.key, action, impressionId: it.impressionId })).status, 200);
  }
  const sciFiLikes = d1.filter(it => { const f = byKey.get(it.key)!; return f.genres.includes(878) || f.genres.includes(10765); });
  const r2 = await post('/deck', { userId: 'alice', limit: 20 });
  const d2 = r2.body.items as any[];
  assert.ok(d2.every(i => !d1.some(o => o.key === i.key)), 'swiped item came back');
  ok('swiped cards never come back');
  const share = (d: any[]) => d.filter(i => { const f = byKey.get(i.key)!; return f.genres.includes(878) || f.genres.includes(10765); }).length / d.length;
  console.log(`    sci-fi share: deck1 ${(share(d1) * 100).toFixed(0)}% → deck2 ${(share(d2) * 100).toFixed(0)}% (liked ${sciFiLikes.length} sci-fi, skipped the rest)`);
  if (sciFiLikes.length) {
    assert.ok(share(d2) > share(d1), 'deck did not shift toward liked genre');
    assert.ok(d2.some(i => /^Because you liked /.test(i.reason ?? '')), 'no "Because you liked" reason');
    ok('deck shifts toward liked genre and explains why');
  }

  // 4. Exclude list (cards already in the client's queue)
  const r3 = await post('/deck', { userId: 'alice', limit: 10, exclude: d2.map(i => i.key) });
  assert.ok((r3.body.items as any[]).every(i => !d2.some(o => o.key === i.key)));
  ok('exclude list respected (no duplicates when paging)');

  // 5. Undo
  await post('/undo', { userId: 'alice', key: d1[0].key });
  ok('undo accepted');

  // 6. Validation
  assert.equal((await post('/feedback', { userId: 'alice', key: 'person:5', action: 'like' })).status, 400);
  assert.equal((await post('/deck', { userId: 'bad id!' })).status, 400);
  ok('bad input rejected with 400');

  // 7. Sync of on-device history
  const s = await post('/sync', { userId: 'bob', entries: [{ key: 'movie:1', action: 'like' }, { key: 'tv:3', action: 'skip' }] });
  assert.equal(s.body.imported, 2);
  const s2 = await post('/sync', { userId: 'bob', entries: [{ key: 'movie:1', action: 'skip' }] });
  assert.equal(s2.body.imported, 0);
  ok('sync imports device history once, server copy wins');

  // 8. Many users swiping → ranker trains and is adopted
  const taste = (u: number, f: Fake) => (f.genres[0] % 4 === u % 4 ? 0.85 : 0.12) + (f.vote > 7.5 ? 0.1 : 0);
  for (let round = 0; round < 3; round++) {
    for (let u = 0; u < 25; u++) {
      const d = (await post('/deck', { userId: `sim${u}`, limit: 10 })).body.items as any[];
      for (const it of d) {
        await post('/feedback', { userId: `sim${u}`, key: it.key, action: rng() < taste(u, byKey.get(it.key)!) ? 'like' : 'skip', impressionId: it.impressionId });
      }
    }
  }
  // Training is fire-and-forget after feedback; give it a moment.
  // Training is checked at most every 15s on feedback, so keep swiping lightly while we wait.
  for (let i = 0; i < 60; i++) {
    if (i % 5 === 0) await post('/feedback', { userId: 'sim0', key: d1[1].key, action: 'like' });
    const st = await (await realFetch(base + '/status')).json() as any;
    if (st.lastReport) {
      const a = st.lastReport.auc;
      console.log(`    trained on ${st.lastReport.nTrain}+${st.lastReport.nVal} rows: AUC prior ${a.prior.toFixed(3)} / ensemble ${a.ensemble.toFixed(3)}, adopted=${st.lastReport.adopted}, model=${JSON.stringify(st.model)}`);
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  const st = await (await realFetch(base + '/status')).json() as any;
  assert.ok(st.lastReport, 'ranker never trained');
  ok('ranker retrains from logged impressions');

  console.log(`\n${passed} checks passed; ${tmdbCalls} fake TMDB calls`);
} finally {
  server.close();
}
