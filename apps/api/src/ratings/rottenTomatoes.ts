/**
 * Rotten Tomatoes Tomatometer scores from Wikidata (CC0 open data), looked up by IMDb id.
 * Wikidata records the score with a date, so we take the most recent Tomatometer entry.
 * Coverage is good for notable films, patchier for TV and very new releases.
 */
const ENDPOINT = 'https://query.wikidata.org/sparql';
const ROTTEN_TOMATOES = 'Q105584';       // "reviewed by" Rotten Tomatoes
const TOMATOMETER = 'Q108403393';        // determination method: Tomatometer score
const BATCH = 40;
const TIMEOUT_MS = 6000;

export type RtResult = { score: number | null; url: string | null };

function query(imdbIds: string[]): string {
  const values = imdbIds.map(id => `"${id}"`).join(' ');
  return `SELECT ?imdb ?score ?date ?method ?rtid WHERE {
  VALUES ?imdb { ${values} }
  ?film wdt:P345 ?imdb .
  OPTIONAL { ?film wdt:P1258 ?rtid }
  OPTIONAL {
    ?film p:P444 ?st . ?st ps:P444 ?score ; pq:P447 wd:${ROTTEN_TOMATOES} .
    OPTIONAL { ?st pq:P585 ?date }
    OPTIONAL { ?st pq:P459 ?method }
  }
}`;
}

/** Parse SPARQL JSON results into imdbId → latest Tomatometer % and RT page. */
export function parseRtResults(json: any, asked: string[]): Map<string, RtResult> {
  const best = new Map<string, { score: number | null; date: string; url: string | null }>();
  for (const id of asked) best.set(id, { score: null, date: '', url: null });
  for (const b of json?.results?.bindings ?? []) {
    const id = b.imdb?.value;
    const cur = best.get(id);
    if (!cur) continue;
    const rtid = b.rtid?.value;
    if (rtid && !cur.url) cur.url = `https://www.rottentomatoes.com/${rtid}`;
    const raw = b.score?.value as string | undefined;
    const method = (b.method?.value as string | undefined)?.split('/').pop();
    const m = raw?.match(/^(\d{1,3})\s*%$/);
    if (!m || (method && method !== TOMATOMETER)) continue;
    const date = b.date?.value ?? '';
    if (cur.score === null || date > cur.date) {
      cur.score = Math.min(100, Number(m[1]));
      cur.date = date;
    }
  }
  return new Map([...best].map(([id, v]) => [id, { score: v.score, url: v.url }]));
}

// One query at a time, as Wikidata asks of API clients.
let chain: Promise<unknown> = Promise.resolve();

export async function fetchRottenTomatoes(imdbIds: string[]): Promise<Map<string, RtResult>> {
  const out = new Map<string, RtResult>();
  const ids = [...new Set(imdbIds.filter(id => /^tt\d+$/.test(id)))];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const run = chain.then(async () => {
      const res = await fetch(`${ENDPOINT}?query=${encodeURIComponent(query(batch))}`, {
        headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'MoveeApp/1.0 (self-hosted movie recommender)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
      return parseRtResults(await res.json(), batch);
    });
    chain = run.catch(() => {});
    for (const [k, v] of await run) out.set(k, v);
  }
  return out;
}
