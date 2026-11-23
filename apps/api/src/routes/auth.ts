import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod/v4';
import { getDummyHash, hashPassword, hashToken, newSessionToken, verifyPassword } from '../auth/crypto';
import { forgetSession, forgetUser, requireAuth, SESSION_DAYS } from '../auth/middleware';
import { RateLimiter } from '../auth/rateLimit';
import type { User } from '../auth/store';
import { getAuthStore } from '../lib/stores';
import { logger } from '../lib/logger';

const router = Router();

export const USERNAME_RE = /^@[A-Za-z0-9_]{1,30}$/;
export const MIN_PASSWORD = 8;

/** Accepts "name" or "@name"; returns "@name". */
export function normaliseUsername(raw: string): string {
  const t = raw.trim();
  return t.startsWith('@') ? t : `@${t}`;
}

const Username = z.string().max(40).transform(normaliseUsername);
const Credentials = z.object({ username: Username, password: z.string().min(1).max(200) });

// Slow down guessing: per IP and per target username; signups per IP.
const loginByIp = new RateLimiter(20, 15 * 60_000);
const loginByUser = new RateLimiter(8, 15 * 60_000);
const signupByIp = new RateLimiter(Number(process.env.SIGNUP_LIMIT_PER_HOUR) || 10, 60 * 60_000);

const ipOf = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

function tooMany(res: Response, seconds: number) {
  res.set('Retry-After', String(seconds));
  res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(seconds / 60)} min.` });
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
    if (password.length < MIN_PASSWORD) {
      return void res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
    }
    signupByIp.hit(ip);

    const store = await getAuthStore();
    const user = await store.createUser({ id: randomUUID(), username, passwordHash: await hashPassword(password) });
    if (!user) return void res.status(409).json({ error: 'That username is already taken.' });
    logger.info({ userId: user.id }, 'account created');
    res.status(201).json(await startSession(user));
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
    const { passwordHash: _omit, ...user } = found;
    res.json(await startSession(user));
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

const MePatch = z.object({ hasSeenTutorial: z.boolean() });

router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const parsed = MePatch.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid request' });
    const store = await getAuthStore();
    await store.setTutorialSeen(req.user!.id, parsed.data.hasSeenTutorial);
    forgetUser(req.user!.id);
    res.json({ user: await store.findById(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

export default router;
