import { randomUUID } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod/v4';
import { requireAuth } from '../auth/middleware';
import type { User } from '../auth/store';
import { logger } from '../lib/logger';
import { getAuthStore, getPartyStore, getRecsService } from '../lib/stores';
import type { Party, Vote } from '../parties/store';
import { parseKey } from '../recsys/types';
import { normaliseUsername, USERNAME_RE } from './auth';

/**
 * Watch parties. Host invites someone they follow or who follows them (accepted follows),
 * choosing Movies or TV and streaming services. The guest accepts (optionally adding their
 * services), which builds one 30-title deck from both taste profiles. Both swipe it; a
 * title both say yes to is a match. Only matches are revealed, never the other person's no's.
 */
const router = Router();
router.use(requireAuth);

const Providers = z.array(z.number().int().positive()).max(20);
const CreateBody = z.object({ username: z.string().min(2).max(40), mediaType: z.enum(['movie', 'tv']), providers: Providers.min(1) });
const AcceptBody = z.object({ providers: Providers.default([]) });
const VoteBody = z.object({ key: z.string().max(40).refine(k => parseKey(k) !== null), vote: z.enum(['yes', 'no']) });

const OPEN = new Set(['pending', 'active']);
const bad = (res: Response, status: number, error: string) => void res.status(status).json({ error });

