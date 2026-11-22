import Anthropic from '@anthropic-ai/sdk';
import { Router } from 'express';
import { z } from 'zod/v4';
import { logger } from '../lib/logger';

const router = Router();

// Haiku: a 4–8 word label doesn't need a bigger model.
const MODEL = 'claude-haiku-5-5';

const Body = z.object({
  topGenres: z.array(z.string().max(40)).min(1).max(10),
  mediaTypeSplit: z.object({ moviePct: z.number(), tvPct: z.number() }).partial().optional(),
  totalLikes: z.number().int().nonnegative().optional(),
});

// Created lazily so the server starts without an Anthropic key.
let client: Anthropic | null = null;
const hasCredentials = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const EMOJI: Record<string, string> = {
  Action: '💥', Adventure: '🗺️', Animation: '🎨', Comedy: '😂', Crime: '🕵️', Documentary: '📚',
  Drama: '🎭', Family: '🏡', Fantasy: '🏰', History: '📜', Horror: '🔪', Music: '🎵', Mystery: '🔍',
  Romance: '💘', 'Sci-Fi': '🌌', Thriller: '😱', War: '🎖️', Western: '🤠',
};
const NOUN: Record<string, string> = {
  Action: 'Thrill Chaser', Adventure: 'Explorer', Animation: 'Animation Fan', Comedy: 'Comedy Connoisseur',
  Crime: 'Case Cracker', Documentary: 'Truth Seeker', Drama: 'Drama Devotee', Family: 'Movie-Night Host',
  Fantasy: 'Dreamer', History: 'Time Traveller', Horror: 'Fearless Viewer', Music: 'Music Lover',
  Mystery: 'Sleuth', Romance: 'Romantic', 'Sci-Fi': 'Sci-Fi Dreamer', Thriller: 'Edge-of-Seat Watcher',
  War: 'History Buff', Western: 'Frontier Fan',
};

/** Used when no Anthropic key is configured, or the API call fails. */
function ruleBasedLabel(genres: string[], moviePct = 50): string {
  const [a, b] = genres;
  const base = NOUN[a] ?? `${a} Fan`;
  const extra = b && b !== a ? ` & ${b} Lover` : '';
  const medium = moviePct >= 75 ? ' (Film Buff)' : moviePct <= 25 ? ' (Binge Watcher)' : '';
  return `${EMOJI[a] ?? '🎬'} The ${base}${extra}${medium}`;
}

router.post('/', async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'topGenres is required' });
    return;
  }
  const { topGenres, mediaTypeSplit, totalLikes = 0 } = parsed.data;
  const moviePct = mediaTypeSplit?.moviePct ?? 50;
  const tvPct = mediaTypeSplit?.tvPct ?? 50;

  if (!hasCredentials()) {
    res.json({ label: ruleBasedLabel(topGenres, moviePct), source: 'rules' });
    return;
  }

  try {
    client ??= new Anthropic();
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      messages: [{
        role: 'user',
        content: `You are a fun, creative movie/TV critic. Based on a user's taste profile, write a short, catchy "viewer type" label (4-8 words) that describes their taste. Start it with one fitting emoji.

Taste profile:
- Top genres: ${topGenres.join(', ')}
- Mix: ${moviePct}% movies, ${tvPct}% TV shows
- Titles liked: ${totalLikes}

Examples: "🌌 Sci-Fi Dreamer & Thriller Seeker", "😂 Comedy Connoisseur", "🔪 Dark Drama Devotee".

Reply with only the label: no quotes, no explanation.`,
      }],
    });

    const text = message.stop_reason === 'refusal'
      ? ''
      : message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('').trim();
    const label = text.split('\n')[0]?.replace(/^["']|["']$/g, '').slice(0, 80);
    res.json(label ? { label, source: 'claude' } : { label: ruleBasedLabel(topGenres, moviePct), source: 'rules' });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      logger.warn({ status: err.status, err: err.message }, 'viewer-type: Claude call failed, using rule-based label');
    } else {
      logger.warn({ err: (err as Error).message }, 'viewer-type: unexpected error, using rule-based label');
    }
    res.json({ label: ruleBasedLabel(topGenres, moviePct), source: 'rules' });
  }
});

export default router;
