import { Router } from 'express';
import { requireAuth } from '../auth/middleware';
import { getAuthStore, getRecsService } from '../lib/stores';
import { normaliseUsername, USERNAME_RE } from './auth';

/**
 * GET /api/users/:username: someone's profile. Likes and watches are visible when the
 * account is public, it's your own, or you're an approved follower of a private account.
 */
const router = Router();
router.use(requireAuth);

const LIST_LIMIT = 200;

router.get('/:username', async (req, res, next) => {
  try {
    const name = normaliseUsername(req.params.username);
    if (!USERNAME_RE.test(name)) return void res.status(404).json({ error: 'No account found with that username.' });
    const store = await getAuthStore();
    const target = await store.findByUsername(name);
    if (!target) return void res.status(404).json({ error: 'No account found with that username.' });

    const me = req.user!.id;
    const isMe = target.id === me;
    const [followers, following, myStatus, theirStatus] = await Promise.all([
      store.listFollowers(target.id),
      store.listFollowing(target.id),
      isMe ? Promise.resolve(null) : store.followStatus(me, target.id),
      isMe ? Promise.resolve(null) : store.followStatus(target.id, me),
    ]);
    const canView = isMe || !target.isPrivate || myStatus === 'accepted';

    let liked: unknown[] = [];
    let watched: unknown[] = [];
    if (canView) {
      const svc = await getRecsService();
      const events = await svc.recentActivity(target.id, LIST_LIMIT);
      liked = events.filter(e => e.action === 'liked').map(e => ({ ...e.item, at: e.timestamp }));
      watched = events.filter(e => e.action === 'watched').map(e => ({ ...e.item, at: e.timestamp }));
    }

    res.json({
      user: {
        username: target.username,
        isPrivate: target.isPrivate,
        joined: target.createdAt,
        followers: followers.filter(f => f.status === 'accepted').length,
        following: following.filter(f => f.status === 'accepted').length,
      },
      isMe,
      followStatus: myStatus,          // you → them: null | 'pending' | 'accepted'
      followsYou: theirStatus === 'accepted',
      canView,
      liked,
      watched,
    });
  } catch (err) { next(err); }
});

export default router;
