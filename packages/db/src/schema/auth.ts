import { boolean, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(), // uuid
  username: text("username").notNull(), // as typed, e.g. "@MovieFan"
  usernameLower: text("username_lower").notNull().unique(), // uniqueness is case-insensitive
  passwordHash: text("password_hash").notNull(),
  /** scrypt hash of the one-time recovery code (no email on accounts); null = none set. */
  recoveryCodeHash: text("recovery_code_hash"),
  hasSeenTutorial: boolean("has_seen_tutorial").notNull().default(false),
  /** Private accounts approve each follower before their likes/watches are visible. */
  isPrivate: boolean("is_private").notNull().default(false),
  /** TMDB movie genre ids picked during onboarding; seed the recommender's taste profile. */
  favoriteGenres: integer("favorite_genres").array().notNull().default([]),
  /** Set once the user finishes (or skips) onboarding. */
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Opaque bearer sessions. Only a SHA-256 of the token is stored. */
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

/**
 * Follows (table kept under its original name): userId follows friendId.
 * status 'pending' = waiting for a private account to approve; 'accepted' = can see activity.
 */
export const friends = pgTable(
  "friends",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    friendId: text("friend_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("accepted"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.friendId] })],
);
