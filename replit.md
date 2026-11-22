# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Muse — Mobile App

Tinder-style movie & TV discovery app built with Expo/React Native.

- **Entry**: `artifacts/cineswipe/` — Expo app with 4 tabs
- **API**: `artifacts/api-server/` — Express proxy for TMDB API
- **Theme**: `#0A0A0F` bg, `#F5C518` gold accent, `#2ECC71` like, `#E74C3C` skip, `#7B68EE` watched
- **TMDB Auth**: Uses `TMDB_READ_ACCESS_TOKEN` (Bearer JWT) or falls back to `TMDB_API_KEY` (query param)
- **Key files**:
  - `artifacts/cineswipe/app/(tabs)/index.tsx` — Discover screen: server-ranked deck, prefetches the next page at ≤6 cards
  - `artifacts/cineswipe/components/SwipeCard.tsx` — Swipe gesture (drag or flick, haptics, imperative `swipe()` for buttons) + WebView YouTube trailer
  - `artifacts/cineswipe/components/FilterSheet.tsx` — content type, release era (Any/New/Oldies), streamers, genres, rating, runtime, in theaters
  - `artifacts/cineswipe/services/recs.ts` — recommender client: deck fetch, persisted feedback queue, history sync
  - `artifacts/cineswipe/services/tmdb.ts` — `MediaItem` type, trailers and detail lookups via the proxy
  - `artifacts/api-server/src/routes/tmdb.ts` — TMDB proxy (uses `router.use()` not wildcard route)
  - `artifacts/api-server/src/routes/recs.ts` — recommender API (see below)

### Recommender (`artifacts/api-server/src/recsys/`)

Server-side, multi-stage recommender modelled on NVIDIA's competition-winning recsys recipe
(retrieve → feature-engineer → GBDT rank → ensemble). The app no longer ranks on-device.

- **Flow per `/api/recs/deck` request** (`service.ts`):
  1. *Candidate generation* (`candidates.ts`): TMDB Discover lists for the exact filters
     (popular / top-rated / random deep "explore" pages), cross-user **co-visitation**
     (titles liked by the same people, cosine-normalised, `stats.ts`), TMDB **item-to-item**
     recommendations of recent likes, and **content-based** nearest neighbours over the cached
     catalog (genre/era/keyword/cast vectors, `profile.ts`).
  2. *Features* (`features.ts`): item stats, **count + target encoding** (smoothed like-rates per
     title and genre across all users), user stats, user×item affinities (per-user genre/decade/type
     like-rates, similarity to liked vs skipped titles, keyword/cast/provider affinity), and
     retrieval ranks. Bump `FEATURE_VERSION` whenever features change.
  3. *Ranking*: pass 1 on cheap metadata → fetch details (keywords, cast, runtime, US providers)
     for the shortlist → pass 2 exact. Model = blend of a dependency-free histogram **GBDT**
     (`gbdt.ts`) and logistic regression (`ranker.ts`); falls back to a hand-tuned prior.
  4. *Re-rank* (`rerank.ts`): MMR-style genre diversity + exploration slots for genres outside the
     user's top 3 (more diversity for new users = taste calibration).
- **Learning loop**: every served card's feature vector is logged (`recs_impressions`); swipes
  (`recs_interactions`) join to them for leak-free training rows. Retrains off-thread
  (`train-worker.ts`, separate esbuild entry) every 50 new rows / ≥10 min, with a **time-based
  validation split**; a new model is only adopted if it beats the prior's AUC. Status: `GET /api/recs/status`.
- **Endpoints**: `POST /api/recs/deck {userId, filters, exclude, limit}`, `/feedback {userId, key,
  action, impressionId}`, `/undo`, `/sync` (one-time import of on-device history), `GET /status`.
  Keys are `"movie:<id>"` / `"tv:<id>"`. Actions: like, skip, seen, seen_up, seen_meh, seen_down.
- **Filters** (`filters.ts`) are applied exactly: genres (movie ids mapped to TV ids), US streaming
  providers (flatrate), era (`new` = last 2 years, `classic` = before 2000), min rating, max runtime,
  in theaters. Every served card is re-checked against them.
- **DB**: tables in `lib/db/src/schema/recs.ts` — run `pnpm --filter @workspace/db run push`.
  Without `DATABASE_URL` the recommender uses an in-memory store (data lost on restart).
- **Checks**: `pnpm --filter @workspace/api-server run recsys:simulate` (synthetic users; prints
  like-rate vs baselines and validation AUCs) and `run recsys:e2e` (routes + fake TMDB, asserts filters).
- **Identity**: accounts are still device-local, so `userId` is the username (or a per-device
  guest id). Anyone can send swipes for any username — fine for recs, not for anything private.

### Critical Express 5 Note

**NEVER use `/{*path}` wildcard routes for proxying in Express 5.** Express 5's `{*path}` wildcard joins path segments with commas — e.g., `/movie/popular` becomes `/movie,popular`. Always use `router.use()` and read `req.path` for proxying.

**Always set `res.removeHeader('ETag')` + `res.set('Cache-Control', 'no-store')` on proxy responses** to prevent Express from returning 304 with empty bodies to the client.

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.
