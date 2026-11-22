import { Router } from 'express';
import { anthropic } from '@workspace/integrations-anthropic-ai';

const router = Router();

router.post('/', async (req: any, res: any) => {
  try {
    const { topGenres, mediaTypeSplit, totalLikes } = req.body;

    if (!topGenres || !Array.isArray(topGenres) || topGenres.length === 0) {
      return res.status(400).json({ error: 'topGenres is required' });
    }

    const genreList = topGenres.join(', ');
    const moviePct = mediaTypeSplit?.moviePct ?? 50;
    const tvPct = mediaTypeSplit?.tvPct ?? 50;

    const prompt = `You are a fun, creative movie/TV critic. Based on a user's taste profile, generate a short, catchy "viewer type" label (4-8 words) that describes their taste in cinema and TV. Include a fitting emoji at the start.

User's taste profile:
- Top genres they love: ${genreList}
- Content mix: ${moviePct}% movies, ${tvPct}% TV shows
- Total liked titles: ${totalLikes}

Examples of good labels:
- 🎬 The Action Romantic
- 🌌 Sci-Fi Dreamer & Thriller Seeker  
- 😂 Comedy Connoisseur
- 🔪 Dark Drama Devotee
- 🏰 Fantasy & Adventure Enthusiast

Respond with ONLY the label itself, nothing else. No quotes, no explanation.`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = message.content[0];
    const label = block.type === 'text' ? block.text.trim() : null;

    if (!label) {
      return res.status(500).json({ error: 'No response from AI' });
    }

    res.json({ label });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Viewer type generation failed');
    res.status(500).json({ error: 'Failed to generate viewer type' });
  }
});

export default router;
