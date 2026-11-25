export type PartyStatus = 'pending' | 'active' | 'done' | 'declined' | 'cancelled';
export type PartyType = 'movie' | 'tv';

export type Party = {
  id: string;
  hostId: string;
  guestId: string;
  status: PartyStatus;
  mediaType: PartyType;
  providers: number[];
  deck: string[];
  createdAt: number;
  updatedAt: number;
};

export type Vote = { userId: string; itemKey: string; vote: 'yes' | 'no' };

export interface PartyStore {
  create(p: Party): Promise<Party>;
  get(id: string): Promise<Party | null>;
  /** Parties the user hosts or was invited to, newest first. */
  listFor(userId: string, limit: number): Promise<Party[]>;
  update(id: string, patch: Partial<Pick<Party, 'status' | 'providers' | 'deck'>>): Promise<Party | null>;
  vote(partyId: string, v: Vote): Promise<void>;
  votes(partyId: string): Promise<Vote[]>;
}

type Db = typeof import('@movee/db');

export async function createPgPartyStore(): Promise<PartyStore> {
  const { db, watchParties: P, watchPartyVotes: V, eq, or, desc } = (await import('@movee/db')) as Db;
  const toParty = (r: typeof P.$inferSelect): Party => ({
    id: r.id, hostId: r.hostId, guestId: r.guestId, status: r.status as PartyStatus,
    mediaType: r.mediaType as PartyType, providers: r.providers, deck: r.deck,
    createdAt: r.createdAt.getTime(), updatedAt: r.updatedAt.getTime(),
  });
  return {
    async create(p) {
      const [r] = await db.insert(P).values({
        id: p.id, hostId: p.hostId, guestId: p.guestId, status: p.status, mediaType: p.mediaType,
        providers: p.providers, deck: p.deck,
      }).returning();
      return toParty(r);
    },
    async get(id) {
      const [r] = await db.select().from(P).where(eq(P.id, id)).limit(1);
      return r ? toParty(r) : null;
    },
    async listFor(userId, limit) {
      const rows = await db.select().from(P).where(or(eq(P.hostId, userId), eq(P.guestId, userId)))
        .orderBy(desc(P.updatedAt)).limit(limit);
      return rows.map(toParty);
    },
    async update(id, patch) {
      const [r] = await db.update(P).set({ ...patch, updatedAt: new Date() }).where(eq(P.id, id)).returning();
      return r ? toParty(r) : null;
    },
    async vote(partyId, v) {
      await db.insert(V).values({ partyId, userId: v.userId, itemKey: v.itemKey, vote: v.vote })
        .onConflictDoUpdate({ target: [V.partyId, V.userId, V.itemKey], set: { vote: v.vote } });
    },
    async votes(partyId) {
      const rows = await db.select().from(V).where(eq(V.partyId, partyId));
      return rows.map(r => ({ userId: r.userId, itemKey: r.itemKey, vote: r.vote as 'yes' | 'no' }));
    },
  };
}

export function createMemoryPartyStore(): PartyStore {
  const parties = new Map<string, Party>();
  const votes = new Map<string, Map<string, Vote>>();
  return {
    async create(p) { parties.set(p.id, { ...p }); return { ...p }; },
    async get(id) { const p = parties.get(id); return p ? { ...p } : null; },
    async listFor(userId, limit) {
      return [...parties.values()].filter(p => p.hostId === userId || p.guestId === userId)
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map(p => ({ ...p }));
    },
    async update(id, patch) {
      const p = parties.get(id);
      if (!p) return null;
      Object.assign(p, patch, { updatedAt: Math.max(Date.now(), p.updatedAt + 1) });
      return { ...p };
    },
    async vote(partyId, v) {
      const m = votes.get(partyId) ?? new Map<string, Vote>();
      m.set(`${v.userId}\u0000${v.itemKey}`, v);
      votes.set(partyId, m);
    },
    async votes(partyId) { return [...(votes.get(partyId)?.values() ?? [])]; },
  };
}
