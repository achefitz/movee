# Movee: handoff

Everything someone (or a fresh Claude session) needs to pick up Movee: what it is, where it
lives, how it works, how to run it, and what's left. Code-level conventions for Claude are in
`CLAUDE.md`; setup steps for humans are in `README.md`. This file links them together.

_Last updated: 2026-11-24 (hosting added). Repo: https://github.com/achefitz/movee (private), branch `main`._

---

## 1. What Movee is

A swipe app for movies and TV. Right = like, left = skip, up = "seen it" (then rate it).

| Feature | Where |
|---|---|
| Server accounts: signup/login, sessions, rate-limited | `apps/api/src/routes/auth.ts`, `apps/api/src/auth/` |
| Onboarding after signup: favorite genres → pick favorites from 20 popular titles ("Show more titles" for 20 more) | `apps/mobile/app/onboarding.tsx`, `apps/api/src/routes/onboarding.ts` |
| Personalised deck from a two-stage recommender (NVIDIA-style) | `apps/api/src/recsys/` |
| Filters: movie/TV, release (Any / New = last 2 yrs / Oldies = pre-2000), US streamers, genres, min rating, runtime, in theaters | `apps/mobile/components/FilterSheet.tsx`, `apps/api/src/recsys/filters.ts` |
| Trailers autoplay (muted, TikTok-style) on the top card | `apps/mobile/components/WebTrailer.tsx`, `NativeYoutubePlayer.tsx` |
| Ratings: IMDb, Rotten Tomatoes, TMDB; Letterboxd link (movies) | `apps/api/src/ratings/`, `apps/mobile/components/Ratings.tsx`, `constants/links.ts` |
| "In theaters" / "Back in theaters" from real US release dates | `apps/api/src/recsys/theaters.ts` |
| Follows with public/private accounts, requests, approvals, activity feed, watch party | `apps/api/src/routes/follows.ts`, `apps/mobile/app/(tabs)/social.tsx` |
| Watchlist / watched, profile + "viewer type" label (Claude Haiku if `ANTHROPIC_API_KEY`) | `apps/mobile/app/(tabs)/watchlist.tsx`, `profile.tsx`, `apps/api/src/routes/viewer-type.ts` |

---

## 2. Where things are

| What | Location |
|---|---|
| Source of truth | GitHub `achefitz/movee`, `main` |
| Owner's working copy + running app | Mac, `~/movee` (Node 26 via Homebrew, pnpm 10.28, Postgres 16 via Homebrew service) |
| Owner's settings (not in git) | `~/movee/.env` (TMDB token, `DATABASE_URL=postgres://movee:movee@localhost:5432/movee`), `~/movee/apps/mobile/.env` (`EXPO_PUBLIC_API_URL=http://192.168.1.153:8080`, the Mac's Wi-Fi address) |
| Owner's database | Postgres on the Mac, database `movee`, user `movee` / password `movee` (local only) |
| Cloud dev environment (Claude Code on the web) | "Default" environment: TMDB token saved as a network secret for `api.themoviedb.org`; allowed hosts `image.tmdb.org`, `datasets.imdbws.com`, `query.wikidata.org` |

---

## 3. Architecture

```
 phone / browser ──▶ Expo app (apps/mobile, port 8081)
                          │  apiFetch() + Bearer session token
                          ▼
                  Express API (apps/api, port 8080) ──▶ TMDB API (titles, posters, trailers, providers, release dates)
                   │  auth · follows · onboarding     ──▶ IMDb ratings dataset (daily file, in memory)
                   │  recommender · TMDB proxy        ──▶ Wikidata SPARQL (Rotten Tomatoes scores)
                   ▼                                  ──▶ Anthropic API (optional, profile label)
            Postgres (packages/db, Drizzle)
```

pnpm workspace:
- `apps/mobile` (`@movee/mobile`): Expo SDK 54, React Native 0.81, expo-router. Tabs: Watchlist, Discover, Social, Profile; plus `login`, `signup`, `onboarding` screens.
- `apps/api` (`@movee/api`): Express 5, TypeScript, run with `tsx` in dev, esbuild for production (`build.mjs`, two entries: `index` and `train-worker`).
- `packages/db` (`@movee/db`): Drizzle schema + `pg` pool; re-exports drizzle helpers (import them from here, not `drizzle-orm`).

