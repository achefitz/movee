export type PartyStatus = 'pending' | 'active' | 'done' | 'declined' | 'cancelled';
export type PartyType = 'movie' | 'tv';
export type MemberStatus = 'invited' | 'joined' | 'declined' | 'left';
export type Member = { userId: string; role: 'host' | 'guest'; status: MemberStatus };

export type Party = {
  id: string;
  hostId: string;
  status: PartyStatus;
  mediaType: PartyType;
  providers: number[];
  deck: string[];
  members: Member[];
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
  setMember(partyId: string, userId: string, status: MemberStatus): Promise<void>;
  vote(partyId: string, v: Vote): Promise<void>;
  votes(partyId: string): Promise<Vote[]>;
}

/** Two-person parties made before group parties had no member rows: derive them. */
function legacyMembers(hostId: string, guestId: string | null, status: string): Member[] {
  if (!guestId) return [{ userId: hostId, role: 'host', status: 'joined' }];
  const g: MemberStatus = status === 'declined' ? 'declined' : status === 'active' || status === 'done' ? 'joined' : 'invited';
  return [{ userId: hostId, role: 'host', status: 'joined' }, { userId: guestId, role: 'guest', status: g }];
}

type Db = typeof import('@movee/db');

export async function createPgPartyStore(): Promise<PartyStore> {
  const { db, watchParties: P, watchPartyMembers: M, watchPartyVotes: V, eq, or, desc, inArray, and } = (await import('@movee/db')) as Db;

  async function withMembers(rows: Array<typeof P.$inferSelect>): Promise<Party[]> {
    if (!rows.length) return [];
    const ms = await db.select().from(M).where(inArray(M.partyId, rows.map(r => r.id)));
    return rows.map(r => {
      const own = ms.filter(m => m.partyId === r.id)
        .map(m => ({ userId: m.userId, role: m.role as Member['role'], status: m.status as MemberStatus }));
      return {
        id: r.id, hostId: r.hostId, status: r.status as PartyStatus, mediaType: r.mediaType as PartyType,
        providers: r.providers, deck: r.deck,
        members: own.length ? own : legacyMembers(r.hostId, r.guestId, r.status),
        createdAt: r.createdAt.getTime(), updatedAt: r.updatedAt.getTime(),
      };
    });
  }

  return {
    async create(p) {
      const [r] = await db.insert(P).values({
        id: p.id, hostId: p.hostId, status: p.status, mediaType: p.mediaType, providers: p.providers, deck: p.deck,
      }).returning();
      await db.insert(M).values(p.members.map(m => ({ partyId: p.id, userId: m.userId, role: m.role, status: m.status })));
      return (await withMembers([r]))[0];
    },
    async get(id) {
      const rows = await db.select().from(P).where(eq(P.id, id)).limit(1);
      return (await withMembers(rows))[0] ?? null;
    },
    async listFor(userId, limit) {
      const mine = (await db.select({ id: M.partyId }).from(M).where(eq(M.userId, userId))).map(r => r.id);
      const where = mine.length
        ? or(eq(P.hostId, userId), eq(P.guestId, userId), inArray(P.id, mine))
        : or(eq(P.hostId, userId), eq(P.guestId, userId));
      const rows = await db.select().from(P).where(where).orderBy(desc(P.updatedAt)).limit(limit);
      return withMembers(rows);
    },
    async update(id, patch) {
      const [r] = await db.update(P).set({ ...patch, updatedAt: new Date() }).where(eq(P.id, id)).returning();
      return r ? (await withMembers([r]))[0] : null;
    },
    async setMember(partyId, userId, status) {
      const [p] = await db.select().from(P).where(eq(P.id, partyId)).limit(1);
      if (!p) return;
      const has = await db.select().from(M).where(eq(M.partyId, partyId)).limit(1);
      if (!has.length) {
        // A legacy two-person party: write its derived members first.
        const ms = legacyMembers(p.hostId, p.guestId, p.status);
        await db.insert(M).values(ms.map(m => ({ partyId, userId: m.userId, role: m.role, status: m.status })));
      }
      await db.update(M).set({ status, updatedAt: new Date() }).where(and(eq(M.partyId, partyId), eq(M.userId, userId)));
      await db.update(P).set({ updatedAt: new Date() }).where(eq(P.id, partyId));
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
  const copy = (p: Party): Party => ({ ...p, members: p.members.map(m => ({ ...m })) });
  const touch = (p: Party) => { p.updatedAt = Math.max(Date.now(), p.updatedAt + 1); };
  return {
    async create(p) { parties.set(p.id, copy(p)); return copy(p); },
    async get(id) { const p = parties.get(id); return p ? copy(p) : null; },
    async listFor(userId, limit) {
      return [...parties.values()].filter(p => p.members.some(m => m.userId === userId))
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map(copy);
    },
    async update(id, patch) {
      const p = parties.get(id);
      if (!p) return null;
      Object.assign(p, patch);
      touch(p);
      return copy(p);
    },
    async setMember(partyId, userId, status) {
      const p = parties.get(partyId);
      const m = p?.members.find(x => x.userId === userId);
      if (p && m) { m.status = status; touch(p); }
    },
    async vote(partyId, v) {
      const m = votes.get(partyId) ?? new Map<string, Vote>();
      m.set(`${v.userId}\u0000${v.itemKey}`, v);
      votes.set(partyId, m);
    },
    async votes(partyId) { return [...(votes.get(partyId)?.values() ?? [])]; },
  };
}
