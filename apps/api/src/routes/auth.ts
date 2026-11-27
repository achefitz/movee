import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod/v4';
import { getDummyHash, hashPassword, hashToken, newSessionToken, verifyPassword } from '../auth/crypto';
import { forgetSession, forgetUser, requireAuth, SESSION_DAYS } from '../auth/middleware';
import { RateLimiter } from '../auth/rateLimit';
import { MAX_PASSWORD, MIN_PASSWORD, newRecoveryCode, normaliseRecoveryCode, passwordProblem } from '../auth/passwordPolicy';
import type { User } from '../auth/store';
import { getAuthStore } from '../lib/stores';
import { logger } from '../lib/logger';

const router = Router();

export const USERNAME_RE = /^@[A-Za-z0-9_]{1,30}$/;
export { MIN_PASSWORD };

/** Accepts "name" or "@name"; returns "@name". */
export function normaliseUsername(raw: string): string {
  const t = raw.trim();
  return t.startsWith('@') ? t : `@${t}`;
}

const Username = z.string().max(40).transform(normaliseUsername);
const Password = z.string().min(1).max(MAX_PASSWORD);
const Credentials = z.object({ username: Username, password: Password });
const ChangePassword = z.object({ currentPassword: Password, newPassword: Password });
const PasswordOnly = z.object({ password: Password });
const Recover = z.object({ username: Username, code: z.string().min(4).max(40), newPassword: Password });

// Slow down guessing: per IP and per target username; signups per IP.
const loginByIp = new RateLimiter(20, 15 * 60_000);
const loginByUser = new RateLimiter(8, 15 * 60_000);
const signupByIp = new RateLimiter(Number(process.env.SIGNUP_LIMIT_PER_HOUR) || 10, 60 * 60_000);

const ipOf = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

