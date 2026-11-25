# Movee

Tinder-style movie & TV discovery app. pnpm workspace, TypeScript throughout.
Setup and commands for humans are in `README.md`; the full handoff (data, hosting, history,
open items) is `docs/HANDOFF.md`.

## Layout

- `apps/mobile` (`@movee/mobile`): Expo SDK 54 / React Native 0.81, expo-router. 4 tabs.
- `apps/api` (`@movee/api`): Express 5. `src/index.ts` loads the repo-root `.env`, default port 8080.
- `packages/db` (`@movee/db`): Drizzle schema (`src/schema/`: `auth.ts` users/sessions/friends, `recs.ts` recommender) + `pg` pool. Also re-exports the
  drizzle query helpers (`and`, `eq`, `sql`, …): import them from `@movee/db`, not `drizzle-orm`,
  so there's a single drizzle copy.

## Commands

- `pnpm dev`: API + Expo together (`dev.mjs`). `pnpm dev:api` / `pnpm dev:mobile` separately.
- `pnpm typecheck`: all packages. Must pass before committing.
- `pnpm test`: `apps/api/scripts/recsys-e2e.ts`; the whole API (accounts, friends, recommender) against a
  fake TMDB with in-memory stores.
- `pnpm --filter @movee/api run recsys:simulate`: offline simulation with synthetic users.
- Hosting: `render.yaml` (Render Blueprint: `movee-api` web service + `movee-web` static site), Neon
  Postgres via `DATABASE_URL`. The API build runs `db:push`, so schema changes deploy with the code.
  Pushing to `main` redeploys both.
- `pnpm db:users` (newest sign-ups) / `pnpm db:studio` (Drizzle Studio in the browser).
- `pnpm db:push`: apply schema changes (needs `DATABASE_URL`). Without `DATABASE_URL` the API uses
  an in-memory store.
- Mobile deps must match Expo SDK 54: add native packages with `pnpm exec expo install <pkg>` in
  `apps/mobile`, and check with `pnpm exec expo install --check`.

## Environment

- `TMDB_READ_ACCESS_TOKEN` (or `TMDB_API_KEY`) in `.env`; required for real data.
- `DATABASE_URL`: Postgres for accounts, sessions, friends, swipes, cached titles, trained models.
  Optional for trying things out; without it everything is in memory and lost on restart.
- `ANTHROPIC_API_KEY`: optional; Profile tab's "viewer type" label via Claude Haiku
  (`apps/api/src/routes/viewer-type.ts`), rule-based label otherwise.
- `TRUST_PROXY`: set behind a reverse proxy so rate limits see real client IPs. `SIGNUP_LIMIT_PER_HOUR`
  (default 10 per IP).
- `apps/mobile`: `EXPO_PUBLIC_API_URL` (default `http://localhost:8080`; use a LAN IP on a phone).

## Design

- **Theme**: `#0A0A0F` bg, `#F5C518` gold accent, `#2ECC71` like, `#E74C3C` skip, `#7B68EE` watched.
- **Accounts live on the server** (`apps/api/src/auth/`, `routes/auth.ts`). Passwords: scrypt
  (`auth/crypto.ts`). Sessions: random bearer token; only its SHA-256 is stored (`sessions` table),
  60-day sliding expiry. Login/signup are rate-limited per IP and per username (`auth/rateLimit.ts`,
  in-memory, so per instance). Every route except `/api/healthz` and `/api/auth/{signup,login}`
  requires `requireAuth` (`auth/middleware.ts`); handlers use `req.user.id`, never a user id from the
  request body.
- **App side**: `services/api.ts` holds the token (expo-secure-store on phones, localStorage on web)
  and `apiFetch()` attaches it; any 401 signs the user out via `onUnauthorized`. Use `apiFetch` for
  every API call. `context/AuthContext.tsx` moves old on-device accounts (`cs:accounts`) to the
  server on their first login.
- **Follows** (`routes/follows.ts`; table still named `friends`, with `status`): following a public
  account is accepted at once; following a private one (`users.is_private`, toggled via PATCH
  `/api/auth/me {isPrivate}`) creates a `pending` request the owner approves/declines; going public
  accepts all pending. Activity feed and watch-party taste are only for `accepted` follows.
- **Cold start**: `service.deck()` multiplies scores by a random factor that fades out over the first
  10 swipes (varied first decks); onboarding titles are shuffled and take `exclude` for "Show more".
