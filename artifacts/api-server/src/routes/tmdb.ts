import { Router } from 'express';
import { tmdbFetch } from '../lib/tmdb';

const router = Router();

// NOTE: router.use() + req.path, not a `/{*path}` wildcard — Express 5 joins
// wildcard segments with commas (see replit.md).
router.use(async (req: any, res: any) => {
  const tmdbPath = req.path;
  const query = new URLSearchParams(req.query as any);

  try {
    const { ok, status, data } = await tmdbFetch(tmdbPath, query.toString());

    if (!ok) {
      req.log.warn({ status, tmdbPath }, 'TMDB returned non-OK');
      res.status(status).json({ error: `TMDB returned ${status}`, detail: data });
      return;
    }

    res.set('Cache-Control', 'no-store');
    res.removeHeader('ETag');
    res.json(data);
  } catch (err: any) {
    req.log.error({ err: err.message }, 'TMDB proxy error');
    res.status(500).json({ error: 'TMDB fetch failed', detail: err.message });
  }
});

export default router;