### API endpoints (all under `/api`; everything except `healthz`, `auth/signup`, `auth/login` needs `Authorization: Bearer <token>`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | health |
| POST | `/auth/signup` `{username, password}` | create account → `{token, user}` |
| POST | `/auth/login` | → `{token, user}` |
| POST | `/auth/logout` | end this session |
| GET / PATCH | `/auth/me` | current user; PATCH `{hasSeenTutorial?, isPrivate?}` |
| GET | `/onboarding/titles?genres=..&exclude=..` | 20 titles for the favorites grid |
| POST | `/onboarding` `{genres, favorites}` | save answers (empty = skip) |
| POST | `/recs/deck` `{filters, exclude, limit}` | ranked cards |
| POST | `/recs/feedback` `{key, action, impressionId}` | record a swipe |
| POST | `/recs/undo`, `/recs/sync` | undo; one-time upload of on-device history |
| GET | `/recs/status` | model + catalog status |
| GET | `/follows` | `{following, followers, requests}` |
| POST | `/follows` `{username}` | follow (pending if target is private) |
| DELETE | `/follows/:username` | unfollow / cancel request |
| POST | `/follows/requests/:username/approve` \| `/decline` | answer a request |
| DELETE | `/follows/followers/:username` | remove a follower |
| GET | `/follows/activity`, `/follows/:username/taste` | feed + watch-party taste (accepted follows only) |
| ANY | `/tmdb/*` | TMDB proxy (trailers, details) |
| POST | `/viewer-type` | profile label |

Item keys are `movie:<tmdbId>` / `tv:<tmdbId>`. Swipe actions: `like`, `skip`, `seen`, `seen_up`, `seen_meh`, `seen_down`.

---

## 4. Data (Postgres)

Schema: `packages/db/src/schema/auth.ts`, `recs.ts`. Apply changes with `pnpm db:push`.

| Table | Holds |
|---|---|
| `users` | id (uuid), username (`@name`, unique case-insensitively via `username_lower`), `password_hash` (scrypt), `has_seen_tutorial`, `favorite_genres` (int[]), `onboarded_at`, `is_private`, `created_at` |
| `sessions` | `token_hash` (SHA-256 of the bearer token; the token itself is never stored), `user_id`, `expires_at` (60-day sliding) |
| `friends` | follows: `user_id` follows `friend_id`, `status` `accepted`/`pending` (table name kept from the old friends model) |
| `recs_interactions` | one row per (user, title): latest swipe `action`, `impression_id`, time |
| `recs_impressions` | feature vector logged for every card served (training data) |
| `recs_media_items` | cached TMDB title data as JSON (incl. keywords, cast, providers, US theatrical dates, IMDb id, Rotten Tomatoes) |
| `recs_models` | trained ranker snapshots (newest loaded on boot) |

Still on the device (AsyncStorage, keyed by username): saved/watched lists, filters, activity log, mute preference. Session token: expo-secure-store on phones, localStorage on web.

### Seeing who signs up

- **Quick list:** `pnpm db:users` (newest 50; `pnpm db:users 200` for more): username, join time, onboarded, private, swipes, followers.
- **Browse everything:** `pnpm db:studio` opens Drizzle Studio in the browser (tables, filters, editing; be careful editing).
- **SQL:** `psql postgres://movee:movee@localhost:5432/movee`, then for example:
  ```sql
  select username, created_at, onboarded_at is not null as onboarded, is_private
  from users order by created_at desc limit 50;

  select date_trunc('day', created_at) as day, count(*) from users group by 1 order by 1 desc;
  ```
- A desktop app such as Postico or TablePlus works with the same connection details.

---

## 5. The recommender (`apps/api/src/recsys/`)

Per deck request (`service.ts → deck()`):

1. **Candidates** (`candidates.ts`): TMDB Discover lists matching the filters (popular, top-rated, random deeper "explore" pages; `catalog.ts`), "people who liked X also liked" co-visitation across all users (`stats.ts`), TMDB "similar titles" of recent likes, and content nearest neighbours (genre/decade/keyword/cast vectors, `profile.ts`).
2. **Features** (`features.ts`, ~45 per candidate): item stats; count + target encodings (smoothed like-rates per title and genre); user stats; user×item affinities (genre/decade/type like-rates, similarity to liked vs skipped, keyword/cast/provider overlap); retrieval ranks. **Bump `FEATURE_VERSION` when changing features.**
3. **Rank**: pass 1 on list metadata → fetch details for the shortlist → pass 2. Model: histogram GBDT (`gbdt.ts`, dependency-free) blended with logistic regression (`ranker.ts`). A hand-tuned prior is used until a trained model beats it on a time-based validation split. Retrains off-thread (`train-worker.ts`) every 50 new swipes / ≥10 min.
4. **Re-rank** (`rerank.ts`): genre variety plus "Something different" exploration slots.

