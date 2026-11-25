import { randomUUID } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod/v4';
import { requireAuth } from '../auth/middleware';
import type { User } from '../auth/store';
import { logger } from '../lib/logger';
import { getAuthStore, getPartyStore, getRecsService } from '../lib/stores';
import type { Member, Party, Vote } from '../parties/store';
import { PARTY_MAX_GUESTS } from '../recsys/service';
import { parseKey } from '../recsys/types';
import { normaliseUsername, USERNAME_RE } from './auth';

/**
 * Group watch parties. The host invites up to 6 people they follow or who follow them (accepted
 * follows), choosing Movies or TV and streaming services. Invitees accept (adding services) or
 * decline. The party starts once everyone has answered, or when the host starts it with at least
 * one guest in: one 30-title deck from every joined member's taste. People who accept later join
 * the running party. A title every joined member says yes to is a match. Votes stay private:
 * only matches and yes-counts are shared.
 */
const router = Router();
router.use(requireAuth);

const Providers = z.array(z.number().int().positive()).max(20);
const CreateBody = z.object({
  usernames: z.array(z.string().min(2).max(40)).min(1).max(PARTY_MAX_GUESTS),
  mediaType: z.enum(['movie', 'tv']),
  providers: Providers.min(1),
});
const AcceptBody = z.object({ providers: Providers.default([]) });
const VoteBody = z.object({ key: z.string().max(40).refine(k => parseKey(k) !== null), vote: z.enum(['yes', 'no']) });

const OPEN = new Set(['pending', 'active']);
const bad = (res: Response, status: number, error: string) => void res.status(status).json({ error });

const joinedIds = (p: Party) => p.members.filter(m => m.status === 'joined').map(m => m.userId);

/** Keys every joined member said yes to, and yes-counts per key (joined members only). */
function tally(p: Party, votes: Vote[]) {
  const joined = new Set(joinedIds(p));
  const yes = new Map<string, number>();
  for (const v of votes) if (v.vote === 'yes' && joined.has(v.userId)) yes.set(v.itemKey, (yes.get(v.itemKey) ?? 0) + 1);
  const matches = p.deck.filter(k => joined.size >= 2 && (yes.get(k) ?? 0) >= joined.size);
  return { yes, matches, joined: joined.size };
}

async function names(ids: string[]) {
  const auth = await getAuthStore();
  const users = await Promise.all([...new Set(ids)].map(id => auth.findById(id)));
  return new Map(users.filter((u): u is User => !!u).map(u => [u.id, u.username]));
}

