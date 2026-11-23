import { Router } from 'express';
import { z } from 'zod/v4';
import { requireAuth } from '../auth/middleware';
import { getAuthStore, getRecsService } from '../lib/stores';
import { normaliseUsername, USERNAME_RE } from './auth';

/**
 * Friends are one-directional: adding someone lets you see their likes/watches and
 * use their taste in a watch party. You can only read activity of people you've added.
 */
const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const store = await getAuthStore();
    const list = await store.listFriends(req.user!.id);
    res.json({ friends: list.map(f => ({ username: f.user.username, addedAt: f.addedAt })) });
  } catch (err) { next(err); }
});

const AddBody = z.object({ username: z.string().max(40).transform(normaliseUsername) });

router.post('/', async (req, res, next) => {
  try {
    const parsed = AddBody.safeParse(req.body);
    if (!parsed.success || !USERNAME_RE.test(parsed.data.username)) {
      return void res.status(400).json({ error: 'Please enter a valid @username.' });
    }
    const store = await getAuthStore();
    const friend = await store.findByUsername(parsed.data.username);
    if (!friend) return void res.status(404).json({ error: 'No account found with that username.' });
    if (friend.id === req.user!.id) return void res.status(400).json({ error: "You can't add yourself as a friend." });
    if (await store.isFriend(req.user!.id, friend.id)) {
      return void res.status(409).json({ error: 'You already added this friend.' });
    }
    await store.addFriend(req.user!.id, friend.id);
    res.status(201).json({ friend: { username: friend.username, addedAt: Date.now() } });
  } catch (err) { next(err); }
});

/** Resolve :username to a user the caller has added, or send 404. */
async function addedFriend(callerId: string, raw: string) {
  const store = await getAuthStore();
  const friend = await store.findByUsername(normaliseUsername(raw));
  if (!friend || !(await store.isFriend(callerId, friend.id))) return null;
  return friend;
}

router.delete('/:username', async (req, res, next) => {
  try {
    const store = await getAuthStore();
    const friend = await store.findByUsername(normaliseUsername(req.params.username));
    if (friend) await store.removeFriend(req.user!.id, friend.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Latest likes/watches across everyone you've added, newest first. */
router.get('/activity', async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const [store, svc] = await Promise.all([getAuthStore(), getRecsService()]);
    const friends = await store.listFriends(req.user!.id);
    const perFriend = await Promise.all(friends.map(async f =>
      (await svc.recentActivity(f.user.id, limit)).map(e => ({ ...e, friendUsername: f.user.username }))));
    const events = perFriend.flat().sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    res.json({ events });
  } catch (err) { next(err); }
});

router.get('/:username/taste', async (req, res, next) => {
  try {
    const friend = await addedFriend(req.user!.id, req.params.username);
    if (!friend) return void res.status(404).json({ error: 'Not in your friends.' });
    const svc = await getRecsService();
    res.json({ genreScores: await svc.likedGenreScores(friend.id) });
  } catch (err) { next(err); }
});

export default router;