New accounts: onboarding genres seed the taste profile (2 pseudo-likes each), picked favorites are saved as `seen_up` swipes, and scores get a proportional random nudge that fades out over the first 10 swipes so first decks differ between users.

Checks: `pnpm test` (whole API against a fake TMDB/IMDb/Wikidata, 43 checks) and `pnpm --filter @movee/api run recsys:simulate` (synthetic users; like-rate vs baselines).

---

## 6. External services, keys, licences

| Service | Used for | Key | Notes |
|---|---|---|---|
| TMDB | everything about titles | `TMDB_READ_ACCESS_TOKEN` in `.env` | Attribution in README. |
| IMDb non-commercial datasets | IMDb rating + votes | none | `title.ratings.tsv.gz`, downloaded daily, cached at `IMDB_CACHE_FILE` or the temp dir. **Personal / non-commercial use only**: a commercial launch needs an IMDb licence. |
| Wikidata | Rotten Tomatoes Tomatometer + RT page | none | CC0. Movies well covered; TV usually per season, so mostly missing. |
| Letterboxd | link only (`letterboxd.com/tmdb/<id>`) | none | Their API needs approval, and scraping is against their terms, so there's no Letterboxd rating. |
| YouTube | trailers (embed) | none | |
| Anthropic | profile "viewer type" | `ANTHROPIC_API_KEY` (optional) | Model `claude-haiku-5-5`; falls back to a rule-based label. |

---

## 7. Running it (on the Mac)

```bash
cd ~/movee && pnpm install
```

```bash
pnpm db:push        # after pulling schema changes
```

```bash
pnpm dev            # API on :8080 + Expo; press w for web
```

- Phone on the same Wi-Fi: open `http://192.168.1.153:8081` (browser) or `exp://192.168.1.153:8081` (Expo Go, only if Expo Go supports SDK 54). If the Mac's address changes: `ipconfig getifaddr en0`, update `apps/mobile/.env`, restart Expo.
- Postgres runs as a Homebrew service (`brew services list`); it starts on login.
- Servers that Claude starts on the Mac stop after 30 minutes; `pnpm dev` in your own Terminal runs as long as you like.

---

## 8. Letting friends test it

Today it only runs on the Mac, so only devices on your home Wi-Fi can reach it. Options, from quickest to most permanent:

1. **Same Wi-Fi:** friends at your place open `http://192.168.1.153:8081`.
2. **Temporary public link from the Mac (Cloudflare Tunnel, free):** `brew install cloudflared`, then run `cloudflared tunnel --url http://localhost:8080` (note the API URL it prints), put that URL in `apps/mobile/.env` as `EXPO_PUBLIC_API_URL`, restart Expo, and run `cloudflared tunnel --url http://localhost:8081` for the app link to share. The links change every run, the Mac must stay awake, and it's the dev server (slow first load). Fine for a few friends for an evening.
3. **Hosting (set up): Render + Neon.** `render.yaml` at the repo root is a Render Blueprint with
   two services: `movee-api` (builds the API, runs `db:push` against Neon, starts
   `apps/api/dist/index.mjs`; health check `/api/healthz`) and `movee-web` (static Expo web export,
   all paths rewritten to `index.html`). Both deploy automatically on every push to `main`.

   One-time setup:
   1. **Neon** (neon.tech, sign in with GitHub): new project `movee`, region AWS US West 2 (Oregon,
      next to Render's Oregon region). From **Connect**, turn **Connection pooling off** and copy the
      connection string (`postgresql://…neon.tech/neondb?sslmode=require…`).
   2. **Render** (render.com, sign in with GitHub): **New → Blueprint**, give Render access to
      `achefitz/movee`, pick it. Render reads `render.yaml` and asks for:
      - `TMDB_READ_ACCESS_TOKEN`: same token as in `~/movee/.env`
      - `DATABASE_URL`: the Neon string
      - `ANTHROPIC_API_KEY`: optional, leave empty
      - `EXPO_PUBLIC_API_URL`: `https://movee-api.onrender.com` (if Render gives the API a different
        URL, set this to it on `movee-web` → Environment and redeploy `movee-web`)
   3. **Apply.** First deploy takes ~5 minutes. Share the `movee-web` URL with friends.

   Free tier notes: the API sleeps after 15 minutes without traffic, so the first request after a
   break takes about a minute (Render's Starter plan, ~$7/mo, keeps it awake). Neon's free tier has
   0.5 GB of storage, which is plenty for now. Memory: the API uses ~260 MB with IMDb ratings
   loaded (free instance: 512 MB).

   Seeing sign-ups on the hosted database: `DATABASE_URL='<neon string>' pnpm db:users` or
   `DATABASE_URL='<neon string>' pnpm db:studio` from `~/movee`, or Neon's own SQL editor / tables view.

   Native app later: EAS Build → TestFlight (needs an Apple Developer account) / an Android APK.

Before inviting strangers: set real hosting secrets, review the IMDb licence point above, and consider password reset (needs email on accounts).

---

## 9. How changes have been delivered

Work happens in a Claude Code cloud session on a checkout of the repo, is tested there (typecheck, `pnpm test`, browser tests with Playwright against real TMDB), committed to `main` and pushed. On the Mac: `git fetch`, review the exact commit id and changed files, then `git merge --ff-only <commit>`, `pnpm install` / `pnpm db:push` if needed, restart. The Mac copy has had no local edits so far, only untracked `.env` files.

---

## 10. Decisions and gotchas

- Express 5: no `/{*path}` wildcards for proxying; use `router.use()` + `req.path`.
- Postgres upserts can't touch the same key twice in one statement; dedupe batches (`store.ts upsertItems`). The in-memory store doesn't catch this.
- In a cloud sandbox behind an HTTPS proxy, start the API with `NODE_USE_ENV_PROXY=1` (Node's fetch ignores `HTTPS_PROXY`).
- On web, the swipe card also handles mouse events; any button inside a card needs `accessibilityRole="button"` or a tap on it also opens the details sheet.
- "In theaters" is computed when served from TMDB `release_dates` (US types 2/3): new = first US run ≤60 days ago and film <1 year old; older films back in theaters ≤30 days = "Back in theaters". Never stored. (Old rows still contain a stale `inTheaters` field; it is ignored.)
- Trailers start muted (browsers block sound on autoplay); unmuting is remembered (`movee.trailerMuted`).
- Mobile native deps must match Expo SDK 54 (`pnpm exec expo install <pkg>`).

---

## 11. Known limitations / next steps

- **Hosting**: `render.yaml` + Neon are set up (section 8); consider Starter plan to avoid cold starts.
- **Password reset / email**: accounts have no email yet.
- **Expo Go** may not support SDK 54 any more; the web version works on phones. Upgrade Expo or build a development client with Xcode.
- **Login rate limits are in memory** (per server process); fine for one server.
- **Watchlist items are snapshots**: old saved cards don't gain new fields (ratings, theater labels).
- **Rotten Tomatoes for TV** is mostly missing (Wikidata records seasons).
- **Letterboxd rating** would need Letterboxd API approval.
- **No push notifications** for follow requests yet; requests show in the Social tab.

---

## 12. History (what was built, in order)

1. Imported the Replit project; built the server-side recommender (candidates, features, GBDT+LR, re-rank), New/Oldie filter, smoother swiping.
2. Removed Replit; standalone pnpm workspace; real TMDB data; Postgres; renamed Muse → Movee.
3. Server accounts (scrypt, bearer sessions, rate limits) and server-side friends.
4. Trailer autoplay, Letterboxd links, onboarding.
5. IMDb + Rotten Tomatoes ratings; correct "in theaters" / "back in theaters".
6. Varied first decks, "Show more titles" in onboarding, follows with public/private accounts and approvals, `db:users` / `db:studio`, this handoff doc.
7. Hosted on Render + Neon (`render.yaml`).
8. Age-rating filter (G … NC-17, TV mapped to TV-G … TV-MA) with a badge on cards; other users' profiles (`/user/<name>`, private accounts locked until approved) reachable from Social; Profile tiles open lists of liked movies / TV / watched; fixed the ✕ remove button on web (`utils/confirm.ts`).
9. Watchlist and Watched are stored on the server and load on any device (`/api/recs/library`, removals via `/api/recs/hide` + `recs_interactions.hidden`); "Seen" saves before the rating prompt.
10. Trailer shown as a 2:1 strip instead of cropped to fill; less top padding on web Discover; tapping any title (Watchlist, Profile lists, user profiles, activity feed) opens its details.