- **Watchlist / Watched follow the account**: on load, `AppContext` replaces its AsyncStorage copy
  with `GET /api/recs/library` (liked + watched with `myRating`, newest first, and `known` keys);
  local items the server doesn't know yet (still queued) are kept. Removing a title queues
  `POST /api/recs/hide` (`recs_interactions.hidden`): gone from lists, profiles and feeds on every
  device, but the swipe still trains the recommender; a new swipe on it un-hides it. "Seen" is saved
  immediately; the "How was it?" prompt only adds the rating. Filters etc. stay local, keyed by username.

### Mobile key files

- `app/(tabs)/index.tsx`: Discover. Server-ranked deck; fetches the next page at ≤6 cards left;
  real next poster rendered under the top card.
- `components/SwipeCard.tsx`: drag or flick to swipe, haptics, imperative `swipe()` used by the
  buttons. On web both PanResponder and mouse handlers see a gesture; `claimRelease()` makes sure
  only one handles the release.
- Trailers autoplay (muted, looping) on the top card only, in a full-width 2:1 strip above the title
  over a blurred, dimmed poster (video zoomed `TRAILER_ZOOM` to trim letterbox bars; not cropped to
  fill the card, which blew up on-screen text). The reason chip hides and the title shrinks while it plays: `components/WebTrailer.tsx`
  (YouTube iframe + postMessage API: fades in on "playing", hides on error) and
  `components/NativeYoutubePlayer.tsx`. The video layer is `pointerEvents="none"` so swipes still work;
  the card's mouse fallback ignores presses inside `[role="button"]`, so give any touchable on the
  card `accessibilityRole="button"`. Mute preference lives in Discover (`movee.trailerMuted`).
- `app/onboarding.tsx`: after signup (gate in `app/_layout.tsx` while `user.onboarded === false`):
  favorite genres, then 20 popular titles to pick favorites. Server: `routes/onboarding.ts`; genres are
  stored on the user and seed the taste profile (`buildProfile(..., favoriteGenres)`); picked titles are
  saved as `seen_up` swipes.
- Ratings (`components/Ratings.tsx`): IMDb from IMDb's official daily dataset
  (`apps/api/src/ratings/imdb.ts`: downloads `title.ratings.tsv.gz` once a day, cached on disk at
  `IMDB_CACHE_FILE` or the temp dir, kept in memory; IMDb allows it for personal/non-commercial use) and
  the Rotten Tomatoes Tomatometer from Wikidata (`ratings/rottenTomatoes.ts`, SPARQL by IMDb id, latest
  Tomatometer statement; cached on the catalog item for 14 days). IMDb ids come from TMDB `external_ids`.
  No logos, plain labels.
- In theaters (`apps/api/src/recsys/theaters.ts`): from TMDB `release_dates` (US types 2/3), computed
  when served, never stored. 'now' = first US theatrical run ≤60 days ago and the film is <1 year old;
  'rerelease' = an older film back in US theaters in the last 30 days (shown as "BACK IN THEATERS").
- Letterboxd: `constants/links.ts` (`letterboxd.com/tmdb/<id>`, movies only; Letterboxd has no TV).
  Shown on movie cards and in the details sheet. No Letterboxd rating: their API needs approval.
- `components/FilterSheet.tsx`: content type, Release (Any / New = last 2 yrs / Oldies = pre-2000),
  age rating, streamers, genres, rating, runtime, in theaters.
- Age rating (`apps/api/src/ratings/certification.ts`): US MPA rating from TMDB `release_dates` (movies)
  or `content_ratings` (TV). Picks are movie levels; TV maps G→TV-Y/TV-Y7/TV-G, PG→TV-PG, PG-13→TV-14,
  R/NC-17→TV-MA. Unrated titles are excluded when the filter is on. Badge on cards and details.
