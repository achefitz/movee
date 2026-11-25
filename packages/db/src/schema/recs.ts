import { boolean, index, integer, jsonb, pgTable, real, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** TMDB metadata cache (one row per movie/show), shared by every recommender stage. */
export const recsMediaItems = pgTable("recs_media_items", {
  key: text("key").primaryKey(), // "movie:603"
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** One row per (user, title): the user's latest swipe on it. */
export const recsInteractions = pgTable(
  "recs_interactions",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    itemKey: text("item_key").notNull(),
    action: text("action").notNull(), // like | skip | seen | seen_up | seen_meh | seen_down
    impressionId: text("impression_id"),
    // Removed from the user's Watchlist / Watched list. The swipe still counts for recommendations.
    hidden: boolean("hidden").default(false).notNull(),
    // Where the swipe came from: 'deck' (Discover) or 'search' (added from the Search tab,
    // a deliberate pick that the taste profile weighs more).
    source: text("source").default("deck").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("recs_interactions_user_item").on(t.userId, t.itemKey),
    index("recs_interactions_created").on(t.createdAt),
  ],
);

/** Search results the user opened (without necessarily adding them): a light interest signal. */
export const recsSearchClicks = pgTable(
  "recs_search_clicks",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    query: text("query").notNull(),
    itemKey: text("item_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("recs_search_clicks_user").on(t.userId, t.createdAt)],
);

/**
 * Feature vectors exactly as the ranker saw them when the card was served.
 * Joined with interactions to build leak-free training rows.
 */
export const recsImpressions = pgTable(
  "recs_impressions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    itemKey: text("item_key").notNull(),
    featureVersion: integer("feature_version").notNull(),
    features: real("features").array().notNull(),
    position: integer("position").notNull(),
    score: real("score").notNull(),
    servedAt: timestamp("served_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("recs_impressions_user_item").on(t.userId, t.itemKey)],
);

/** Trained ranker snapshots; the newest is loaded on boot. */
export const recsModels = pgTable("recs_models", {
  id: serial("id").primaryKey(),
  featureVersion: integer("feature_version").notNull(),
  model: jsonb("model").notNull(),
  metrics: jsonb("metrics").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