async function summary(p: Party, me: string, votes?: Vote[]) {
  const vs = votes ?? (p.status === 'active' || p.status === 'done' ? await (await getPartyStore()).votes(p.id) : []);
  const who = await names(p.members.map(m => m.userId));
  const progress = (id: string) => vs.filter(v => v.userId === id).length;
  const mine = p.members.find(m => m.userId === me);
  const t = tally(p, vs);
  return {
    id: p.id,
    status: p.status,
    role: p.hostId === me ? 'host' as const : 'guest' as const,
    myStatus: mine?.status ?? 'left',
    host: who.get(p.hostId) ?? 'someone',
    members: p.members.map(m => ({
      username: who.get(m.userId) ?? 'someone',
      role: m.role,
      status: m.status,
      progress: m.status === 'joined' ? progress(m.userId) : 0,
      isMe: m.userId === me,
    })),
    mediaType: p.mediaType,
    providers: p.providers,
    size: p.deck.length,
    myProgress: progress(me),
    joined: t.joined,
    matches: t.matches,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

async function load(id: string, me: string) {
  const p = await (await getPartyStore()).get(id);
  return p && p.members.some(m => m.userId === me) ? p : null;
}

/** Build the deck from everyone who has joined and start the party. */
async function start(p: Party): Promise<Party> {
  const auth = await getAuthStore();
  const users = (await Promise.all(joinedIds(p).map(id => auth.findById(id)))).filter((u): u is User => !!u);
  const deck = await (await getRecsService()).partyDeck(
    users.map(u => ({ id: u.id, favoriteGenres: u.favoriteGenres ?? [] })), p.mediaType, p.providers,
  );
  if (deck.length === 0) throw Object.assign(new Error('empty deck'), { status: 422 });
  return (await (await getPartyStore()).update(p.id, { status: 'active', deck }))!;
}

/** Once nobody is left to answer: start if anyone joined the host, otherwise call it off. */
async function settle(p: Party): Promise<Party> {
  if (p.status !== 'pending' || p.members.some(m => m.status === 'invited')) return p;
  if (joinedIds(p).length >= 2) return start(p);
  return (await (await getPartyStore()).update(p.id, { status: 'cancelled' }))!;
}

const emptyDeck = 'Nothing matched those streaming services. Try adding more.';

// Your parties: invites, ones you're gathering, in progress, and finished in the last week.
router.get('/', async (req, res, next) => {
  try {
    const me = req.user!.id;
    const weekAgo = Date.now() - 7 * 24 * 3600_000;
    const list = (await (await getPartyStore()).listFor(me, 50)).filter(p => {
      const m = p.members.find(x => x.userId === me);
      if (!m || m.status === 'declined' || m.status === 'left') return false;
      return OPEN.has(p.status) || (p.status === 'done' && p.updatedAt > weekAgo);
    });
    res.set('Cache-Control', 'no-store');
    res.json({ parties: await Promise.all(list.map(p => summary(p, me))) });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = CreateBody.safeParse(req.body);
    if (!b.success) return bad(res, 400, `Invite 1–${PARTY_MAX_GUESTS} people, and pick Movies or TV and at least one streaming service.`);
    const me = req.user!;
    const auth = await getAuthStore();
    const wanted = [...new Set(b.data.usernames.map(normaliseUsername))];
    const guests: User[] = [];
    const notFound: string[] = [], notFriends: string[] = [];
    for (const name of wanted) {
      const u = USERNAME_RE.test(name) ? await auth.findByUsername(name) : null;
      if (!u) { notFound.push(name); continue; }
      if (u.id === me.id) continue;
      const [out, back] = await Promise.all([auth.followStatus(me.id, u.id), auth.followStatus(u.id, me.id)]);
      if (out !== 'accepted' && back !== 'accepted') { notFriends.push(u.username); continue; }
      guests.push(u);
    }
    if (notFound.length) return bad(res, 404, `No account found for ${notFound.join(', ')}.`);
    if (notFriends.length) return bad(res, 403, `You can only invite people you follow or who follow you (${notFriends.join(', ')}).`);
    if (!guests.length) return bad(res, 400, 'Invite at least one other person.');

    const now = Date.now();
    const members: Member[] = [
      { userId: me.id, role: 'host', status: 'joined' },
      ...guests.map(g => ({ userId: g.id, role: 'guest' as const, status: 'invited' as const })),
    ];
    const party = await (await getPartyStore()).create({
      id: randomUUID(), hostId: me.id, status: 'pending', mediaType: b.data.mediaType,
      providers: [...new Set(b.data.providers)], deck: [], members, createdAt: now, updatedAt: now,
    });
    res.status(201).json({ party: await summary(party, me.id) });
  } catch (err) { next(err); }
});

router.post('/:id/accept', async (req, res, next) => {
  try {
    const me = req.user!.id;
    const b = AcceptBody.safeParse(req.body ?? {});
    if (!b.success) return bad(res, 400, 'Invalid request');
    let p = await load(String(req.params.id), me);
    const m = p?.members.find(x => x.userId === me);
    if (!p || !m || m.role === 'host') return bad(res, 404, 'Invite not found.');
    if (p.status === 'cancelled') return bad(res, 409, 'This watch party was called off.');
    if (m.status === 'joined') return void res.json({ party: await summary(p, me) });
    const store = await getPartyStore();
    if (p.status === 'pending' && b.data.providers.length) {
      p = (await store.update(p.id, { providers: [...new Set([...p.providers, ...b.data.providers])] }))!;
    }
    await store.setMember(p.id, me, 'joined');
    p = (await store.get(p.id))!;
    if (p.status === 'done') p = (await store.update(p.id, { status: 'active' }))!; // a late joiner reopens it
    p = await settle(p);
    res.json({ party: await summary(p, me) });
  } catch (err: any) {
    if (err.status === 422) return bad(res, 422, emptyDeck);
    logger.error({ err: err.message }, 'party accept failed');
    next(err);
  }
});

router.post('/:id/decline', async (req, res, next) => {
  try {
    const me = req.user!.id;
    const p = await load(String(req.params.id), me);
    const m = p?.members.find(x => x.userId === me);
    if (!p || !m || m.role === 'host' || m.status !== 'invited') return bad(res, 404, 'Invite not found.');
    const store = await getPartyStore();
    await store.setMember(p.id, me, 'declined');
    await settle((await store.get(p.id))!);
    res.json({ ok: true });
  } catch (err: any) {
    if (err.status === 422) return void res.json({ ok: true }); // declined; the host can retry with more services
    next(err);
  }
});

// Host: start now with whoever has joined (at least one guest).
router.post('/:id/start', async (req, res, next) => {
  try {
    const me = req.user!.id;
    const p = await load(String(req.params.id), me);
    if (!p || p.hostId !== me) return bad(res, 404, 'Watch party not found.');
    if (p.status !== 'pending') return void res.json({ party: await summary(p, me) });
    if (joinedIds(p).length < 2) return bad(res, 409, 'Wait until at least one person has joined.');
    res.json({ party: await summary(await start(p), me) });
  } catch (err: any) {
    if (err.status === 422) return bad(res, 422, emptyDeck);
    next(err);
  }
});

// Host: call it off for everyone. Guest: leave (your votes stop counting).
router.delete('/:id', async (req, res, next) => {
  try {
    const me = req.user!.id;
    const p = await load(String(req.params.id), me);
    if (!p) return bad(res, 404, 'Watch party not found.');
    const store = await getPartyStore();
    if (p.hostId === me) {
      if (OPEN.has(p.status)) await store.update(p.id, { status: 'cancelled' });
    } else {
      await store.setMember(p.id, me, 'left');
      const after = (await store.get(p.id))!;
      if (after.status === 'pending') await settle(after).catch(() => {});
      else if (after.status === 'active' && joinedIds(after).length < 2) await store.update(p.id, { status: 'cancelled' });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// The deck (with your own votes so far), matches and how many want each title.
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
      yesCounts: Object.fromEntries(tally(p, votes).yes),
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
    if (!joinedIds(p).includes(me)) return bad(res, 403, 'Join the watch party first.');
    if (p.status !== 'active' && p.status !== 'done') return bad(res, 409, 'This watch party is not running.');
    if (!p.deck.includes(b.data.key)) return bad(res, 400, 'That title is not in this watch party.');
    const store = await getPartyStore();
    await store.vote(p.id, { userId: me, itemKey: b.data.key, vote: b.data.vote });
    const votes = await store.votes(p.id);
    const t = tally(p, votes);
    const match = b.data.vote === 'yes' && t.matches.includes(b.data.key);
    const done = joinedIds(p).every(u => votes.filter(v => v.userId === u).length >= p.deck.length);
    const now = done && p.status === 'active' ? await store.update(p.id, { status: 'done' }) : p;
    res.json({ match, party: await summary(now ?? p, me, votes) });
  } catch (err) { next(err); }
});

export default router;
