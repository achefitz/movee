import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

/**
 * IMDb ratings from IMDb's official daily dataset (title.ratings.tsv.gz,
 * https://developer.imdb.com/non-commercial-datasets/). IMDb allows it for personal
 * and non-commercial use. ~9 MB download, refreshed once a day, looked up in memory.
 */
const URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const REFRESH_MS = 24 * 3600_000;
const MIN_VOTES = 20; // drop near-empty entries to keep the table small
const CACHE_FILE = process.env.IMDB_CACHE_FILE || path.join(tmpdir(), 'movee-imdb-title.ratings.tsv.gz');

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export type ImdbRating = { rating: number; votes: number };

class ImdbRatings {
  // tconst number → rating×10 × 1e7 + votes, packed into one number to keep memory low.
  private table = new Map<number, number>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  private log: Log = { info: () => {}, warn: () => {} };

  get size() { return this.table.size; }

  /** Load in the background now and refresh daily. Lookups return undefined until loaded. */
  start(log: Log) {
    this.log = log;
    void this.refresh();
    setInterval(() => void this.refresh(), REFRESH_MS).unref();
  }

  get(imdbId: string | null | undefined): ImdbRating | undefined {
    if (!imdbId || !imdbId.startsWith('tt')) return undefined;
    const packed = this.table.get(Number(imdbId.slice(2)));
    if (packed === undefined) return undefined;
    return { rating: Math.floor(packed / 1e7) / 10, votes: packed % 1e7 };
  }

  refresh(): Promise<void> {
    this.loading ??= this.load().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async load() {
    try {
      const fresh = existsSync(CACHE_FILE) && Date.now() - statSync(CACHE_FILE).mtimeMs < REFRESH_MS;
      if (!fresh) {
        const res = await fetch(URL, { headers: { 'User-Agent': 'MoveeApp/1.0 (self-hosted movie recommender)' } });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const tmp = `${CACHE_FILE}.part`;
        await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
        await rename(tmp, CACHE_FILE);
      }
      const next = new Map<number, number>();
      const lines = createInterface({ input: createReadStream(CACHE_FILE).pipe(createGunzip()), crlfDelay: Infinity });
      for await (const line of lines) {
        const [tconst, avg, votes] = line.split('\t');
        if (!tconst?.startsWith('tt')) continue; // header
        const v = Number(votes);
        const r = Number(avg);
        if (!(v >= MIN_VOTES) || !(r > 0) || v >= 1e7) continue;
        next.set(Number(tconst.slice(2)), Math.round(r * 10) * 1e7 + v);
      }
      this.table = next;
      this.loadedAt = Date.now();
      this.log.info({ titles: next.size }, 'IMDb ratings loaded');
    } catch (err: any) {
      this.log.warn({ err: err.message }, 'IMDb ratings download failed; will retry');
      if (!this.loadedAt) setTimeout(() => void this.refresh(), 10 * 60_000).unref();
    }
  }
}

export const imdbRatings = new ImdbRatings();

export const imdbUrl = (imdbId: string) => `https://www.imdb.com/title/${imdbId}/`;
