import { Router } from 'express';
import { z } from 'zod/v4';
import { requireAuth } from '../auth/middleware';
import type { AuthStore, Follow } from '../auth/store';
import { getAuthStore, getRecsService } from '../lib/stores';
import { normaliseUsername, USERNAME_RE } from './auth';

/**
 * Follows. Following a public account is accepted at once; following a private account
 * sends a request its owner approves or declines. Likes, watches and taste are only
 * visible to accepted followers.
 */
const router = Router();
router.use(requireAuth);

const view = (f: Follow) => ({ username: f.user.username, status: f.status, since: f.since, isPrivate: f.user.isPrivate });

async function userByName(store: AuthStore, raw: string) {
  const name = normaliseUsername(raw);
  return USERNAME_RE.test(name) ? store.findByUsername(name) : null;
}

/** Everything the Following tab needs in one call. */
router.get('/', async (req, res, next) => {
  try {
    const store = await getAuthStore();
    const [following, followers] = await Promise.all([store.listFollowing(req.user!.id), store.listFollowers(req.user!.id)]);
    res.json({
      following: following.map(view),
      followers: followers.filter(f => f.status === 'accepted').map(view),
      requests: followers.filter(f => f.status === 'pending').map(view),
    });
  } catch (err) { next(err); }
});

const FollowBody = z.object({ username: z.string().max(40) });

router.post('/', async (req, res, next) => {
  try {
    const parsed = FollowBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Please enter a valid @username.' });
    const store = await getAuthStore();
    const target = await userByName(store, parsed.data.username);
    if (!target) return void res.status(404).json({ error: 'No account found with that username.' });
    if (target.id === req.user!.id) return void res.status(400).json({ error: "You can't follow yourself." });
    const existing = await store.followStatus(req.user!.id, target.id);
    if (existing) {
      return void res.status(409).json({ error: existing === 'pending' ? 'Request already sent.' : `You already follow ${target.username}.` });
    }
    const status = target.isPrivate ? 'pending' : 'accepted';
    await store.follow(req.user!.id, target.id, status);
    res.status(201).json({ follow: { username: target.username, status, since: Date.now(), isPrivate: target.isPrivate } });
  } catch (err) { next(err); }
});

/** Unfollow, or cancel a pending request. */
router.delete('/:username', async (req, res, next) => {
  try {
    const store = await getAuthStore();
    const target = await userByName(store, req.params.username);
    if (target) await store.unfollow(req.user!.id, target.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Approve or decline someone's request to follow you. */
router.post('/requests/:username/:decision', async (req, res, next) => {
  try {
    const { decision } = req.params;
    if (decision !== 'approve' && decision !== 'decline') return void res.status(404).json({ error: 'Not found' });
    const store = await getAuthStore();
    const requester = await userByName(store, req.params.username);
    if (!requester || (await store.followStatus(requester.id, req.user!.id)) !== 'pending') {
      return void res.status(404).json({ error: 'No pending request from that user.' });
    }
    if (decision === 'approve') await store.setFollowStatus(requester.id, req.user!.id, 'accepted');
    else await store.unfollow(requester.id, req.user!.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Remove one of your followers. */
router.delete('/followers/:username', async (req, res, next) => {
  try {
    const store = await getAuthStore();
    const follower = await userByName(store, req.params.username);
    if (follower) await store.unfollow(follower.id, req.user!.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Latest likes/watches from accounts you follow (accepted only), newest first. */
router.get('/activity', async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const [store, svc] = await Promise.all([getAuthStore(), getRecsService()]);
    const following = (await store.listFollowing(req.user!.id)).filter(f => f.status === 'accepted');
    const perUser = await Promise.all(following.map(async f =>
      (await svc.recentActivity(f.user.id, limit)).map(e => ({ ...e, friendUsername: f.user.username }))));
    res.json({ events: perUser.flat().sort((a, b) => b.timestamp - a.timestamp).slice(0, limit) });
  } catch (err) { next(err); }
});

/** Genre taste of someone you follow (accepted only), for watch parties. */
router.get('/:username/taste', async (req, res, next) => {
  try {
    const store = await getAuthStore();
    const target = await userByName(store, req.params.username);
    if (!target || (await store.followStatus(req.user!.id, target.id)) !== 'accepted') {
      return void res.status(404).json({ error: 'Follow this account (and be approved) to see their taste.' });
    }
    const svc = await getRecsService();
    res.json({ genreScores: await svc.likedGenreScores(target.id) });
  } catch (err) { next(err); }
});

export default router;
