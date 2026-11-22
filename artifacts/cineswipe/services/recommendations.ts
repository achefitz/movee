import { MediaItem } from './tmdb';

export type TasteProfile = {
  genreWeights: Record<number, number>;
  keywordWeights: Record<string, number>;
  castWeights: Record<number, number>;
  eraWeights: Record<number, number>;
  streamingAffinity: Record<number, number>;
  popularityTier: number;
  ratingThreshold: number;
  movieAffinity: number;
  tvAffinity: number;
  likedIds: Set<number>;
  skippedIds: Set<number>;
  collaborativeMap: Map<number, number[]>;
};

export type SortOptions = {
  swipeCount?: number;
  disableKeywordCast?: boolean;
  disableCollaborative?: boolean;
  warmupOnly?: boolean;
};

const DECAY = 0.85;

// 10 broad genre IDs used for cold-start calibration round-robin
const CALIBRATION_GENRES = [28, 35, 18, 27, 878, 10749, 53, 16, 14, 99];

function itemDecade(year: string): number | null {
  const y = parseInt(year, 10);
  if (!y || isNaN(y)) return null;
  return Math.floor(y / 10) * 10;
}

// rating × voteCount for calibration sorting — favours films both well-rated AND widely seen
function calibrationQuality(item: MediaItem): number {
  return item.rating * (item.voteCount || 0);
}

/**
 * Phase 1 (0–9 swipes): Genre-diverse deck for taste calibration.
 * Round-robins through 10 major genre buckets, each sorted by rating×voteCount.
 * Within each bucket's round-robin slot, alternates movie then TV.
 * No personalisation — purpose is to gather broad taste signals fast.
 */
