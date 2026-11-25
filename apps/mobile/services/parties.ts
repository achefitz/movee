import { apiFetch } from './api';
import type { MediaItem } from './tmdb';

export type PartyStatus = 'pending' | 'active' | 'done' | 'declined' | 'cancelled';
export type MemberStatus = 'invited' | 'joined' | 'declined' | 'left';

export type PartyMember = {
  username: string;
  role: 'host' | 'guest';
  status: MemberStatus;
  /** Cards swiped so far (joined members). */
  progress: number;
  isMe: boolean;
};

export type PartySummary = {
  id: string;
  /** pending = gathering people; active = swiping; done = everyone finished. */
  status: PartyStatus;
  role: 'host' | 'guest';
  myStatus: MemberStatus;
  /** The host's @username. */
  host: string;
  members: PartyMember[];
  mediaType: 'movie' | 'tv';
  providers: number[];
  size: number;
  myProgress: number;
  /** How many have joined (host included). */
  joined: number;
  /** Item keys every joined member said yes to. */
  matches: string[];
  createdAt: number;
  updatedAt: number;
};

export type PartyView = {
  party: PartySummary;
  items: MediaItem[];
  myVotes: Record<string, 'yes' | 'no'>;
  /** Item key → how many joined members said yes. */
  yesCounts: Record<string, number>;
};

/** Up to this many people can be invited to one party. */
export const MAX_PARTY_GUESTS = 6;

export const listParties = () => apiFetch<{ parties: PartySummary[] }>('/api/parties').then(r => r.parties);

export const createParty = (usernames: string[], mediaType: 'movie' | 'tv', providers: number[]) =>
  apiFetch<{ party: PartySummary }>('/api/parties', { body: { usernames, mediaType, providers } }).then(r => r.party);

export const acceptParty = (id: string, providers: number[]) =>
  apiFetch<{ party: PartySummary }>(`/api/parties/${id}/accept`, { body: { providers } }).then(r => r.party);

export const declineParty = (id: string) => apiFetch(`/api/parties/${id}/decline`, { body: {} });

export const startParty = (id: string) =>
  apiFetch<{ party: PartySummary }>(`/api/parties/${id}/start`, { body: {} }).then(r => r.party);

/** Host: call it off for everyone. Guest: leave. */
export const leaveParty = (id: string) => apiFetch(`/api/parties/${id}`, { method: 'DELETE' });

export const getParty = (id: string) => apiFetch<PartyView>(`/api/parties/${id}`);

export const voteInParty = (id: string, key: string, vote: 'yes' | 'no') =>
  apiFetch<{ match: boolean; party: PartySummary }>(`/api/parties/${id}/vote`, { body: { key, vote } });

/** "@ana, @ben and 2 others" (you are left out). */
export function partyNames(p: PartySummary, max = 2): string {
  const others = p.members.filter(m => !m.isMe && m.status !== 'declined' && m.status !== 'left').map(m => m.username);
  if (others.length <= max) return others.join(' & ') || 'your group';
  return `${others.slice(0, max).join(', ')} +${others.length - max}`;
}
