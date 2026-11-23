export type User = {
  id: string;
  username: string;
  hasSeenTutorial: boolean;
  createdAt: number;
};

export type UserWithHash = User & { passwordHash: string };

export interface AuthStore {
  /** Returns null when the username (case-insensitive) is taken. */
  createUser(u: { id: string; username: string; passwordHash: string }): Promise<User | null>;
  findByUsername(username: string): Promise<UserWithHash | null>;
  findById(id: string): Promise<User | null>;
  setTutorialSeen(id: string, seen: boolean): Promise<void>;

  createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void>;
  /** The session's user, if the session exists and hasn't expired. */
  getSession(tokenHash: string): Promise<{ user: User; expiresAt: number } | null>;
  extendSession(tokenHash: string, expiresAt: Date): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteExpiredSessions(): Promise<void>;

  addFriend(userId: string, friendId: string): Promise<void>;
  removeFriend(userId: string, friendId: string): Promise<void>;
  listFriends(userId: string): Promise<Array<{ user: User; addedAt: number }>>;
  isFriend(userId: string, friendId: string): Promise<boolean>;
}

const pub = (u: { id: string; username: string; hasSeenTutorial: boolean; createdAt: Date | number }): User => ({
  id: u.id,
  username: u.username,
  hasSeenTutorial: u.hasSeenTutorial,
  createdAt: u.createdAt instanceof Date ? u.createdAt.getTime() : u.createdAt,
});

// ------------------------------------------------------------------ Postgres

export async function createPgAuthStore(): Promise<AuthStore> {
  const { db, users, sessions, friends, and, eq, gt, lt } = await import('@movee/db');

  return {
    async createUser(u) {
      const rows = await db.insert(users)
        .values({ id: u.id, username: u.username, usernameLower: u.username.toLowerCase(), passwordHash: u.passwordHash })
        .onConflictDoNothing({ target: users.usernameLower })
        .returning();
      return rows[0] ? pub(rows[0]) : null;
    },
    async findByUsername(username) {
      const [r] = await db.select().from(users).where(eq(users.usernameLower, username.toLowerCase())).limit(1);
      return r ? { ...pub(r), passwordHash: r.passwordHash } : null;
    },
    async findById(id) {
      const [r] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return r ? pub(r) : null;
    },
    async setTutorialSeen(id, seen) {
      await db.update(users).set({ hasSeenTutorial: seen }).where(eq(users.id, id));
    },
    async createSession(tokenHash, userId, expiresAt) {
      await db.insert(sessions).values({ tokenHash, userId, expiresAt });
    },
    async getSession(tokenHash) {
      const [r] = await db
        .select({ user: users, expiresAt: sessions.expiresAt })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
        .limit(1);
      return r ? { user: pub(r.user), expiresAt: r.expiresAt.getTime() } : null;
    },
    async extendSession(tokenHash, expiresAt) {
      await db.update(sessions).set({ expiresAt }).where(eq(sessions.tokenHash, tokenHash));
    },
    async deleteSession(tokenHash) {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    },
    async deleteExpiredSessions() {
      await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    },
    async addFriend(userId, friendId) {
      await db.insert(friends).values({ userId, friendId }).onConflictDoNothing();
    },
    async removeFriend(userId, friendId) {
      await db.delete(friends).where(and(eq(friends.userId, userId), eq(friends.friendId, friendId)));
    },
    async listFriends(userId) {
      const rows = await db
        .select({ user: users, addedAt: friends.createdAt })
        .from(friends)
        .innerJoin(users, eq(users.id, friends.friendId))
        .where(eq(friends.userId, userId))
        .orderBy(friends.createdAt);
      return rows.map(r => ({ user: pub(r.user), addedAt: r.addedAt.getTime() }));
    },
    async isFriend(userId, friendId) {
      const [r] = await db.select({ x: friends.userId }).from(friends)
        .where(and(eq(friends.userId, userId), eq(friends.friendId, friendId))).limit(1);
      return !!r;
    },
  };
}

// ------------------------------------------------------------------ in-memory (tests, or no DATABASE_URL)

export function createMemoryAuthStore(): AuthStore {
  const byId = new Map<string, UserWithHash>();
  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  const follows = new Map<string, Map<string, number>>();

  return {
    async createUser(u) {
      const lower = u.username.toLowerCase();
      for (const x of byId.values()) if (x.username.toLowerCase() === lower) return null;
      const row: UserWithHash = { id: u.id, username: u.username, passwordHash: u.passwordHash, hasSeenTutorial: false, createdAt: Date.now() };
      byId.set(u.id, row);
      return pub(row);
    },
    async findByUsername(username) {
      const lower = username.toLowerCase();
      for (const x of byId.values()) if (x.username.toLowerCase() === lower) return { ...x };
      return null;
    },
    async findById(id) { const u = byId.get(id); return u ? pub(u) : null; },
    async setTutorialSeen(id, seen) { const u = byId.get(id); if (u) u.hasSeenTutorial = seen; },
    async createSession(tokenHash, userId, expiresAt) { sessions.set(tokenHash, { userId, expiresAt: expiresAt.getTime() }); },
    async getSession(tokenHash) {
      const s = sessions.get(tokenHash);
      const u = s && byId.get(s.userId);
      return s && u && s.expiresAt > Date.now() ? { user: pub(u), expiresAt: s.expiresAt } : null;
    },
    async extendSession(tokenHash, expiresAt) { const s = sessions.get(tokenHash); if (s) s.expiresAt = expiresAt.getTime(); },
    async deleteSession(tokenHash) { sessions.delete(tokenHash); },
    async deleteExpiredSessions() { for (const [k, s] of sessions) if (s.expiresAt < Date.now()) sessions.delete(k); },
    async addFriend(userId, friendId) {
      let m = follows.get(userId);
      if (!m) follows.set(userId, (m = new Map()));
      if (!m.has(friendId)) m.set(friendId, Date.now());
    },
    async removeFriend(userId, friendId) { follows.get(userId)?.delete(friendId); },
    async listFriends(userId) {
      return [...(follows.get(userId) ?? new Map<string, number>()).entries()]
        .flatMap(([id, at]) => { const u = byId.get(id); return u ? [{ user: pub(u), addedAt: at }] : []; });
    },
    async isFriend(userId, friendId) { return !!follows.get(userId)?.has(friendId); },
  };
}
