const TMDB_BASE = 'https://api.themoviedb.org/3';

export type TmdbResult = { ok: boolean; status: number; data: any };

/** Raw TMDB call. Uses TMDB_READ_ACCESS_TOKEN (Bearer) or falls back to TMDB_API_KEY. */
export async function tmdbFetch(path: string, queryStr = ''): Promise<TmdbResult> {
  const token = process.env.TMDB_READ_ACCESS_TOKEN || '';
  const apiKey = process.env.TMDB_API_KEY || '';
  const q = new URLSearchParams(queryStr);
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (token) headers.Authorization = `Bearer ${token}`;
  else if (apiKey) q.set('api_key', apiKey);
  else throw new Error('No TMDB credentials configured');

  const qs = q.toString();
  const res = await fetch(TMDB_BASE + path + (qs ? `?${qs}` : ''), { headers });
  const data = res.ok ? await res.json() : await res.text();
  return { ok: res.ok, status: res.status, data };
}

/** JSON or throw — for server-side callers that don't proxy the status through. */
export async function tmdbJson(path: string, query: Record<string, string | number | undefined> = {}): Promise<any> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.set(k, String(v));
  const r = await tmdbFetch(path, q.toString());
  if (!r.ok) throw new Error(`TMDB ${r.status} for ${path}`);
  return r.data;
}
