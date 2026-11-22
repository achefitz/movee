import { Router } from 'express';
const router = Router();
const TMDB_BASE = 'https://api.themoviedb.org/3';

const TOKEN = process.env.TMDB_READ_ACCESS_TOKEN || '';
const API_KEY = process.env.TMDB_API_KEY || '';

async function tmdbFetch(path: string, queryStr: string): Promise<{ ok: boolean; status: number; data: any }> {
  let fullUrl = TMDB_BASE + path;

  if (TOKEN) {
    if (queryStr) fullUrl += '?' + queryStr;
    const res = await fetch(fullUrl, {
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/json',
      },
    });
    const data = res.ok ? await res.json() : await res.text();
    return { ok: res.ok, status: res.status, data };
  } else if (API_KEY) {
    const q = new URLSearchParams(queryStr || '');
    q.set('api_key', API_KEY);
    fullUrl += '?' + q.toString();
    const res = await fetch(fullUrl, {
      headers: { 'Accept': 'application/json' },
    });
    const data = res.ok ? await res.json() : await res.text();
    return { ok: res.ok, status: res.status, data };
  }

  throw new Error('No TMDB credentials configured');
}

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
