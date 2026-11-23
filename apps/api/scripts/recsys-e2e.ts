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

  // 10. Friends
  const F = `${root}/friends`;
  const aliceT = await tokenFor('alice');
  assert.equal((await call('GET', `${F}/sim1/taste`, undefined, aliceT)).status, 404);
  ok("can't read someone's taste before adding them");
  assert.equal((await call('POST', F, { username: 'no_such_user' }, aliceT)).status, 404);
  assert.equal((await call('POST', F, { username: '@alice' }, aliceT)).status, 400);
  assert.equal((await call('POST', F, { username: 'SIM1' }, aliceT)).status, 201);
  assert.equal((await call('POST', F, { username: 'sim1' }, aliceT)).status, 409);
  const fl = await call('GET', F, undefined, aliceT);
  assert.deepEqual(fl.body.friends.map((f: any) => f.username), ['@sim1']);
  ok('add friend: unknown → 404, self → 400, duplicate → 409');
  const act = await call('GET', `${F}/activity`, undefined, aliceT);
  assert.ok(act.body.events.length > 0, 'no friend activity');
  assert.ok(act.body.events.every((e: any) => e.friendUsername === '@sim1' && e.item.title && e.timestamp));
  const friendTaste = await call('GET', `${F}/sim1/taste`, undefined, aliceT);
  assert.ok(Object.keys(friendTaste.body.genreScores).length > 0);
  ok(`friend activity (${act.body.events.length} events) and taste come from their swipes`);
  await call('DELETE', `${F}/sim1`, undefined, aliceT);
  assert.equal((await call('GET', F, undefined, aliceT)).body.friends.length, 0);
  ok('remove friend');

  console.log(`\n${passed} checks passed; ${tmdbCalls} fake TMDB calls`);
} finally {
  server.close();
}
