import { Router } from 'express';
import { z } from 'zod/v4';
import { forgetUser, requireAuth } from '../auth/middleware';
import { getAuthStore, getRecsService } from '../lib/stores';
import { parseKey } from '../recsys/types';

/**
 * First-run questions: favorite genres, then favorite titles picked from a grid of
 * popular ones. Both feed the recommender so the very first deck is personal.
 */
const router = Router();
router.use(requireAuth);

const GenreList = z.array(z.number().int().positive()).max(19);

/** GET /api/onboarding/titles?genres=28,35 → 20 popular titles leaning towards those genres. */
router.get('/titles', async (req, res, next) => {
  try {
    const raw = typeof req.query.genres === 'string' ? req.query.genres.split(',').filter(Boolean).map(Number) : [];
    const genres = GenreList.safeParse(raw);
    if (!genres.success) return void res.status(400).json({ error: 'Invalid genres' });
    const svc = await getRecsService();
    res.json({ items: await svc.onboardingTitles(genres.data, 20) });
  } catch (err) { next(err); }
});

const Body = z.object({
  genres: GenreList.default([]),
  favorites: z.array(z.string().max(40).refine(k => parseKey(k) !== null)).max(50).default([]),
});

/** POST /api/onboarding {genres, favorites} — also used (with empty lists) when the user skips. */
router.post('/', async (req, res, next) => {
  try {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid request' });
    const { genres, favorites } = parsed.data;
    const [store, svc] = await Promise.all([getAuthStore(), getRecsService()]);
    await svc.recordFavorites(req.user!.id, [...new Set(favorites)]);
    await store.completeOnboarding(req.user!.id, [...new Set(genres)]);
    forgetUser(req.user!.id); // session cache must see the new favorite genres
    res.json({ user: await store.findById(req.user!.id) });
  } catch (err) { next(err); }
});

export default router;
