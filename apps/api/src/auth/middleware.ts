import type { NextFunction, Request, Response } from 'express';
import { getAuthStore } from '../lib/stores';
import { hashToken } from './crypto';
import type { User } from './store';

export const SESSION_DAYS = 60;
const DAY = 86400_000;
const CACHE_MS = 30_000;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      sessionTokenHash?: string;
    }
  }
}

// Short cache so every swipe doesn't cost a session lookup. Logout clears its entry.
const cache = new Map<string, { user: User; at: number }>();

export function forgetSession(tokenHash: string) {
  cache.delete(tokenHash);
}

export function forgetUser(userId: string) {
  for (const [k, v] of cache) if (v.user.id === userId) cache.delete(k);
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  const t = h.slice(7).trim();
  return t.length >= 20 && t.length <= 200 ? t : null;
}

/** Requires a valid session; sets req.user. Sliding expiry: refreshed at most once a day. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  const tokenHash = hashToken(token);
  try {
    const hit = cache.get(tokenHash);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      req.user = hit.user;
      req.sessionTokenHash = tokenHash;
      next();
      return;
    }
    const store = await getAuthStore();
    const s = await store.getSession(tokenHash);
    if (!s) {
      cache.delete(tokenHash);
      res.status(401).json({ error: 'Session expired. Please log in again.' });
      return;
    }
    if (s.expiresAt - Date.now() < (SESSION_DAYS - 1) * DAY) {
      await store.extendSession(tokenHash, new Date(Date.now() + SESSION_DAYS * DAY));
    }
    if (cache.size > 10000) cache.clear();
    cache.set(tokenHash, { user: s.user, at: Date.now() });
    req.user = s.user;
    req.sessionTokenHash = tokenHash;
    next();
  } catch (err) {
    next(err);
  }
}
