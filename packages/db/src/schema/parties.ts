import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * Watch parties: the host invites a friend, picks Movies or TV and streaming services; once the
 * guest accepts (adding their services), both swipe the same 30-title deck. Both "yes" = a match.
 * status: pending → active → done, or declined / cancelled.
 */
export const watchParties = pgTable(
  "watch_parties",
  {
    id: text("id").primaryKey(), // uuid
    hostId: text("host_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    guestId: text("guest_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    mediaType: text("media_type").notNull(), // 'movie' | 'tv'
    providers: integer("providers").array().notNull().default([]),
    deck: jsonb("deck").$type<string[]>().notNull().default([]), // item keys, same order for both
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("watch_parties_host").on(t.hostId), index("watch_parties_guest").on(t.guestId)],
);

export const watchPartyVotes = pgTable(
  "watch_party_votes",
  {
    partyId: text("party_id").notNull().references(() => watchParties.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    vote: text("vote").notNull(), // 'yes' | 'no'
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.partyId, t.userId, t.itemKey] })],
);
