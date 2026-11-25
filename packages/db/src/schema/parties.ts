import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * Group watch parties: the host invites up to 6 people, picking Movies or TV and streaming services.
 * Invitees accept (adding their services) or decline. The party starts when everyone has answered
 * or the host starts it: one 30-title deck from every joined member's taste, swiped by all.
 * A title every joined member says yes to is a match.
 * status: pending (gathering) → active → done, or cancelled.
 */
export const watchParties = pgTable(
  "watch_parties",
  {
    id: text("id").primaryKey(), // uuid
    hostId: text("host_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // Two-person parties from before group parties; new parties list everyone in watch_party_members.
    guestId: text("guest_id").references(() => users.id, { onDelete: "cascade" }),
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

/** Who is in a party. role 'host' | 'guest'; status 'invited' | 'joined' | 'declined' | 'left'. */
export const watchPartyMembers = pgTable(
  "watch_party_members",
  {
    partyId: text("party_id").notNull().references(() => watchParties.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("guest"),
    status: text("status").notNull().default("invited"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.partyId, t.userId] }), index("watch_party_members_user").on(t.userId)],
);
