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
  const nd = (await post('/deck', { userId: 'newbie', limit: 20 })).body.items as any[];
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
