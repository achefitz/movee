import { Router, type Request, type Response } from 'express';
import { z } from 'zod/v4';
import { logger } from '../lib/logger';
import { RecsService } from '../recsys/service';
import { createMemoryStore, createPgStore } from '../recsys/store';
import { DEFAULT_FILTERS, parseKey } from '../recsys/types';

const router = Router();

let servicePromise: Promise<RecsService> | null = null;
function getService(): Promise<RecsService> {
  if (!servicePromise) {
    servicePromise = (async () => {
      let store;
      if (process.env.DATABASE_URL) {
        store = await createPgStore();
      } else {
        logger.warn('DATABASE_URL not set — recommender is using an in-memory store (swipes are lost on restart)');
        store = createMemoryStore();
      }
      const svc = new RecsService(store, logger);
      await svc.init();
      return svc;
    })();
    servicePromise.catch(() => { servicePromise = null; }); // retry init on next request
  }
  return servicePromise;
}

// Accounts are device-local today, so this is an opaque, client-chosen id (username or device id).
const UserId = z.string().min(1).max(80).regex(/^[A-Za-z0-9@_:.-]+$/);
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
  userId: UserId,
  filters: FiltersSchema.default(DEFAULT_FILTERS),
  exclude: z.array(Key).max(300).default([]),
  limit: z.number().int().min(1).max(40).default(20),
});
const FeedbackBody = z.object({ userId: UserId, key: Key, action: ActionSchema, impressionId: z.string().uuid().nullish() });
const UndoBody = z.object({ userId: UserId, key: Key });
const SyncBody = z.object({
  userId: UserId,
  entries: z.array(z.object({ key: Key, action: ActionSchema })).max(3000),
});

function handle<T>(schema: z.ZodType<T>, fn: (body: T, svc: RecsService) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
      return;
    }
    try {
      const svc = await getService();
      res.set('Cache-Control', 'no-store');
      res.json(await fn(parsed.data, svc));
    } catch (err: any) {
      logger.error({ err: err.message, path: req.path }, 'recs request failed');
      res.status(err.message?.includes('TMDB credentials') ? 503 : 500).json({ error: 'Recommendation request failed' });
    }
  };
}

router.post('/deck', handle(DeckBody, async (b, svc) => ({
  items: await svc.deck(b.userId, b.filters, b.exclude, b.limit),
})));

router.post('/feedback', handle(FeedbackBody, async (b, svc) => {
  await svc.feedback(b.userId, b.key, b.action, b.impressionId ?? null);
  return { ok: true };
}));

router.post('/undo', handle(UndoBody, async (b, svc) => {
  await svc.undo(b.userId, b.key);
  return { ok: true };
}));

router.post('/sync', handle(SyncBody, (b, svc) => svc.sync(b.userId, b.entries)));

router.get('/status', async (_req, res) => {
  const svc = await getService();
  res.json(svc.status());
});

export default router;
