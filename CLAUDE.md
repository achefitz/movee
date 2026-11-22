# Muse

Tinder-style movie & TV discovery app. pnpm workspace, TypeScript throughout.
Setup and commands for humans are in `README.md`.

## Layout

- `apps/mobile` (`@muse/mobile`): Expo SDK 54 / React Native 0.81, expo-router. 4 tabs.
- `apps/api` (`@muse/api`): Express 5. `src/index.ts` loads the repo-root `.env`, default port 8080.
- `packages/db` (`@muse/db`): Drizzle schema (`src/schema/recs.ts`) + `pg` pool. Also re-exports the
  drizzle query helpers (`and`, `eq`, `sql`, …): import them from `@muse/db`, not `drizzle-orm`,
  so there's a single drizzle copy.

## Commands

- `pnpm dev`: API + Expo together (`dev.mjs`). `pnpm dev:api` / `pnpm dev:mobile` separately.
- `pnpm typecheck`: all packages. Must pass before committing.
- `pnpm test`: `apps/api/scripts/recsys-e2e.ts`; routes + recommender against a fake TMDB, in-memory store.
- `pnpm --filter @muse/api run recsys:simulate`: offline simulation with synthetic users.
- `pnpm db:push`: apply schema changes (needs `DATABASE_URL`). Without `DATABASE_URL` the API uses
  an in-memory store.
- Mobile deps must match Expo SDK 54: add native packages with `pnpm exec expo install <pkg>` in
  `apps/mobile`, and check with `pnpm exec expo install --check`.

## Environment

- `TMDB_READ_ACCESS_TOKEN` (or `TMDB_API_KEY`) in `.env`; required for real data.
- `DATABASE_URL`: optional; Postgres for swipes, impressions, cached titles, trained models.
- `ANTHROPIC_API_KEY`: optional; Profile tab's "viewer type" label via Claude Haiku
  (`apps/api/src/routes/viewer-type.ts`), rule-based label otherwise.
- `apps/mobile`: `EXPO_PUBLIC_API_URL` (default `http://localhost:8080`; use a LAN IP on a phone).

## Design

- **Theme**: `#0A0A0F` bg, `#F5C518` gold accent, `#2ECC71` like, `#E74C3C` skip, `#7B68EE` watched.
- **Accounts are device-local** (AsyncStorage), so the recommender's `userId` is the username or a
  per-device guest id. Anyone can send swipes for any username: fine for recs, not for anything private.

### Mobile key files

- `app/(tabs)/index.tsx`: Discover. Server-ranked deck; fetches the next page at ≤6 cards left;
  real next poster rendered under the top card.
- `components/SwipeCard.tsx`: drag or flick to swipe, haptics, imperative `swipe()` used by the
  buttons. On web both PanResponder and mouse handlers see a gesture; `claimRelease()` makes sure
  only one handles the release.
- `components/FilterSheet.tsx`: content type, Release (Any / New = last 2 yrs / Oldies = pre-2000),
  streamers, genres, rating, runtime, in theaters.
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
