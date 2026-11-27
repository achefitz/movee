export type User = {
  id: string;
  username: string;
  hasSeenTutorial: boolean;
  favoriteGenres: number[];
  onboarded: boolean;
  isPrivate: boolean;
  /** A recovery code is set (the code itself is never stored, only its hash). */
  hasRecoveryCode: boolean;
  createdAt: number;
};

export type FollowStatus = 'accepted' | 'pending';
export type Follow = { user: User; status: FollowStatus; since: number };

export type UserWithHash = User & { passwordHash: string; recoveryCodeHash: string | null };

export interface AuthStore {
  /** Returns null when the username (case-insensitive) is taken. */
  createUser(u: { id: string; username: string; passwordHash: string }): Promise<User | null>;
  findByUsername(username: string): Promise<UserWithHash | null>;
  findById(id: string): Promise<User | null>;
  setTutorialSeen(id: string, seen: boolean): Promise<void>;
  /** Saves onboarding answers and marks onboarding done. */
  completeOnboarding(id: string, favoriteGenres: number[]): Promise<void>;

  createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void>;
  /** The session's user, if the session exists and hasn't expired. */
  getSession(tokenHash: string): Promise<{ user: User; expiresAt: number } | null>;
  extendSession(tokenHash: string, expiresAt: Date): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteExpiredSessions(): Promise<void>;
  /** Signs the user out everywhere, except the session `keepTokenHash` if given. */
  deleteUserSessions(userId: string, keepTokenHash?: string): Promise<void>;
  setPasswordHash(id: string, passwordHash: string): Promise<void>;
  setRecoveryCodeHash(id: string, hash: string | null): Promise<void>;

  setPrivate(id: string, isPrivate: boolean): Promise<void>;

  /** Creates the follow if absent (existing follows keep their status). */
  follow(followerId: string, followeeId: string, status: FollowStatus): Promise<void>;
  unfollow(followerId: string, followeeId: string): Promise<void>;
  setFollowStatus(followerId: string, followeeId: string, status: FollowStatus): Promise<void>;
  /** Approve every pending request to this account (used when it goes public). */
  acceptAllPending(followeeId: string): Promise<void>;
  followStatus(followerId: string, followeeId: string): Promise<FollowStatus | null>;
  /** Accounts this user follows (incl. pending requests they sent). */
  listFollowing(userId: string): Promise<Follow[]>;
  /** Accounts following this user (incl. pending requests to approve). */
  listFollowers(userId: string): Promise<Follow[]>;
}

type UserRow = {
  id: string;
  username: string;
  hasSeenTutorial: boolean;
  favoriteGenres: number[];
  onboardedAt: Date | number | null;
  isPrivate: boolean;
  recoveryCodeHash?: string | null;
  createdAt: Date | number;
};

const pub = (u: UserRow): User => ({
  id: u.id,
  username: u.username,
  hasSeenTutorial: u.hasSeenTutorial,
  favoriteGenres: u.favoriteGenres ?? [],
  onboarded: u.onboardedAt != null,
  isPrivate: !!u.isPrivate,
  hasRecoveryCode: !!u.recoveryCodeHash,
  createdAt: u.createdAt instanceof Date ? u.createdAt.getTime() : u.createdAt,
});

// ------------------------------------------------------------------ Postgres

export async function createPgAuthStore(): Promise<AuthStore> {
  const { db, users, sessions, friends, and, eq, gt, lt, ne } = await import('@movee/db');

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
      return r ? { ...pub(r), passwordHash: r.passwordHash, recoveryCodeHash: r.recoveryCodeHash ?? null } : null;
    },
    async findById(id) {
      const [r] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return r ? pub(r) : null;
    },
    async setTutorialSeen(id, seen) {
      await db.update(users).set({ hasSeenTutorial: seen }).where(eq(users.id, id));
    },
    async completeOnboarding(id, favoriteGenres) {
      await db.update(users).set({ favoriteGenres, onboardedAt: new Date() }).where(eq(users.id, id));
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
    async deleteUserSessions(userId, keep) {
      await db.delete(sessions).where(keep
        ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, keep))
        : eq(sessions.userId, userId));
    },
    async setPasswordHash(id, passwordHash) {
      await db.update(users).set({ passwordHash }).where(eq(users.id, id));
    },
    async setRecoveryCodeHash(id, hash) {
      await db.update(users).set({ recoveryCodeHash: hash }).where(eq(users.id, id));
    },
    async deleteExpiredSessions() {
      await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    },
    async setPrivate(id, isPrivate) {
      await db.update(users).set({ isPrivate }).where(eq(users.id, id));
    },
    async follow(followerId, followeeId, status) {
      await db.insert(friends).values({ userId: followerId, friendId: followeeId, status }).onConflictDoNothing();
    },
    async unfollow(followerId, followeeId) {
      await db.delete(friends).where(and(eq(friends.userId, followerId), eq(friends.friendId, followeeId)));
    },
    async setFollowStatus(followerId, followeeId, status) {
      await db.update(friends).set({ status })
        .where(and(eq(friends.userId, followerId), eq(friends.friendId, followeeId)));
    },
    async acceptAllPending(followeeId) {
      await db.update(friends).set({ status: 'accepted' })
        .where(and(eq(friends.friendId, followeeId), eq(friends.status, 'pending')));
    },
    async followStatus(followerId, followeeId) {
      const [r] = await db.select({ status: friends.status }).from(friends)
        .where(and(eq(friends.userId, followerId), eq(friends.friendId, followeeId))).limit(1);
      return (r?.status as FollowStatus | undefined) ?? null;
    },
    async listFollowing(userId) {
      const rows = await db
        .select({ user: users, status: friends.status, since: friends.createdAt })
        .from(friends).innerJoin(users, eq(users.id, friends.friendId))
        .where(eq(friends.userId, userId)).orderBy(friends.createdAt);
      return rows.map(r => ({ user: pub(r.user), status: r.status as FollowStatus, since: r.since.getTime() }));
    },
    async listFollowers(userId) {
      const rows = await db
        .select({ user: users, status: friends.status, since: friends.createdAt })
        .from(friends).innerJoin(users, eq(users.id, friends.userId))
        .where(eq(friends.friendId, userId)).orderBy(friends.createdAt);
      return rows.map(r => ({ user: pub(r.user), status: r.status as FollowStatus, since: r.since.getTime() }));
    },
  };
}