- Profiles: `app/user/[username].tsx` + `GET /api/users/:username` (likes/watches visible if public,
  your own, or you're an approved follower). Usernames in the Social tab open it. Profile tab's
  Movies / TV Shows / Watched tiles open a `TitleGrid` sheet.
- Tapping a title anywhere (Watchlist rows, `TitleGrid` in Profile lists and user profiles, the
  Social activity feed) opens `MediaDetailModal`; render it inside any parent `Modal` so it stacks.
  Your own activity feed is rebuilt from `/api/recs/library` like the lists.
- **Search tab** (`app/(tabs)/search.tsx`): `GET /api/recs/search?q=` (TMDB `/search/multi`, people dropped,
  cached 10 min, `catalog.search`). Bookmark = add to Watchlist, double-check = Seen (toggles); both go
  through `addFromSearch` → `/feedback` with `source: 'search'` (`recs_interactions.source`). Opening a
  result logs `POST /api/recs/search/click` (`recs_search_clicks`). Upweighting (`profile.ts`,
  `candidates.ts`, `service.ts`): search adds weigh `SEARCH_BOOST`× in the taste profile plus an extra
  genre like and seed retrieval first; opened results nudge taste at half weight without counting as
  seen; neighbours of searched titles get `SEARCH_SEED_BOOST` in co-visitation/i2i and a score lift
  (`SEARCH_LIFT`, half-life 14 days) that is not a feature, so training data is unaffected.
- **Watch parties** (`routes/parties.ts`, `parties/store.ts`, tables `watch_parties` + `watch_party_votes`):
  host invites someone they follow or who follows them, picking Movies/TV and streaming services
  (`components/WatchParties.tsx` in Social, prefilled from Discover's streaming filter). Guest accepts
  (may add services; the host's stay) → `service.partyDeck()` builds one 30-title deck: both profiles,
  candidates retrieved for either, each scored for both and combined by geometric mean, titles on
  either Watchlist boosted (both = most), anything either watched/skipped left out, exact type +
  streaming filter, genre re-rank. Both swipe it in `app/party/[id].tsx` (SwipeCard with trailers,
  no swipe-up); both yes = match (shown at once). Only matches are revealed. Social polls every 6 s
  (no push notifications). Party votes don't feed the personal recommender.
- The TMDB rating is not shown anywhere (IMDb / Rotten Tomatoes only); the min-rating filter still uses it.
- On web, `Alert.alert` with buttons does nothing: use `utils/confirm.ts` `confirmAction()`.
- `services/recs.ts`: deck fetch, persisted feedback queue (swipes survive offline), one-time sync
  of on-device history.

### Recommender (`apps/api/src/recsys/`)

Two-stage pipeline following NVIDIA's winning recsys approach. Per `POST /api/recs/deck` (`service.ts`):

1. **Candidates** (`candidates.ts`): TMDB Discover for the exact filters (popular / top-rated / random
   deep "explore" pages, `catalog.ts`), cross-user co-visitation (`stats.ts`), TMDB item-to-item
   recommendations of recent likes, content nearest neighbours over cached titles (`profile.ts`).
2. **Features** (`features.ts`): item stats, count + target encodings (smoothed like-rates per title
   and genre), user stats, user×item affinities, retrieval ranks. **Bump `FEATURE_VERSION` when
   features change.**
3. **Rank**: pass 1 on list metadata → fetch details (keywords, cast, runtime, US providers) for the
   shortlist → pass 2. Model = histogram GBDT (`gbdt.ts`, dependency-free) blended with logistic
   regression (`ranker.ts`); hand-tuned prior until a trained model beats it.
4. **Re-rank** (`rerank.ts`): genre diversity + exploration slots for genres outside the user's top 3.

Learning loop: each served card's features are logged (`recs_impressions`) and joined to swipes
(`recs_interactions`) for training. Retrains off-thread (`train-worker.ts`, a separate esbuild entry)
every 50 new rows / ≥10 min, time-based validation split. `GET /api/recs/status` shows the model.

Filters (`filters.ts`) are exact and every served card is re-checked: movie genre ids map to TV ids;
streaming = US flatrate providers.

## Gotchas

- **Express 5**: never use `/{*path}` wildcards for proxying (segments get joined with commas). Use
  `router.use()` and `req.path` (see `routes/tmdb.ts`). Proxy responses set `Cache-Control: no-store`
  and drop `ETag`.
- **Postgres upserts**: a single `INSERT … ON CONFLICT DO UPDATE` can't touch the same key twice;
  dedupe batches (see `store.ts` `upsertItems`). The in-memory store doesn't catch this.
- **Behind an HTTPS proxy** (e.g. a cloud sandbox), Node's built-in `fetch` ignores `HTTPS_PROXY`:
  start the API with `NODE_USE_ENV_PROXY=1`.
