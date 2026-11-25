import { Router, type Request, type Response } from 'express';
import { z } from 'zod/v4';
import { requireAuth } from '../auth/middleware';
import { logger } from '../lib/logger';
import { getRecsService } from '../lib/stores';
import type { RecsService } from '../recsys/service';
import type { User } from '../auth/store';
import { DEFAULT_FILTERS, parseKey } from '../recsys/types';

const router = Router();

// Every recommender call acts on the signed-in account; any userId in the body is ignored.
router.use(requireAuth);

const Key = z.string().max(40).refine(k => parseKey(k) !== null, 'expected "movie:<id>" or "tv:<id>"');
const ActionSchema = z.enum(['like', 'skip', 'seen', 'seen_up', 'seen_meh', 'seen_down']);

const FiltersSchema = z.object({
  contentType: z.enum(['all', 'movie', 'tv']).default('all'),
  genres: z.array(z.number().int()).max(30).default([]),
  streaming: z.array(z.number().int()).max(30).default([]),
  era: z.enum(['all', 'new', 'classic']).default('all'),
  minRating: z.number().min(0).max(10).default(0),
  ageRatings: z.array(z.enum(['G', 'PG', 'PG-13', 'R', 'NC-17'])).max(5).default([]),
  maxRuntime: z.number().int().positive().max(600).nullable().default(null),
  inTheaters: z.boolean().default(false),
});

const DeckBody = z.object({
  filters: FiltersSchema.default({ ...DEFAULT_FILTERS, ageRatings: [] }),
  exclude: z.array(Key).max(300).default([]),
  limit: z.number().int().min(1).max(40).default(20),
});
const FeedbackBody = z.object({
  key: Key,
  action: ActionSchema,
  impressionId: z.string().uuid().nullish(),
  source: z.enum(['deck', 'search']).default('deck'),
});
const SearchClickBody = z.object({ key: Key, query: z.string().min(1).max(100) });
const UndoBody = z.object({ key: Key });
const SyncBody = z.object({
  entries: z.array(z.object({ key: Key, action: ActionSchema })).max(3000),
});

function handle<T>(schema: z.ZodType<T>, fn: (body: T, svc: RecsService, userId: string, user: User) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
      return;
    }
    try {
      const svc = await getRecsService();
      res.set('Cache-Control', 'no-store');
      res.json(await fn(parsed.data, svc, req.user!.id, req.user!));
    } catch (err: any) {
      logger.error({ err: err.message, path: req.path }, 'recs request failed');
      res.status(err.message?.includes('TMDB credentials') ? 503 : 500).json({ error: 'Recommendation request failed' });
    }
  };
}

router.post('/deck', handle(DeckBody, async (b, svc, userId, user) => ({
  items: await svc.deck(userId, b.filters, b.exclude, b.limit, user.favoriteGenres),
})));

router.post('/feedback', handle(FeedbackBody, async (b, svc, userId) => {
  await svc.feedback(userId, b.key, b.action, b.impressionId ?? null, b.source);
  return { ok: true };
}));

router.post('/undo', handle(UndoBody, async (b, svc, userId) => {
  await svc.undo(userId, b.key);
  return { ok: true };
}));

router.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 100);
  if (q.trim().length < 2) return void res.json({ items: [] });
  try {
    const svc = await getRecsService();
    res.set('Cache-Control', 'no-store');
    res.json({ items: await svc.search(req.user!.id, q) });
  } catch (err: any) {
    logger.error({ err: err.message }, 'search failed');
    res.status(err.message?.includes('TMDB credentials') ? 503 : 500).json({ error: 'Search failed' });
  }
});

router.post('/search/click', handle(SearchClickBody, async (b, svc, userId) => {
  await svc.searchClick(userId, b.query, b.key);
  return { ok: true };
}));

router.post('/hide', handle(UndoBody, async (b, svc, userId) => {
  await svc.hide(userId, b.key);
  return { ok: true };
}));

router.get('/library', async (req, res) => {
  try {
    const svc = await getRecsService();
    res.set('Cache-Control', 'no-store');
    res.json(await svc.library(req.user!.id));
  } catch (err: any) {
    logger.error({ err: err.message }, 'library request failed');
    res.status(500).json({ error: 'Could not load your lists' });
  }
});

router.post('/sync', handle(SyncBody, (b, svc, userId) => svc.sync(userId, b.entries)));

router.get('/status', async (_req, res) => {
  const svc = await getRecsService();
  res.json(svc.status());
});

export default router;