async function summary(p: Party, me: string, votes?: Vote[]) {
  const auth = await getAuthStore();
  const otherId = p.hostId === me ? p.guestId : p.hostId;
  const other = await auth.findById(otherId);
  const vs = votes ?? (p.status === 'active' || p.status === 'done' ? await (await getPartyStore()).votes(p.id) : []);
  const mine = vs.filter(v => v.userId === me), theirs = vs.filter(v => v.userId === otherId);
  const theirYes = new Set(theirs.filter(v => v.vote === 'yes').map(v => v.itemKey));
  return {
    id: p.id,
    status: p.status,
    role: p.hostId === me ? 'host' as const : 'guest' as const,
    with: other?.username ?? 'someone',
    mediaType: p.mediaType,
    providers: p.providers,
    size: p.deck.length,
    myProgress: mine.length,
    theirProgress: theirs.length,
    matches: mine.filter(v => v.vote === 'yes' && theirYes.has(v.itemKey)).map(v => v.itemKey),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

async function load(id: string, me: string) {
  const p = await (await getPartyStore()).get(id);
  return p && (p.hostId === me || p.guestId === me) ? p : null;
}

// Your parties: invites, ones you sent, in progress, and finished in the last week.
router.get('/', async (req, res, next) => {
  try {
    const me = req.user!.id;
    const weekAgo = Date.now() - 7 * 24 * 3600_000;
    const list = (await (await getPartyStore()).listFor(me, 50))
      .filter(p => OPEN.has(p.status) || (p.status === 'done' && p.updatedAt > weekAgo));
    res.set('Cache-Control', 'no-store');
    res.json({ parties: await Promise.all(list.map(p => summary(p, me))) });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = CreateBody.safeParse(req.body);
    if (!b.success) return bad(res, 400, 'Pick Movies or TV and at least one streaming service.');
    const me = req.user!;
    const name = normaliseUsername(b.data.username);
    const auth = await getAuthStore();
    const guest = USERNAME_RE.test(name) ? await auth.findByUsername(name) : null;
    if (!guest) return bad(res, 404, 'No account found with that username.');
    if (guest.id === me.id) return bad(res, 400, "You can't throw a watch party with yourself.");
    const [out, back] = await Promise.all([auth.followStatus(me.id, guest.id), auth.followStatus(guest.id, me.id)]);
    if (out !== 'accepted' && back !== 'accepted') return bad(res, 403, 'You can only invite people you follow or who follow you.');

    const store = await getPartyStore();
    // One open party per pair: a new invite replaces an older one.
    for (const p of await store.listFor(me.id, 50)) {
      const pair = (p.hostId === me.id && p.guestId === guest.id) || (p.hostId === guest.id && p.guestId === me.id);
      if (pair && OPEN.has(p.status)) await store.update(p.id, { status: 'cancelled' });
    }
    const now = Date.now();
    const party = await store.create({
      id: randomUUID(), hostId: me.id, guestId: guest.id, status: 'pending',
      mediaType: b.data.mediaType, providers: [...new Set(b.data.providers)], deck: [], createdAt: now, updatedAt: now,
    });
    res.status(201).json({ party: await summary(party, me.id) });
  } catch (err) { next(err); }
});

router.post('/:id/accept', async (req, res, next) => {
  try {
    const me = req.user!;
    const b = AcceptBody.safeParse(req.body ?? {});
    if (!b.success) return bad(res, 400, 'Invalid request');
    const p = await load(String(req.params.id), me.id);
    if (!p || p.guestId !== me.id) return bad(res, 404, 'Invite not found.');
    if (p.status !== 'pending') return bad(res, 409, p.status === 'cancelled' ? 'This invite was cancelled.' : 'This invite was already answered.');
    const host = await (await getAuthStore()).findById(p.hostId);
    if (!host) return bad(res, 404, 'Invite not found.');
    const providers = [...new Set([...p.providers, ...b.data.providers])];
    const svc = await getRecsService();
    const deck = await svc.partyDeck(
      { id: host.id, favoriteGenres: host.favoriteGenres ?? [] },
      { id: me.id, favoriteGenres: (me as User).favoriteGenres ?? [] },
      p.mediaType, providers,
    );
    if (deck.length === 0) return bad(res, 422, 'Nothing matched those streaming services. Try adding more.');
    const updated = await (await getPartyStore()).update(p.id, { status: 'active', providers, deck });
    res.json({ party: await summary(updated!, me.id) });
  } catch (err: any) {
    logger.error({ err: err.message }, 'party deck failed');
    next(err);
  }
});

router.post('/:id/decline', async (req, res, next) => {
  try {
    const p = await load(String(req.params.id), req.user!.id);
    if (!p || p.guestId !== req.user!.id || p.status !== 'pending') return bad(res, 404, 'Invite not found.');
    await (await getPartyStore()).update(p.id, { status: 'declined' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Either side can call it off (cancel an invite, or leave a party in progress).
router.delete('/:id', async (req, res, next) => {
  try {
    const p = await load(String(req.params.id), req.user!.id);
    if (!p) return bad(res, 404, 'Watch party not found.');
    if (OPEN.has(p.status)) await (await getPartyStore()).update(p.id, { status: 'cancelled' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// The deck (with your own votes so far) and the matches.
router.get('/:id', async (req, res, next) => {
  try {
    const me = req.user!.id;
    const p = await load(String(req.params.id), me);
    if (!p) return bad(res, 404, 'Watch party not found.');
    const votes = await (await getPartyStore()).votes(p.id);
    const items = p.deck.length ? await (await getRecsService()).partyItems(p.deck) : [];
    res.set('Cache-Control', 'no-store');
    res.json({
      party: await summary(p, me, votes),
      items,
      myVotes: Object.fromEntries(votes.filter(v => v.userId === me).map(v => [v.itemKey, v.vote])),
    });
  } catch (err) { next(err); }
});

router.post('/:id/vote', async (req, res, next) => {
  try {
    const me = req.user!.id;
    const b = VoteBody.safeParse(req.body);
    if (!b.success) return bad(res, 400, 'Invalid request');
    const p = await load(String(req.params.id), me);
    if (!p) return bad(res, 404, 'Watch party not found.');
    if (p.status !== 'active' && p.status !== 'done') return bad(res, 409, 'This watch party is not running.');
    if (!p.deck.includes(b.data.key)) return bad(res, 400, 'That title is not in this watch party.');
    const store = await getPartyStore();
    await store.vote(p.id, { userId: me, itemKey: b.data.key, vote: b.data.vote });
    const votes = await store.votes(p.id);
    const otherId = p.hostId === me ? p.guestId : p.hostId;
    const match = b.data.vote === 'yes' && votes.some(v => v.userId === otherId && v.itemKey === b.data.key && v.vote === 'yes');
    const done = [me, otherId].every(u => votes.filter(v => v.userId === u).length >= p.deck.length);
    const now = done && p.status === 'active' ? await store.update(p.id, { status: 'done' }) : p;
    res.json({ match, party: await summary(now ?? p, me, votes) });
  } catch (err) { next(err); }
});

export default router;
