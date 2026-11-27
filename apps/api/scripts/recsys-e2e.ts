/**
 * End-to-end check of the /api/recs routes against a fake TMDB (no network,
 * no database — uses the in-memory store).
 *
 *   pnpm test
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mulberry32 } from '../src/recsys/gbdt';
import { CLASSIC_BEFORE, newReleaseCutoff } from '../src/recsys/filters';
import { buildProfile, SEARCH_BOOST } from '../src/recsys/profile';

delete process.env.DATABASE_URL;
process.env.TMDB_API_KEY = 'fake';
process.env.SIGNUP_LIMIT_PER_HOUR = '1000'; // the test signs up ~30 users from one IP
process.env.IMDB_CACHE_FILE = `${(await import('node:os')).tmpdir()}/movee-e2e-imdb-${process.pid}.tsv.gz`;

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
const DAY = 86400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
// Every 25th older movie has a re-release in US theaters 10 days ago (like an IMAX return).
const isRerelease = (f: Fake) => f.type === 'movie' && f.id % 25 === 7 && f.date < iso(Date.now() - 365 * DAY);
const usTheatrical = (f: Fake) => [f.date, ...(isRerelease(f) ? [iso(Date.now() - 10 * DAY)] : [])];
const imdbIdOf = (f: Fake) => `tt${1000000 + f.id}`;
const certOf = (f: Fake) => (f.type === 'movie' ? ['G', 'PG', 'PG-13', 'R'] : ['TV-G', 'TV-PG', 'TV-14', 'TV-MA'])[f.id % 4];
const imdbRatingOf = (f: Fake) => Math.round((3 + (f.id % 60) / 10) * 10) / 10;
const rtOf = (f: Fake) => (f.id * 7) % 101;
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
  if (url.hostname === 'datasets.imdbws.com') {
    const { gzipSync } = await import('node:zlib');
    const tsv = ['tconst\taverageRating\tnumVotes', ...fakes.map(f => `${imdbIdOf(f)}\t${imdbRatingOf(f)}\t${1000 + f.id}`)].join('\n');
    return new Response(gzipSync(tsv), { status: 200 });
  }
  if (url.hostname === 'query.wikidata.org') {
    const ids = [...(url.searchParams.get('query') ?? '').matchAll(/"(tt\d+)"/g)].map(m => m[1]);
    const bindings = ids.flatMap(id => {
      const f = fakes.find(x => imdbIdOf(x) === id);
      if (!f) return [];
      const v = (s: string) => ({ value: s });
      return [
        // An older score, the current one, and a non-Tomatometer "x/10" average that must be ignored.
        { imdb: v(id), score: v(`${Math.max(0, rtOf(f) - 5)}%`), date: v('2020-01-01T00:00:00Z'), method: v('http://www.wikidata.org/entity/Q108403393'), rtid: v(`m/fake_${f.id}`) },
        { imdb: v(id), score: v(`${rtOf(f)}%`), date: v('2025-06-01T00:00:00Z'), method: v('http://www.wikidata.org/entity/Q108403393'), rtid: v(`m/fake_${f.id}`) },
        { imdb: v(id), score: v('6.5/10'), date: v('2026-01-01T00:00:00Z'), method: v('http://www.wikidata.org/entity/Q108403540'), rtid: v(`m/fake_${f.id}`) },
      ];
    });
    return new Response(JSON.stringify({ results: { bindings } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
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
    const cert = q.get('certification'); if (cert) { const cs = cert.split('|'); r = r.filter(f => cs.includes(certOf(f))); }
    const rg = q.get('release_date.gte'), rl = q.get('release_date.lte');
    if (rg || rl) r = r.filter(f => usTheatrical(f).some(d => (!rg || d >= rg) && (!rl || d <= rl)));
    const va = q.get('vote_average.gte'); if (va) r = r.filter(f => f.vote >= Number(va));
    const vc = q.get('vote_count.gte'); if (vc) r = r.filter(f => f.votes >= Number(vc));
    r.sort((a, b) => q.get('sort_by') === 'vote_average.desc' ? b.vote - a.vote : b.pop - a.pop);
    const page = Number(q.get('page') ?? 1);
    return json({ page, results: r.slice((page - 1) * 20, page * 20).map(list) });
  }
  if (p === '/search/multi') {
    // "Movie 12" / "Show 7"; a query matches titles containing it, plus a person to be ignored.
    const query = (q.get('query') ?? '').toLowerCase();
    const page = Number(q.get('page') ?? 1);
    const hits = fakes.filter(f => (f.type === 'movie' ? `movie ${f.id}` : `show ${f.id}`).includes(query));
    const results = [{ id: 999999, media_type: 'person', name: 'Somebody' }, ...hits.map(f => ({ ...list(f), media_type: f.type }))];
    return json({ page, results: results.slice((page - 1) * 20, page * 20) });
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
      imdb_id: f.type === 'movie' ? imdbIdOf(f) : undefined,
      external_ids: { imdb_id: imdbIdOf(f) },
      release_dates: { results: [{ iso_3166_1: 'US', release_dates: usTheatrical(f).map((d, i) => ({ release_date: `${d}T00:00:00.000Z`, type: i === 0 ? 3 : 2, note: i ? 'Re-release' : '', certification: certOf(f) })) }] },
      content_ratings: { results: [{ iso_3166_1: 'US', rating: certOf(f) }] },
    });
  }
  return new Response('unknown', { status: 404 });
}) as typeof fetch;

// ------------------------------------------------------------------ server
// The real app (auth + recs + friends), in-memory stores.
const { default: app } = await import('../src/app');
const server = app.listen(0);
const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
const base = `${root}/recs`;

type Res = { status: number; body: any };
async function call(method: string, url: string, body?: unknown, token?: string): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await realFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Test users are created on first use; `userId` in a body picks whose session token is sent.
const tokens = new Map<string, string>();
async function tokenFor(name: string): Promise<string> {
  let t = tokens.get(name);
  if (!t) {
    const r = await call('POST', `${root}/auth/signup`, { username: name, password: 'correct horse battery' });
    assert.equal(r.status, 201, `signup ${name}: ${JSON.stringify(r.body)}`);
    t = r.body.token as string;
    tokens.set(name, t);
  }
  return t;
}
const post = async (path: string, body: { userId: string } & Record<string, unknown>) => {
  const { userId, ...rest } = body;
  return call('POST', base + path, rest, await tokenFor(userId));
};
const getStatus = async () => (await call('GET', `${base}/status`, undefined, await tokenFor('alice'))).body;
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
    const r = await post('/deck', { userId: 'filter_tester', filters: filt, limit: 20 });
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
  assert.equal((await call('POST', `${base}/deck`, { limit: 5 })).status, 401);
  assert.equal((await call('POST', `${base}/deck`, { limit: 5 }, 'not-a-real-session-token-xxxxxxxx')).status, 401);
  ok('bad input rejected with 400; no/invalid session rejected with 401');

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
    const st = await getStatus();
    if (st.lastReport) {
      const a = st.lastReport.auc;
      console.log(`    trained on ${st.lastReport.nTrain}+${st.lastReport.nVal} rows: AUC prior ${a.prior.toFixed(3)} / ensemble ${a.ensemble.toFixed(3)}, adopted=${st.lastReport.adopted}, model=${JSON.stringify(st.model)}`);
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  const st = await getStatus();
  assert.ok(st.lastReport, 'ranker never trained');
  ok('ranker retrains from logged impressions');

  // 9. Accounts
  const A = `${root}/auth`;
  assert.equal((await call('POST', `${A}/signup`, { username: 'Alice', password: 'whatever123' })).status, 409);
  ok('usernames are unique, case-insensitively');
  assert.equal((await call('POST', `${A}/signup`, { username: 'shorty', password: 'short' })).status, 400);
  assert.equal((await call('POST', `${A}/signup`, { username: 'bad name!', password: 'longenough1' })).status, 400);
  ok('weak password / bad username rejected');
  const wrong = await call('POST', `${A}/login`, { username: 'alice', password: 'nope-nope-nope' });
  const ghost = await call('POST', `${A}/login`, { username: 'nobody_here', password: 'nope-nope-nope' });
  assert.equal(wrong.status, 401); assert.equal(ghost.status, 401);
  assert.equal(wrong.body.error, ghost.body.error);
  ok('wrong password and unknown user give the same 401');
  const li = await call('POST', `${A}/login`, { username: 'ALICE', password: 'correct horse battery' });
  assert.equal(li.status, 200);
  assert.equal(li.body.user.username, '@alice');
  assert.ok(!('passwordHash' in li.body.user));
  const me = await call('GET', `${A}/me`, undefined, li.body.token);
  assert.equal(me.body.user.id, li.body.user.id);
  ok('login is case-insensitive, returns a session, never the hash');
  const patched = await call('PATCH', `${A}/me`, { hasSeenTutorial: true }, li.body.token);
  assert.equal(patched.body.user.hasSeenTutorial, true);
  ok('tutorial flag saved on the account');
  assert.equal((await call('POST', `${A}/logout`, undefined, li.body.token)).status, 200);
  assert.equal((await call('GET', `${A}/me`, undefined, li.body.token)).status, 401);
  assert.equal((await call('GET', `${A}/me`, undefined, await tokenFor('alice'))).status, 200);
  ok('logout ends only that session');
  assert.equal((await call('GET', `${root}/tmdb/movie/550`)).status, 401);
  ok('TMDB proxy requires login');
  let limited = 0;
  for (let i = 0; i < 10; i++) {
    const r = await call('POST', `${A}/login`, { username: 'bob', password: `guess-${i}-xxxx` });
    if (r.status === 429) limited++;
  }
  assert.ok(limited > 0, 'no rate limiting on repeated failures');
  ok(`password guessing is rate-limited (${limited}/10 attempts refused)`);

  // 11. Onboarding
  const O = `${root}/onboarding`;
  const newbie = await tokenFor('newbie');
  assert.equal((await call('GET', `${A}/me`, undefined, newbie)).body.user.onboarded, false);
  const titles = await call('GET', `${O}/titles?genres=27,35`, undefined, newbie);
  assert.equal(titles.status, 200);
  assert.equal(titles.body.items.length, 20);
  const genreHits = titles.body.items.filter((i: any) => i.genres.includes(27) || i.genres.includes(35)).length;
  assert.ok(genreHits >= 15, `only ${genreHits}/20 onboarding titles match the chosen genres`);
  ok(`onboarding grid: 20 popular titles, ${genreHits} in the chosen genres`);
  // Grid order is shuffled; pick horror titles to match the Horror genre pick.
  const favs = titles.body.items.filter((i: any) => i.genres.includes(27)).slice(0, 3).map((i: any) => i.key);
  assert.equal(favs.length, 3, 'not enough horror titles in the onboarding grid');
  const done = await call('POST', O, { genres: [27], favorites: favs }, newbie);
  assert.equal(done.body.user.onboarded, true);
  assert.deepEqual(done.body.user.favoriteGenres, [27]);
  assert.equal((await call('GET', `${A}/me`, undefined, newbie)).body.user.onboarded, true);
  ok('onboarding answers saved on the account');
  // First decks are deliberately randomized (cold start), so judge the lean over three of them.
  const nd: any[] = [];
  for (let i = 0; i < 3; i++) {
    nd.push(...(await post('/deck', { userId: 'newbie', limit: 20, exclude: nd.map(x => x.key) })).body.items);
  }
  assert.ok(nd.every(i => !favs.includes(i.key)), 'picked favorites shown again in the deck');
  const horrorShare = nd.filter(i => byKey.get(i.key)!.genres.includes(27)).length / nd.length;
  const coldShare = d1.filter(i => byKey.get(i.key)!.genres.includes(27)).length / d1.length;
  console.log(`    horror share in first deck: no onboarding ${(coldShare * 100).toFixed(0)}% → picked Horror ${(horrorShare * 100).toFixed(0)}%`);
  assert.ok(horrorShare > coldShare, 'first deck does not lean towards the picked genre');
  ok('first deck leans towards picked genres and skips picked favorites');
  assert.equal((await call('POST', O, { genres: [], favorites: [] }, await tokenFor('skipper'))).body.user.onboarded, true);
  ok('skipping onboarding marks it done');

  // 12. Ratings + in-theaters
  const rd = (await post('/deck', { userId: 'ratings_fan', limit: 20 })).body.items as any[];
  const withImdb = rd.filter(i => typeof i.imdbRating === 'number');
  assert.ok(withImdb.length >= 15, `only ${withImdb.length}/20 cards have an IMDb rating`);
  assert.ok(withImdb.every(i => i.imdbRating === imdbRatingOf(byKey.get(i.key)!) && i.imdbUrl === `https://www.imdb.com/title/${imdbIdOf(byKey.get(i.key)!)}/`));
  ok(`IMDb rating + link on ${withImdb.length}/20 cards, matching the dataset`);
  const withRt = rd.filter(i => typeof i.rtScore === 'number');
  assert.ok(withRt.length >= 15, `only ${withRt.length}/20 cards have an RT score`);
  assert.ok(withRt.every(i => i.rtScore === rtOf(byKey.get(i.key)!) && /^https:\/\/www\.rottentomatoes\.com\/m\/fake_\d+$/.test(i.rtUrl)));
  ok(`Rotten Tomatoes: latest Tomatometer on ${withRt.length}/20 cards (older scores and x/10 averages ignored)`);

  const td = (await post('/deck', { userId: 'theater_goer', limit: 30, filters: { inTheaters: true } })).body.items as any[];
  assert.ok(td.length > 0, 'no in-theaters cards');
  for (const i of td) {
    const f = byKey.get(i.key)!;
    const expected = isRerelease(f) ? 'rerelease' : 'now';
    assert.equal(i.theaterStatus, expected, `${i.key} (${f.date}) should be ${expected}, got ${i.theaterStatus}`);
    if (expected === 'now') assert.ok(f.date >= iso(Date.now() - 60 * DAY), `${i.key} from ${f.date} marked in theaters`);
  }
  const rer = td.filter(i => i.theaterStatus === 'rerelease').length;
  ok(`in-theaters: ${td.length - rer} new releases + ${rer} re-releases, each labelled correctly`);
  {
    const { theaterStatus } = await import('../src/recsys/theaters');
    const movie = (first: string | null, latest: string | null, releaseDate: string | null = first) =>
      ({ type: 'movie', releaseDate, usTheatrical: { first, latest } }) as any;
    const d = (n: number) => iso(Date.now() - n * DAY);
    assert.equal(theaterStatus(movie(d(20), d(20))), 'now');
    assert.equal(theaterStatus(movie(d(59), d(59))), 'now');
    assert.equal(theaterStatus(movie(d(90), d(90))), null);
    assert.equal(theaterStatus(movie('2019-07-26', d(5))), 'rerelease');          // Once Upon a Time… IMAX return
    assert.equal(theaterStatus(movie(d(18), d(18), '1991-10-10')), 'rerelease');  // Raise the Red Lantern: TMDB lacks the 1992 US run
    assert.equal(theaterStatus(movie(d(40), d(40), d(200))), 'now');             // festival film, US debut this autumn
    assert.equal(theaterStatus(movie('2019-07-26', d(45))), null);                // re-release run over
    assert.equal(theaterStatus(movie(iso(Date.now() + 9 * DAY), iso(Date.now() + 9 * DAY))), null); // not out yet
    assert.equal(theaterStatus({ type: 'tv' } as any), null);
    assert.equal(theaterStatus({ type: 'movie' } as any), undefined);           // dates not fetched yet
    ok('theater rule: new = first US run ≤60 days ago (film <1 yr old), re-release = back ≤30 days, never future or TV');
  }
  const everyday = (await post('/deck', { userId: 'ratings_fan', limit: 20 })).body.items as any[];
  assert.ok(everyday.every(i => !i.inTheaters || byKey.get(i.key)!.date >= iso(Date.now() - 60 * DAY) || isRerelease(byKey.get(i.key)!)),
    'an old film without a re-release is marked in theaters');
  ok('old films are never "in theaters" unless they are actually back in theaters');

  // 10. Follows + privacy
  const F = `${root}/follows`;
  const aliceT = await tokenFor('alice');
  const sim1T = await tokenFor('sim1');
  assert.equal((await call('GET', `${F}/sim1/taste`, undefined, aliceT)).status, 404);
  ok("can't read someone's taste without following them");
  assert.equal((await call('POST', F, { username: 'no_such_user' }, aliceT)).status, 404);
  assert.equal((await call('POST', F, { username: '@alice' }, aliceT)).status, 400);
  const pub1 = await call('POST', F, { username: 'SIM1' }, aliceT);
  assert.equal(pub1.status, 201); assert.equal(pub1.body.follow.status, 'accepted');
  assert.equal((await call('POST', F, { username: 'sim1' }, aliceT)).status, 409);
  ok('follow a public account: accepted at once; unknown → 404, self → 400, twice → 409');
  const act = await call('GET', `${F}/activity`, undefined, aliceT);
  assert.ok(act.body.events.length > 0 && act.body.events.every((e: any) => e.friendUsername === '@sim1' && e.item.title));
  assert.ok(Object.keys((await call('GET', `${F}/sim1/taste`, undefined, aliceT)).body.genreScores).length > 0);
  ok(`following feed (${act.body.events.length} events) and taste come from their swipes`);
  const sim1Lists = (await call('GET', F, undefined, sim1T)).body;
  assert.deepEqual(sim1Lists.followers.map((f: any) => f.username), ['@alice']);
  ok('followers list shows who follows you');

  // sim2 goes private: alice's follow becomes a request
  const sim2T = await tokenFor('sim2');
  assert.equal((await call('PATCH', `${A}/me`, { isPrivate: true }, sim2T)).body.user.isPrivate, true);
  const req1 = await call('POST', F, { username: 'sim2' }, aliceT);
  assert.equal(req1.body.follow.status, 'pending');
  assert.equal((await call('GET', `${F}/sim2/taste`, undefined, aliceT)).status, 404);
  assert.ok((await call('GET', `${F}/activity`, undefined, aliceT)).body.events.every((e: any) => e.friendUsername !== '@sim2'));
  ok('private account: follow becomes a request; nothing visible until approved');
  const inbox = (await call('GET', F, undefined, sim2T)).body;
  assert.deepEqual(inbox.requests.map((r: any) => r.username), ['@alice']);
  assert.equal(inbox.followers.length, 0);
  assert.equal((await call('POST', `${F}/requests/alice/approve`, undefined, sim2T)).status, 200);
  assert.equal((await call('GET', `${F}/sim2/taste`, undefined, aliceT)).status, 200);
  assert.ok((await call('GET', `${F}/activity?limit=50`, undefined, aliceT)).body.events.some((e: any) => e.friendUsername === '@sim2'));
  ok('approving a request unlocks their likes, watches and taste');
  await call('DELETE', `${F}/followers/alice`, undefined, sim2T);
  assert.equal((await call('GET', `${F}/sim2/taste`, undefined, aliceT)).status, 404);
  ok('removing a follower revokes access');
  const bobT = await tokenFor('bob');
  await call('POST', F, { username: 'sim2' }, bobT);
  assert.equal((await call('POST', `${F}/requests/bob/decline`, undefined, sim2T)).status, 200);
  assert.equal((await call('GET', F, undefined, bobT)).body.following.length, 0);
  await call('POST', F, { username: 'sim2' }, bobT);
  await call('PATCH', `${A}/me`, { isPrivate: false }, sim2T);
  assert.equal((await call('GET', F, undefined, bobT)).body.following[0].status, 'accepted');
  ok('decline removes the request; going public approves everyone waiting');
  await call('DELETE', `${F}/sim1`, undefined, aliceT);
  assert.ok((await call('GET', F, undefined, aliceT)).body.following.every((f: any) => f.username !== '@sim1'));
  ok('unfollow');

  // 14. Age ratings
  const kids = (await post('/deck', { userId: 'parent', limit: 20, filters: { ageRatings: ['G', 'PG'] } })).body.items as any[];
  assert.ok(kids.length > 0, 'no G/PG cards');
  for (const i of kids) {
    const f = byKey.get(i.key)!;
    assert.ok(['G', 'PG', 'TV-G', 'TV-PG'].includes(certOf(f)), `${i.key} is ${certOf(f)}`);
    assert.equal(i.certification, certOf(f));
  }
  ok(`age-rating filter G+PG: ${kids.length} cards, all G/PG (TV-G/TV-PG for shows), rating shown on each`);

  // 15. Profiles
  const U = `${root}/users`;
  const prof = await call('GET', `${U}/sim3`, undefined, aliceT);
  assert.equal(prof.status, 200);
  assert.ok(prof.body.canView && prof.body.liked.length > 0 && prof.body.liked.every((i: any) => i.title));
  ok(`public profile: anyone signed in sees likes (${prof.body.liked.length}) and watches`);
  const sim4T = await tokenFor('sim4');
  await call('PATCH', `${A}/me`, { isPrivate: true }, sim4T);
  const hidden = await call('GET', `${U}/sim4`, undefined, aliceT);
  assert.equal(hidden.body.canView, false); assert.equal(hidden.body.liked.length, 0);
  assert.equal(hidden.body.user.isPrivate, true);
  await call('POST', F, { username: 'sim4' }, aliceT);
  assert.equal((await call('GET', `${U}/sim4`, undefined, aliceT)).body.followStatus, 'pending');
  await call('POST', `${F}/requests/alice/approve`, undefined, sim4T);
  const shown = await call('GET', `${U}/sim4`, undefined, aliceT);
  assert.ok(shown.body.canView && shown.body.liked.length > 0);
  const back = await call('GET', `${U}/alice`, undefined, sim4T);
  assert.equal(back.body.followsYou, true);
  assert.equal((await call('GET', `${U}/nobody_here`, undefined, aliceT)).status, 404);
  ok('private profile hidden until approved; "follows you" shown; unknown → 404');

  // 16. Library: lists follow the account; removals hide without forgetting the swipe
  const libT = await tokenFor('lib_user');
  const libDeck = (await post('/deck', { userId: 'lib_user', limit: 6 })).body.items as any[];
  const [l1, l2, w1, w2] = libDeck.map(i => i.key as string);
  for (const [key, action] of [[l1, 'like'], [l2, 'like'], [w1, 'seen'], [w2, 'seen_up']] as const) {
    await call('POST', `${base}/feedback`, { key, action }, libT);
  }
  const lib = (await call('GET', `${base}/library`, undefined, libT)).body;
  const keyOf = (i: any) => `${i.type}:${i.id}`;
  assert.deepEqual(lib.liked.map(keyOf).sort(), [l1, l2].sort());
  assert.deepEqual(lib.watched.map(keyOf).sort(), [w1, w2].sort());
  assert.equal(lib.watched.find((i: any) => keyOf(i) === w2).myRating, 'up');
  assert.equal(lib.watched.find((i: any) => keyOf(i) === w1).myRating, null);
  assert.ok(lib.liked.every((i: any) => i.title && i.posterUrl !== undefined));
  ok('library returns liked and watched titles (with your rating) from the server');
  await call('POST', `${base}/hide`, { key: l1 }, libT);
  await call('POST', `${base}/hide`, { key: w1 }, libT);
  const lib2 = (await call('GET', `${base}/library`, undefined, libT)).body;
  assert.deepEqual(lib2.liked.map(keyOf), [l2]);
  assert.deepEqual(lib2.watched.map(keyOf), [w2]);
  assert.ok(lib2.known.includes(l1) && lib2.known.includes(w1), 'hidden swipes must stay known');
  const libProfile = (await call('GET', `${root}/users/lib_user`, undefined, aliceT)).body;
  assert.ok(!libProfile.liked.some((i: any) => keyOf(i) === l1), 'hidden title still on profile');
  const libDeck2 = (await post('/deck', { userId: 'lib_user', limit: 20 })).body.items.map((i: any) => i.key);
  assert.ok(!libDeck2.includes(l1) && !libDeck2.includes(w1), 'hidden title came back in the deck');
  await call('POST', `${base}/feedback`, { key: l1, action: 'like' }, libT);
  assert.ok((await call('GET', `${base}/library`, undefined, libT)).body.liked.some((i: any) => keyOf(i) === l1));
  ok('removing hides a title everywhere but keeps the swipe; liking it again brings it back');

  // 17. Search: find titles, add them, and let search weigh more in the taste profile
  const srT = await tokenFor('searcher');
  const sq = fakes.find(f => f.type === 'movie')!;
  const sr = (await call('GET', `${base}/search?q=${encodeURIComponent(`movie ${sq.id}`)}`, undefined, srT)).body.items as any[];
  assert.ok(sr.length > 0 && sr.every(i => i.type === 'movie' || i.type === 'tv'), 'search returned people or nothing');
  assert.equal(`${sr[0].type}:${sr[0].id}`, `movie:${sq.id}`);
  assert.equal(sr[0].myStatus, null);
  assert.equal((await call('GET', `${base}/search?q=a`, undefined, srT)).body.items.length, 0);
  assert.equal((await call('GET', `${base}/search?q=movie`)).status, 401);
  ok(`search finds titles by name (${sr.length} hits, people dropped, needs sign-in)`);
  await call('POST', `${base}/search/click`, { key: `movie:${sq.id}`, query: `movie ${sq.id}` }, srT);
  await call('POST', `${base}/feedback`, { key: `movie:${sq.id}`, action: 'like', source: 'search' }, srT);
  const sr2 = (await call('GET', `${base}/search?q=${encodeURIComponent(`movie ${sq.id}`)}`, undefined, srT)).body.items as any[];
  assert.equal(sr2[0].myStatus, 'saved');
  assert.ok((await call('GET', `${base}/library`, undefined, srT)).body.liked.some((i: any) => i.id === sq.id));
  assert.equal((await call('POST', `${base}/feedback`, { key: `movie:${sq.id}`, action: 'like', source: 'bogus' }, srT)).status, 400);
  ok('adding from search saves to the watchlist and shows as saved in results');

  {
    // Same history, once from Discover and once from Search: search moves the profile more.
    const now = Date.now();
    const [a, b] = fakes.filter(f => f.type === 'movie' && f.genres[0] !== fakes[0].genres[0]).slice(0, 2);
    const items = new Map<string, any>([a, b].map(f => [`movie:${f.id}`, {
      key: `movie:${f.id}`, id: f.id, type: 'movie', title: 'x', genres: f.genres, releaseDate: f.date,
      voteAverage: f.vote, voteCount: f.votes, popularity: f.pop, language: 'en', keywords: f.kw, cast: [],
    }]));
    const hist = (src: 'deck' | 'search') => [
      { userId: 'u', itemKey: `movie:${a.id}`, action: 'like' as const, ts: now - 2, source: src },
      { userId: 'u', itemKey: `movie:${b.id}`, action: 'like' as const, ts: now - 1 },
    ];
    const deckP = buildProfile('u', hist('deck'), items), searchP = buildProfile('u', hist('search'), items);
    const g = a.genres.find(x => !b.genres.includes(x)) ?? a.genres[0];
    assert.equal(deckP.recentPositives[0], `movie:${b.id}`);
    assert.equal(searchP.recentPositives[0], `movie:${a.id}`, 'search add should seed retrieval first');
    assert.ok(searchP.genre.get(g)!.pos > deckP.genre.get(g)!.pos);
    assert.ok((searchP.tasteVec.get(`g:${g}`) ?? 0) > (deckP.tasteVec.get(`g:${g}`) ?? 0));
    const clickP = buildProfile('u', hist('deck').slice(1), items, [], [{ userId: 'u', query: 'x', itemKey: `movie:${a.id}`, ts: now }]);
    assert.ok(clickP.recentPositives.includes(`movie:${a.id}`) && !clickP.seen.has(`movie:${a.id}`));
    ok(`search adds weigh ${SEARCH_BOOST}x and seed recs first; opened results nudge taste without counting as seen`);
  }
  const srDeck = (await post('/deck', { userId: 'searcher', limit: 20 })).body.items as any[];
  assert.ok(srDeck.some(i => i.reason === `Because you liked Movie ${sq.id}`), 'deck should build on the title added from search');
  ok('the next deck builds on what you added from search');

  // 18. Group watch parties
  {
    const P = `${root}/parties`;
    const FF = `${root}/follows`;
    const hostT = await tokenFor('party_host');
    const g = ['party_g1', 'party_g2', 'party_g3'];
    const gT = await Promise.all(g.map(tokenFor));
    const strangerT = await tokenFor('party_stranger');
    const deny = await call('POST', P, { usernames: ['party_g1'], mediaType: 'movie', providers: [8] }, hostT);
    assert.equal(deny.status, 403, 'invite without a follow should be refused');
    for (const n of g) await call('POST', FF, { username: n }, hostT);
    // g3 follows the host instead (either direction counts)
    await call('DELETE', `${FF}/party_g3`, undefined, hostT);
    await call('POST', FF, { username: 'party_host' }, gT[2]);
    const tooMany = await call('POST', P, { usernames: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'], mediaType: 'movie', providers: [8] }, hostT);
    assert.equal(tooMany.status, 400, 'more than 6 guests should be refused');

    // Taste: everyone saved one title; host + g1 saved another; g2 skipped one; g1 watched one.
    const movies = fakes.filter(f => f.type === 'movie');
    const pool = (await post('/deck', { userId: 'party_host', filters: { contentType: 'movie' }, limit: 12 })).body.items.map((i: any) => i.key) as string[];
    const providerOf = (k: string) => movies.find(f => `movie:${f.id}` === k)!.providers;
    const shared = pool.find(k => providerOf(k).length) ?? pool[0];
    const [twoOf, skipped, watched] = pool.filter(k => k !== shared);
    for (const t of [hostT, ...gT]) await call('POST', `${base}/feedback`, { key: shared, action: 'like' }, t);
    for (const t of [hostT, gT[0]]) await call('POST', `${base}/feedback`, { key: twoOf, action: 'like' }, t);
    await call('POST', `${base}/feedback`, { key: skipped, action: 'skip' }, gT[1]);
    await call('POST', `${base}/feedback`, { key: watched, action: 'seen_up' }, gT[0]);
    const hostProv = providerOf(shared).length ? providerOf(shared).slice(0, 1) : [movies.find(f => f.providers.length)!.providers[0]];

    const created = await call('POST', P, { usernames: ['party_g1', '@party_g2', 'party_g3'], mediaType: 'movie', providers: hostProv }, hostT);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.party.id;
    assert.equal(created.body.party.members.length, 4);
    for (const t of gT) {
      const mine = (await call('GET', P, undefined, t)).body.parties.find((p: any) => p.id === id);
      assert.ok(mine && mine.status === 'pending' && mine.myStatus === 'invited' && mine.host === '@party_host');
    }
    assert.equal((await call('GET', `${P}/${id}`, undefined, strangerT)).status, 404);
    assert.equal((await call('POST', `${P}/${id}/start`, {}, hostT)).status, 409, 'cannot start before anyone joins');
    ok('group invites: up to 6 people you follow or who follow you; everyone sees the invite; stays private');

    const guestProv = movies.map(f => f.providers[0]).find(x => x && !hostProv.includes(x))!;
    const a1 = await call('POST', `${P}/${id}/accept`, { providers: [guestProv] }, gT[0]);
    assert.equal(a1.body.party.status, 'pending', 'still waiting for the others');
    await call('POST', `${P}/${id}/decline`, {}, gT[2]);
    const a2 = await call('POST', `${P}/${id}/accept`, {}, gT[1]);
    assert.equal(a2.body.party.status, 'active', 'starts once everyone has answered');
    assert.equal(a2.body.party.joined, 3);
    assert.deepEqual([...a2.body.party.providers].sort(), [...hostProv, guestProv].sort());
    assert.ok(!(await call('GET', P, undefined, gT[2])).body.parties.some((p: any) => p.id === id), 'decliners no longer see it');
    const view = (await call('GET', `${P}/${id}`, undefined, gT[0])).body;
    const keys = view.items.map((i: any) => `${i.type}:${i.id}`) as string[];
    assert.equal(keys.length, 30, `deck size ${keys.length}`);
    assert.equal(new Set(keys).size, 30);
    assert.ok(view.items.every((i: any) => i.type === 'movie'));
    assert.ok(view.items.every((i: any) => i.streamingIds.some((x: number) => [...hostProv, guestProv].includes(x))), 'title not on the chosen services');
    assert.ok(!keys.includes(skipped) && !keys.includes(watched), "titles anyone skipped or watched must be left out");
    assert.equal(keys.indexOf(shared), 0, `title on everyone's watchlist should come first (at ${keys.indexOf(shared)})`);
    const hostView = (await call('GET', `${P}/${id}`, undefined, hostT)).body;
    assert.deepEqual(hostView.items.map((i: any) => `${i.type}:${i.id}`), keys, 'everyone sees the same deck');
    ok("starts when everyone has answered: one 30-title deck from all joined tastes (everyone's saved pick first)");

    const [hT, t1, t2] = [hostT, gT[0], gT[1]];
    const v = (t: string, key: string, vote: string) => call('POST', `${P}/${id}/vote`, { key, vote }, t);
    assert.equal((await v(hT, keys[0], 'yes')).body.match, false);
    assert.equal((await v(t1, keys[0], 'yes')).body.match, false, 'not a match until everyone joined says yes');
    assert.equal((await v(t2, keys[0], 'yes')).body.match, true);
    for (const t of [hT, t1]) await v(t, keys[1], 'yes');
    await v(t2, keys[1], 'no');
    assert.equal((await v(gT[2], keys[2], 'yes')).status, 403, 'people who declined cannot vote');
    assert.equal((await v(strangerT, keys[2], 'yes')).status, 404);
    const notInDeck = movies.map(f => `movie:${f.id}`).find(k => !keys.includes(k))!;
    assert.equal((await v(hT, notInDeck, 'yes')).status, 400);
    const counts = (await call('GET', `${P}/${id}`, undefined, t2)).body.yesCounts;
    assert.equal(counts[keys[0]], 3); assert.equal(counts[keys[1]], 2);
    let last: any;
    for (const t of [hT, t1, t2]) for (const k of keys.slice(2)) last = (await v(t, k, 'no')).body;
    assert.equal(last.party.status, 'done');
    assert.deepEqual(last.party.matches, [keys[0]]);
    assert.ok(last.party.members.filter((m: any) => m.status === 'joined').every((m: any) => m.progress === 30));
    assert.ok(!(await call('GET', P, undefined, hostT)).body.parties.some((p: any) => p.id === id), 'finished parties drop off the list');
    assert.equal((await call('GET', `${P}/${id}`, undefined, hostT)).body.party.status, 'done', 'but their results page still works');
    ok('match = every joined member says yes (shown at once); yes-counts rank the rest; done when all finish');

    // Host starts early; a late joiner can still swipe; the host can call it off.
    const p2 = (await call('POST', P, { usernames: ['party_g1', 'party_g2'], mediaType: 'movie', providers: [...hostProv, guestProv] }, hostT)).body.party;
    await call('POST', `${P}/${p2.id}/accept`, {}, gT[0]);
    const started = await call('POST', `${P}/${p2.id}/start`, {}, hostT);
    assert.equal(started.body.party.status, 'active');
    assert.equal(started.body.party.joined, 2);
    const late = await call('POST', `${P}/${p2.id}/accept`, {}, gT[1]);
    assert.equal(late.body.party.joined, 3);
    const k2 = (await call('GET', `${P}/${p2.id}`, undefined, gT[1])).body.items.map((it: any) => `${it.type}:${it.id}`)[0];
    assert.equal((await call('POST', `${P}/${p2.id}/vote`, { key: k2, vote: 'yes' }, gT[1])).status, 200, 'a late joiner can swipe');
    assert.equal((await call('DELETE', `${P}/${p2.id}`, undefined, hostT)).status, 200);
    assert.ok(!(await call('GET', P, undefined, gT[0])).body.parties.some((p: any) => p.id === p2.id), 'cancelled parties disappear');
    const p3 = (await call('POST', P, { usernames: ['party_g1'], mediaType: 'tv', providers: [8] }, hostT)).body.party;
    await call('POST', `${P}/${p3.id}/decline`, {}, gT[0]);
    assert.ok(!(await call('GET', P, undefined, hostT)).body.parties.some((p: any) => p.id === p3.id), 'everyone declined: called off');
    ok('host can start early; late joiners swipe the same deck; host can call it off; all-declined is cancelled');
  }

  // 19. Re-rating watched titles: thumbs and 1–5 stars
  {
    const rT = await tokenFor('rater');
    const d = (await post('/deck', { userId: 'rater', limit: 4 })).body.items as any[];
    const [w1, w2] = d.map(i => i.key as string);
    await call('POST', `${base}/feedback`, { key: w1, action: 'seen_up', impressionId: d[0].impressionId }, rT);
    const rate = (b: object) => call('POST', `${base}/rate`, b, rT);
    const wOf = async (k: string) => (await call('GET', `${base}/library`, undefined, rT)).body.watched.find((i: any) => `${i.type}:${i.id}` === k);
    assert.deepEqual((await rate({ key: w1, rating: 'down' })).body, { rating: 'down', stars: null });
    assert.equal((await wOf(w1)).myRating, 'down');
    assert.deepEqual((await rate({ key: w1, stars: 5 })).body, { rating: 'up', stars: 5 });
    const after = await wOf(w1);
    assert.equal(after.myRating, 'up'); assert.equal(after.myStars, 5);
    assert.deepEqual((await rate({ key: w1, rating: 'up' })).body, { rating: 'up', stars: 5 }, 'agreeing thumbs keep the stars');
    assert.deepEqual((await rate({ key: w1, rating: 'meh' })).body, { rating: 'meh', stars: null }, 'disagreeing thumbs clear the stars');
    assert.deepEqual((await rate({ key: w1, stars: 2 })).body, { rating: 'down', stars: 2 });
    assert.deepEqual((await rate({ key: w1, stars: null })).body, { rating: 'down', stars: null });
    assert.equal((await rate({ key: w1, stars: 6 })).status, 400);
    // Rating something not yet marked watched marks it watched.
    assert.deepEqual((await rate({ key: w2, stars: 4 })).body, { rating: 'up', stars: 4 });
    assert.equal((await wOf(w2)).myStars, 4);
    ok('watched titles can be re-rated (thumbs or 1–5 stars, kept consistent)');

    const now = Date.now();
    const f = fakes.find(x => x.type === 'movie')!;
    const items = new Map<string, any>([[`movie:${f.id}`, { key: `movie:${f.id}`, id: f.id, type: 'movie', title: 'x', genres: f.genres, releaseDate: f.date, voteAverage: f.vote, voteCount: f.votes, popularity: f.pop, language: 'en', keywords: f.kw, cast: [] }]]);
    const prof = (stars: number | null) => buildProfile('u', [{ userId: 'u', itemKey: `movie:${f.id}`, action: 'seen_up', ts: now, stars }], items);
    const g = `g:${f.genres[0]}`;
    const raw = (p: any) => p.tasteVec.get(g) ?? 0;
    assert.ok(raw(prof(5)) > 0 && raw(prof(1)) < 0, '5 stars pulls toward, 1 star pushes away');
    const kw = (p: any) => p.keywordW.get(f.kw[0]) ?? 0;
    assert.ok(kw(prof(5)) > kw(prof(4)) && kw(prof(4)) > kw(prof(3)), '5★ should count more than 4★, 4★ more than 3★');
    ok('stars refine the taste profile: 5★ > 4★ > … and 1★ pushes away');
  }

  // 13. Varied first decks + onboarding "show more"
  const firsts = await Promise.all(['fresh_a', 'fresh_b', 'fresh_c'].map(async n => (await post('/deck', { userId: n, limit: 15 })).body.items.map((i: any) => i.key) as string[]));
  const overlap = (a: string[], b: string[]) => a.filter(k => b.includes(k)).length / a.length;
  const sameTop5 = firsts.every(d => d.slice(0, 5).join() === firsts[0].slice(0, 5).join());
  console.log(`    first-deck overlap between new users: ${(overlap(firsts[0], firsts[1]) * 100).toFixed(0)}% / ${(overlap(firsts[0], firsts[2]) * 100).toFixed(0)}%`);
  assert.ok(!sameTop5, 'three new users got the same first five cards');
  ok('new users get different first decks');
  const freshT = await tokenFor('fresh_a');
  const page1 = (await call('GET', `${O}/titles?genres=35`, undefined, freshT)).body.items.map((i: any) => i.key) as string[];
  const page2 = (await call('GET', `${O}/titles?genres=35&exclude=${page1.join(',')}`, undefined, freshT)).body.items.map((i: any) => i.key) as string[];
  assert.equal(page2.length, 20);
  assert.ok(page2.every(k => !page1.includes(k)), 'show-more repeated titles');
  ok('onboarding "show more" brings 20 new titles, none repeated');

  console.log(`\n${passed} checks passed; ${tmdbCalls} fake TMDB calls`);
} finally {
  server.close();
}