// ------------------------------------------------------------------ in-memory (tests, or no DATABASE_URL)

export function createMemoryAuthStore(): AuthStore {
  const byId = new Map<string, UserRow & { passwordHash: string; recoveryCodeHash: string | null }>();
  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  // followerId → followeeId → { status, since }
  const follows = new Map<string, Map<string, { status: FollowStatus; since: number }>>();

  return {
    async createUser(u) {
      const lower = u.username.toLowerCase();
      for (const x of byId.values()) if (x.username.toLowerCase() === lower) return null;
      const row = { id: u.id, username: u.username, passwordHash: u.passwordHash, recoveryCodeHash: null as string | null, hasSeenTutorial: false, favoriteGenres: [] as number[], onboardedAt: null, isPrivate: false, createdAt: Date.now() };
      byId.set(u.id, row);
      return pub(row);
    },
    async findByUsername(username) {
      const lower = username.toLowerCase();
      for (const x of byId.values()) if (x.username.toLowerCase() === lower) return { ...pub(x), passwordHash: x.passwordHash, recoveryCodeHash: x.recoveryCodeHash };
      return null;
    },
    async findById(id) { const u = byId.get(id); return u ? pub(u) : null; },
    async setTutorialSeen(id, seen) { const u = byId.get(id); if (u) u.hasSeenTutorial = seen; },
    async completeOnboarding(id, favoriteGenres) {
      const u = byId.get(id);
      if (u) { u.favoriteGenres = favoriteGenres; u.onboardedAt = Date.now(); }
    },
    async createSession(tokenHash, userId, expiresAt) { sessions.set(tokenHash, { userId, expiresAt: expiresAt.getTime() }); },
    async getSession(tokenHash) {
      const s = sessions.get(tokenHash);
      const u = s && byId.get(s.userId);
      return s && u && s.expiresAt > Date.now() ? { user: pub(u), expiresAt: s.expiresAt } : null;
    },
    async extendSession(tokenHash, expiresAt) { const s = sessions.get(tokenHash); if (s) s.expiresAt = expiresAt.getTime(); },
    async deleteSession(tokenHash) { sessions.delete(tokenHash); },
    async deleteUserSessions(userId, keep) {
      for (const [k, s] of sessions) if (s.userId === userId && k !== keep) sessions.delete(k);
    },
    async setPasswordHash(id, passwordHash) { const u = byId.get(id); if (u) u.passwordHash = passwordHash; },
    async setRecoveryCodeHash(id, hash) { const u = byId.get(id); if (u) u.recoveryCodeHash = hash; },
    async deleteExpiredSessions() { for (const [k, s] of sessions) if (s.expiresAt < Date.now()) sessions.delete(k); },
    async setPrivate(id, isPrivate) { const u = byId.get(id); if (u) u.isPrivate = isPrivate; },
    async follow(followerId, followeeId, status) {
      let m = follows.get(followerId);
      if (!m) follows.set(followerId, (m = new Map()));
      if (!m.has(followeeId)) m.set(followeeId, { status, since: Date.now() });
    },
    async unfollow(followerId, followeeId) { follows.get(followerId)?.delete(followeeId); },
    async setFollowStatus(followerId, followeeId, status) {
      const f = follows.get(followerId)?.get(followeeId);
      if (f) f.status = status;
    },
    async acceptAllPending(followeeId) {
      for (const m of follows.values()) { const f = m.get(followeeId); if (f?.status === 'pending') f.status = 'accepted'; }
    },
    async followStatus(followerId, followeeId) { return follows.get(followerId)?.get(followeeId)?.status ?? null; },
    async listFollowing(userId) {
      return [...(follows.get(userId)?.entries() ?? [])].flatMap(([id, f]) => {
        const u = byId.get(id);
        return u ? [{ user: pub(u), status: f.status, since: f.since }] : [];
      });
    },
    async listFollowers(userId) {
      const out: Follow[] = [];
      for (const [followerId, m] of follows) {
        const f = m.get(userId);
        const u = byId.get(followerId);
        if (f && u) out.push({ user: pub(u), status: f.status, since: f.since });
      }
      return out.sort((a, b) => a.since - b.since);
    },
  };
}
