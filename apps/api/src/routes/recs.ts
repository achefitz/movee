import { Router, type Request, type Response } from 'express';
import { z } from 'zod/v4';
import { requireAuth } from '../auth/middleware';
import { logger } from '../lib/logger';
import { getRecsService } from '../lib/stores';
import type { RecsService } from '../recsys/service';
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
  maxRuntime: z.number().int().positive().max(600).nullable().default(null),
  inTheaters: z.boolean().default(false),
});

const DeckBody = z.object({
  filters: FiltersSchema.default(DEFAULT_FILTERS),
  exclude: z.array(Key).max(300).default([]),
  limit: z.number().int().min(1).max(40).default(20),
});
const FeedbackBody = z.object({ key: Key, action: ActionSchema, impressionId: z.string().uuid().nullish() });
const UndoBody = z.object({ key: Key });
const SyncBody = z.object({
  entries: z.array(z.object({ key: Key, action: ActionSchema })).max(3000),
});

function handle<T>(schema: z.ZodType<T>, fn: (body: T, svc: RecsService, userId: string) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
      return;
    }
    try {
      const svc = await getRecsService();
      res.set('Cache-Control', 'no-store');
      res.json(await fn(parsed.data, svc, req.user!.id));
    } catch (err: any) {
      logger.error({ err: err.message, path: req.path }, 'recs request failed');
      res.status(err.message?.includes('TMDB credentials') ? 503 : 500).json({ error: 'Recommendation request failed' });
    }
  };
}

router.post('/deck', handle(DeckBody, async (b, svc, userId) => ({
  items: await svc.deck(userId, b.filters, b.exclude, b.limit),
})));

router.post('/feedback', handle(FeedbackBody, async (b, svc, userId) => {
  await svc.feedback(userId, b.key, b.action, b.impressionId ?? null);
  return { ok: true };
}));

router.post('/undo', handle(UndoBody, async (b, svc, userId) => {
  await svc.undo(userId, b.key);
  return { ok: true };
}));

router.post('/sync', handle(SyncBody, (b, svc, userId) => svc.sync(userId, b.entries)));

router.get('/status', async (_req, res) => {
  const svc = await getRecsService();
  res.json(svc.status());
});

export default router;