function tooMany(res: Response, seconds: number) {
  res.set('Retry-After', String(seconds));
  res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(seconds / 60)} min.` });
}

/** A fresh one-time recovery code: only its hash is kept; the code is shown to the user once. */
async function issueRecoveryCode(userId: string): Promise<string> {
  const code = newRecoveryCode();
  await (await getAuthStore()).setRecoveryCodeHash(userId, await hashPassword(code));
  forgetUser(userId);
  return code;
}

async function startSession(user: User) {
  const token = newSessionToken();
  const store = await getAuthStore();
  await store.createSession(hashToken(token), user.id, new Date(Date.now() + SESSION_DAYS * 86400_000));
  return { token, user };
}

router.post('/signup', async (req, res, next) => {
  try {
    const ip = ipOf(req);
    const wait = signupByIp.retryAfter(ip);
    if (wait) return tooMany(res, wait);

    const parsed = Credentials.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Username and password are required.' });
    const { username, password } = parsed.data;
    if (!USERNAME_RE.test(username)) {
      return void res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores (max 30).' });
    }
    const problem = await passwordProblem(password, username);
    if (problem) return void res.status(400).json({ error: problem });
    signupByIp.hit(ip);

    const store = await getAuthStore();
    const created = await store.createUser({ id: randomUUID(), username, passwordHash: await hashPassword(password) });
    if (!created) return void res.status(409).json({ error: 'That username is already taken.' });
    logger.info({ userId: created.id }, 'account created');
    const recoveryCode = await issueRecoveryCode(created.id);
    const user = { ...created, hasRecoveryCode: true };
    res.status(201).json({ ...(await startSession(user)), recoveryCode });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const parsed = Credentials.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Username and password are required.' });
    const { username, password } = parsed.data;
    const ip = ipOf(req);
    const userKey = username.toLowerCase();
    const wait = Math.max(loginByIp.retryAfter(ip), loginByUser.retryAfter(userKey));
    if (wait) return tooMany(res, wait);

    const store = await getAuthStore();
    const found = await store.findByUsername(username);
    // Always run one hash so a missing user costs the same time as a wrong password.
    const ok = await verifyPassword(password, found?.passwordHash ?? await getDummyHash());
    if (!found || !ok) {
      loginByIp.hit(ip);
      loginByUser.hit(userKey);
      return void res.status(401).json({ error: 'Incorrect username or password.' });
    }
    loginByUser.reset(userKey);
    const { passwordHash: _omit, recoveryCodeHash: _r, ...user } = found;
    res.json(await startSession(user));
  } catch (err) {
    next(err);
  }
});

// Change password (needs the current one). Signs out every other device.
// A wrong password answers 403, not 401: the app signs out on any 401.
router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const parsed = ChangePassword.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Enter your current and new password.' });
    const { currentPassword, newPassword } = parsed.data;
    const me = req.user!;
    const key = me.username.toLowerCase();
    const wait = loginByUser.retryAfter(key);
    if (wait) return tooMany(res, wait);
    const store = await getAuthStore();
    const found = await store.findByUsername(me.username);
    if (!found || !(await verifyPassword(currentPassword, found.passwordHash))) {
      loginByUser.hit(key);
      return void res.status(403).json({ error: 'Your current password is incorrect.' });
    }
    if (newPassword === currentPassword) return void res.status(400).json({ error: 'Pick a password you haven\'t used here before.' });
    const problem = await passwordProblem(newPassword, me.username);
    if (problem) return void res.status(400).json({ error: problem });
    await store.setPasswordHash(me.id, await hashPassword(newPassword));
    await store.deleteUserSessions(me.id, req.sessionTokenHash);
    forgetUser(me.id);
    logger.info({ userId: me.id }, 'password changed');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// A new recovery code (needs the password). The old code stops working.
router.post('/recovery-code', requireAuth, async (req, res, next) => {
  try {
    const parsed = PasswordOnly.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Enter your password.' });
    const me = req.user!;
    const key = me.username.toLowerCase();
    const wait = loginByUser.retryAfter(key);
    if (wait) return tooMany(res, wait);
    const found = await (await getAuthStore()).findByUsername(me.username);
    if (!found || !(await verifyPassword(parsed.data.password, found.passwordHash))) {
      loginByUser.hit(key);
      return void res.status(403).json({ error: 'That password is incorrect.' });
    }
    const recoveryCode = await issueRecoveryCode(me.id);
    res.json({ recoveryCode, user: { ...me, hasRecoveryCode: true } });
  } catch (err) {
    next(err);
  }
});

// Forgot password: username + recovery code + new password. The code is used up and a new
// one is issued; every existing session is signed out.
router.post('/recover', async (req, res, next) => {
  try {
    const parsed = Recover.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Enter your username, recovery code and a new password.' });
    const { username, newPassword } = parsed.data;
    const code = normaliseRecoveryCode(parsed.data.code);
    const ip = ipOf(req);
    const key = username.toLowerCase();
    const wait = Math.max(loginByIp.retryAfter(ip), loginByUser.retryAfter(key));
    if (wait) return tooMany(res, wait);
    const store = await getAuthStore();
    const found = await store.findByUsername(username);
    const ok = await verifyPassword(code, found?.recoveryCodeHash ?? await getDummyHash());
    if (!found || !found.recoveryCodeHash || !ok) {
      loginByIp.hit(ip);
      loginByUser.hit(key);
      return void res.status(401).json({ error: "That username and recovery code don't match." });
    }
    const problem = await passwordProblem(newPassword, found.username);
    if (problem) return void res.status(400).json({ error: problem });
    await store.setPasswordHash(found.id, await hashPassword(newPassword));
    await store.deleteUserSessions(found.id);
    loginByUser.reset(key);
    const recoveryCode = await issueRecoveryCode(found.id);
    const { passwordHash: _p, recoveryCodeHash: _r, ...user } = found;
    logger.info({ userId: found.id }, 'password reset with recovery code');
    res.json({ ...(await startSession({ ...user, hasRecoveryCode: true })), recoveryCode });
  } catch (err) {
    next(err);
  }
});

router.post('/logout-others', requireAuth, async (req, res, next) => {
  try {
    await (await getAuthStore()).deleteUserSessions(req.user!.id, req.sessionTokenHash);
    forgetUser(req.user!.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const store = await getAuthStore();
    await store.deleteSession(req.sessionTokenHash!);
    forgetSession(req.sessionTokenHash!);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

const MePatch = z.object({ hasSeenTutorial: z.boolean().optional(), isPrivate: z.boolean().optional() })
  .refine(b => b.hasSeenTutorial !== undefined || b.isPrivate !== undefined);

router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const parsed = MePatch.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid request' });
    const store = await getAuthStore();
    const id = req.user!.id;
    if (parsed.data.hasSeenTutorial !== undefined) await store.setTutorialSeen(id, parsed.data.hasSeenTutorial);
    if (parsed.data.isPrivate !== undefined) {
      await store.setPrivate(id, parsed.data.isPrivate);
      // Going public lets everyone who asked in.
      if (!parsed.data.isPrivate) await store.acceptAllPending(id);
    }
    forgetUser(id);
    res.json({ user: await store.findById(id) });
  } catch (err) {
    next(err);
  }
});

export default router;