export function calibrationSort(items: MediaItem[]): MediaItem[] {
  type BucketState = {
    movies: MediaItem[];
    tvs: MediaItem[];
    mIdx: number;
    tIdx: number;
    lastWasMovie: boolean;
  };

  const buckets = new Map<number, BucketState>();
  const ungroupedMovies: MediaItem[] = [];
  const ungroupedTvs: MediaItem[] = [];

  for (const g of CALIBRATION_GENRES) {
    buckets.set(g, { movies: [], tvs: [], mIdx: 0, tIdx: 0, lastWasMovie: false });
  }

  for (const item of items) {
    let placed = false;
    for (const g of CALIBRATION_GENRES) {
      if (item.genres.includes(g)) {
        const b = buckets.get(g)!;
        if (item.type === 'movie') b.movies.push(item);
        else b.tvs.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) {
      if (item.type === 'movie') ungroupedMovies.push(item);
      else ungroupedTvs.push(item);
    }
  }

  // Sort all sub-buckets by quality descending
  const sortQ = (a: MediaItem, b: MediaItem) => calibrationQuality(b) - calibrationQuality(a);
  for (const [, b] of buckets) {
    b.movies.sort(sortQ);
    b.tvs.sort(sortQ);
  }
  ungroupedMovies.sort(sortQ);
  ungroupedTvs.sort(sortQ);

  const seen = new Set<number>();
  const result: MediaItem[] = [];
  let ungroupedMIdx = 0;
  let ungroupedTIdx = 0;
  let ungroupedLastWasMovie = false;

  function pickFromBucket(b: BucketState): MediaItem | null {
    // Alternate movie/TV on each pick from this bucket
    if (!b.lastWasMovie) {
      // Try movie first
      while (b.mIdx < b.movies.length && seen.has(b.movies[b.mIdx].id)) b.mIdx++;
      if (b.mIdx < b.movies.length) {
        const item = b.movies[b.mIdx++];
        seen.add(item.id);
        b.lastWasMovie = true;
        return item;
      }
      // Fall back to TV
      while (b.tIdx < b.tvs.length && seen.has(b.tvs[b.tIdx].id)) b.tIdx++;
      if (b.tIdx < b.tvs.length) {
        const item = b.tvs[b.tIdx++];
        seen.add(item.id);
        b.lastWasMovie = false;
        return item;
      }
    } else {
      // Try TV first
      while (b.tIdx < b.tvs.length && seen.has(b.tvs[b.tIdx].id)) b.tIdx++;
      if (b.tIdx < b.tvs.length) {
        const item = b.tvs[b.tIdx++];
        seen.add(item.id);
        b.lastWasMovie = false;
        return item;
      }
      // Fall back to movie
      while (b.mIdx < b.movies.length && seen.has(b.movies[b.mIdx].id)) b.mIdx++;
      if (b.mIdx < b.movies.length) {
        const item = b.movies[b.mIdx++];
        seen.add(item.id);
        b.lastWasMovie = true;
        return item;
      }
    }
    return null;
  }

  while (result.length < items.length) {
    let addedThisRound = false;

    for (const g of CALIBRATION_GENRES) {
      const b = buckets.get(g)!;
      const item = pickFromBucket(b);
      if (item) {
        result.push(item);
        addedThisRound = true;
      }
    }

    // Ungrouped items: alternate movie/TV, append one per round
    const tryUngrouped = (): MediaItem | null => {
      if (!ungroupedLastWasMovie) {
        while (ungroupedMIdx < ungroupedMovies.length && seen.has(ungroupedMovies[ungroupedMIdx].id)) ungroupedMIdx++;
        if (ungroupedMIdx < ungroupedMovies.length) {
          const item = ungroupedMovies[ungroupedMIdx++];
          seen.add(item.id);
          ungroupedLastWasMovie = true;
          return item;
        }
      } else {
        while (ungroupedTIdx < ungroupedTvs.length && seen.has(ungroupedTvs[ungroupedTIdx].id)) ungroupedTIdx++;
        if (ungroupedTIdx < ungroupedTvs.length) {
          const item = ungroupedTvs[ungroupedTIdx++];
          seen.add(item.id);
          ungroupedLastWasMovie = false;
          return item;
        }
      }
      // Try the other type
      while (ungroupedMIdx < ungroupedMovies.length && seen.has(ungroupedMovies[ungroupedMIdx].id)) ungroupedMIdx++;
      if (ungroupedMIdx < ungroupedMovies.length) {
        const item = ungroupedMovies[ungroupedMIdx++];
        seen.add(item.id);
        ungroupedLastWasMovie = true;
        return item;
      }
      while (ungroupedTIdx < ungroupedTvs.length && seen.has(ungroupedTvs[ungroupedTIdx].id)) ungroupedTIdx++;
      if (ungroupedTIdx < ungroupedTvs.length) {
        const item = ungroupedTvs[ungroupedTIdx++];
        seen.add(item.id);
        ungroupedLastWasMovie = false;
        return item;
      }
      return null;
    };

    const ungroupedItem = tryUngrouped();
    if (ungroupedItem) {
      result.push(ungroupedItem);
      addedThisRound = true;
    }

    if (!addedThisRound) break;
  }

  return result;
}

export function buildTaste(
  likedItems: MediaItem[],
  skippedItems: MediaItem[],
  watchedItems: MediaItem[],
  collaborativeMap: Map<number, number[]>,
  keywordMap: Record<number, string[]>,
  castMap: Record<number, number[]>,
  watchedRatings: Record<number, 'up' | 'meh' | 'down'> = {}
): TasteProfile {
  const genreWeights: Record<number, number> = {};
  const keywordWeights: Record<string, number> = {};
  const castWeights: Record<number, number> = {};
  const eraWeights: Record<number, number> = {};
  const streamingAffinity: Record<number, number> = {};

  let movieScore = 0;
  let tvScore = 0;
  let totalRatingWeight = 0;
  let weightedRating = 0;
  let totalVoteWeight = 0;
  let weightedVoteTier = 0;

  const watchedPositive = watchedItems.filter(item => watchedRatings[item.id] !== 'down');
  const watchedNegative = watchedItems.filter(item => watchedRatings[item.id] === 'down');

  const positives: Array<{ item: MediaItem; mult: number }> = [
    ...likedItems.map((item, idx) => {
      const age = likedItems.length - 1 - idx;
      return { item, mult: Math.pow(DECAY, age) * 1.0 };
    }),
    ...watchedPositive.map((item, idx) => {
      const age = watchedPositive.length - 1 - idx;
      const r = watchedRatings[item.id];
      const mult = r === 'up' ? 2.0 : r === 'meh' ? 1.0 : 1.5;
      return { item, mult: Math.pow(DECAY, age) * mult };
    }),
  ];

  for (const { item, mult } of positives) {
    item.genres.forEach(g => {
      genreWeights[g] = (genreWeights[g] || 0) + mult;
    });

    if (item.type === 'movie') movieScore += mult;
    else tvScore += mult;

    const kws = keywordMap[item.id] || [];
    kws.forEach(kw => {
      keywordWeights[kw] = (keywordWeights[kw] || 0) + mult;
    });

    const castIds = castMap[item.id] || [];
    castIds.forEach(personId => {
      castWeights[personId] = (castWeights[personId] || 0) + mult;
    });

    const dec = itemDecade(item.year);
    if (dec !== null) {
      eraWeights[dec] = (eraWeights[dec] || 0) + mult;
    }

    item.streamingIds.forEach(id => {
      streamingAffinity[id] = (streamingAffinity[id] || 0) + 1;
    });

    if (item.rating > 0) {
      totalRatingWeight += mult;
      weightedRating += item.rating * mult;
    }

    if (item.voteCount && item.voteCount > 0) {
      const tier = Math.log10(item.voteCount);
      totalVoteWeight += mult;
      weightedVoteTier += tier * mult;
    }
  }

  skippedItems.forEach((item, idx) => {
    const age = skippedItems.length - 1 - idx;
    const penalty = Math.pow(DECAY, age) * 0.6;

    item.genres.forEach(g => {
      genreWeights[g] = (genreWeights[g] || 0) - penalty;
    });

    const kws = keywordMap[item.id] || [];
    kws.forEach(kw => {
      keywordWeights[kw] = (keywordWeights[kw] || 0) - penalty * 0.5;
    });

    const castIds = castMap[item.id] || [];
    castIds.forEach(personId => {
      castWeights[personId] = (castWeights[personId] || 0) - penalty * 0.5;
    });
  });

  watchedNegative.forEach((item, idx) => {
    const age = watchedNegative.length - 1 - idx;
    const penalty = Math.pow(DECAY, age) * 0.8;

    item.genres.forEach(g => {
      genreWeights[g] = (genreWeights[g] || 0) - penalty;
    });

    const kws = keywordMap[item.id] || [];
    kws.forEach(kw => {
      keywordWeights[kw] = (keywordWeights[kw] || 0) - penalty * 0.5;
    });

    const castIds = castMap[item.id] || [];
    castIds.forEach(personId => {
      castWeights[personId] = (castWeights[personId] || 0) - penalty * 0.5;
    });
  });

  const total = movieScore + tvScore || 1;

  return {
    genreWeights,
    keywordWeights,
    castWeights,
    eraWeights,
    streamingAffinity,
    popularityTier: totalVoteWeight > 0 ? weightedVoteTier / totalVoteWeight : 0,
    ratingThreshold: totalRatingWeight > 0 ? weightedRating / totalRatingWeight : 6.0,
    movieAffinity: movieScore / total,
    tvAffinity: tvScore / total,
    likedIds: new Set(likedItems.map(i => i.id)),
    skippedIds: new Set(skippedItems.map(i => i.id)),
    collaborativeMap,
  };
}

export function scoreItem(
  item: MediaItem,
  taste: TasteProfile,
  keywordMap: Record<number, string[]>,
  castMap: Record<number, number[]>,
  options?: SortOptions
): number {
  // Warm-up phase: only genre and era weights — no collaborative, keyword, cast, popularity, or quality signals
  if (options?.warmupOnly) {
    let warmScore = 0;
    item.genres.forEach(g => {
      warmScore += taste.genreWeights[g] || 0;
    });
    const yearNum = parseInt(item.year, 10);
    if (!isNaN(yearNum) && yearNum > 0) {
      const dec = Math.floor(yearNum / 10) * 10;
      let eraScore = (taste.eraWeights[dec] || 0);
      eraScore += ((taste.eraWeights[dec - 10] || 0) + (taste.eraWeights[dec + 10] || 0)) * 0.5;
      eraScore += ((taste.eraWeights[dec - 20] || 0) + (taste.eraWeights[dec + 20] || 0)) * 0.25;
      warmScore += eraScore * 0.5;
    }
    return warmScore;
  }

  let score = 0;

  item.genres.forEach(g => {
    score += taste.genreWeights[g] || 0;
  });

  if (item.type === 'movie') score += taste.movieAffinity * 2;
  else score += taste.tvAffinity * 2;

  if (!options?.disableKeywordCast) {
    const itemKeywords = keywordMap[item.id] || [];
    const kwScore = itemKeywords.reduce((sum, kw) => sum + (taste.keywordWeights[kw] || 0), 0);
    score += kwScore * 1.5;

    const itemCast = castMap[item.id] || [];
    let castScore = 0;
    for (const personId of itemCast) {
      castScore += taste.castWeights[personId] || 0;
    }
    score += Math.min(castScore * 2, 10);
  }

  const yearNum = parseInt(item.year, 10);
  if (!isNaN(yearNum) && yearNum > 0) {
    const dec = Math.floor(yearNum / 10) * 10;
    let eraScore = (taste.eraWeights[dec] || 0);
    eraScore += ((taste.eraWeights[dec - 10] || 0) + (taste.eraWeights[dec + 10] || 0)) * 0.5;
    eraScore += ((taste.eraWeights[dec - 20] || 0) + (taste.eraWeights[dec + 20] || 0)) * 0.25;
    score += eraScore * 0.5;
  }

  if (taste.popularityTier > 0 && item.voteCount && item.voteCount > 0) {
    const itemTier = Math.log10(item.voteCount);
    const dist = Math.abs(itemTier - taste.popularityTier);
    score += Math.max(0, 1 - dist / 2) * 0.5;
  }

  const qualityBonus = Math.max(0, Math.min((item.rating - taste.ratingThreshold) * 0.5, 2));
  score += qualityBonus;

  const streamScore = item.streamingIds.reduce(
    (sum, id) => sum + (taste.streamingAffinity[id] || 0),
    0
  );
  score += streamScore * 0.3;

  // Collaborative bonus: base 1.5, up to +2.5 more for genre diversity from source
  // Franchise sequels (high genre overlap) → ~1.5; cross-genre recs → up to 4.0
  if (!options?.disableCollaborative && taste.collaborativeMap.has(item.id)) {
    const sourceGenres = taste.collaborativeMap.get(item.id)!;
    const itemGenreSet = new Set(item.genres);
    const overlap = sourceGenres.filter(g => itemGenreSet.has(g)).length;
    const maxLen = Math.max(item.genres.length, sourceGenres.length, 1);
    const similarity = overlap / maxLen;
    const collaborativeBonus = 1.5 + (1 - similarity) * 2.5;
    score += collaborativeBonus;
  }

  return score;
}

/**
 * Prevent the same highest-weight genre from appearing 3+ times in a row.
 * Uses the taste profile's genre weights to determine each item's dominant genre.
 * Swaps the 3rd consecutive repeat with the next different-genre item in a lookahead window.
 */
function applyGenreDiversity(sorted: MediaItem[], genreWeights: Record<number, number>): MediaItem[] {
  if (sorted.length <= 3) return sorted;

  // For an item, its "primary" genre is whichever of its genres has the highest weight in the taste profile.
  // Falls back to first genre if no weights exist yet.
  const primaryGenre = (item: MediaItem): number => {
    if (item.genres.length === 0) return 0;
    let best = item.genres[0];
    let bestW = genreWeights[best] ?? 0;
    for (let i = 1; i < item.genres.length; i++) {
      const w = genreWeights[item.genres[i]] ?? 0;
      if (w > bestW) { best = item.genres[i]; bestW = w; }
    }
    return best;
  };

  const result: MediaItem[] = [];
  const remaining = [...sorted];
  const recentGenres: number[] = [];

  while (remaining.length > 0) {
    const next = remaining[0];
    const nextPrimary = primaryGenre(next);

    const isRepeat =
      recentGenres.length >= 2 &&
      recentGenres[recentGenres.length - 1] === nextPrimary &&
      recentGenres[recentGenres.length - 2] === nextPrimary;

    if (isRepeat) {
      const altIdx = remaining.findIndex((item, i) => i > 0 && primaryGenre(item) !== nextPrimary);
      if (altIdx > 0) {
        const [alt] = remaining.splice(altIdx, 1);
        result.push(alt);
        recentGenres.push(primaryGenre(alt));
      } else {
        remaining.shift();
        result.push(next);
        recentGenres.push(nextPrimary);
      }
    } else {
      remaining.shift();
      result.push(next);
      recentGenres.push(nextPrimary);
    }

    if (recentGenres.length > 3) recentGenres.shift();
  }

  return result;
}

export function sortByRecommendation(
  items: MediaItem[],
  taste: TasteProfile,
  keywordMap: Record<number, string[]>,
  castMap: Record<number, number[]>,
  options?: SortOptions
): MediaItem[] {
  const swipeCount = options?.swipeCount ?? 30;
  // More frequent discovery in warm-up; settle into confident recs after 30 swipes
  const DISCOVERY_EVERY = swipeCount < 30 ? 3 : 8;

  const topGenreIds = Object.entries(taste.genreWeights)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(e => Number(e[0]));

  const exploredGenres = new Set(topGenreIds);

  const unexploredItems: MediaItem[] = [];
  const regularItems: MediaItem[] = [];

  items.forEach(item => {
    const hasUnexplored = item.genres.some(g => !exploredGenres.has(g));
    if (hasUnexplored) unexploredItems.push(item);
    else regularItems.push(item);
  });

  const scoredRegular = regularItems
    .map(item => ({ item, score: scoreItem(item, taste, keywordMap, castMap, options) }))
    .sort((a, b) => b.score - a.score)
    .map(s => s.item);

  const scoredUnexplored = unexploredItems
    .map(item => ({ item, score: scoreItem(item, taste, keywordMap, castMap, options) }))
    .sort((a, b) => b.score - a.score)
    .map(s => s.item);

  const interleaved: MediaItem[] = [];
  let regularIdx = 0;
  let unexploredIdx = 0;
  let position = 0;

  while (regularIdx < scoredRegular.length || unexploredIdx < scoredUnexplored.length) {
    if ((position + 1) % DISCOVERY_EVERY === 0 && unexploredIdx < scoredUnexplored.length) {
      interleaved.push(scoredUnexplored[unexploredIdx++]);
    } else if (regularIdx < scoredRegular.length) {
      interleaved.push(scoredRegular[regularIdx++]);
    } else {
      interleaved.push(scoredUnexplored[unexploredIdx++]);
    }
    position++;
  }

  return applyGenreDiversity(interleaved, taste.genreWeights);
}
