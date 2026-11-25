import { apiFetch } from './api';
import type { MediaItem } from './tmdb';

export type PartyStatus = 'pending' | 'active' | 'done' | 'declined' | 'cancelled';

export type PartySummary = {
  id: string;
  status: PartyStatus;
  role: 'host' | 'guest';
  /** The other person's @username. */
  with: string;
  mediaType: 'movie' | 'tv';
  providers: number[];
  size: number;
  myProgress: number;
  theirProgress: number;
  /** Item keys both of you said yes to. */
  matches: string[];
  createdAt: number;
  updatedAt: number;
};

export type PartyView = { party: PartySummary; items: MediaItem[]; myVotes: Record<string, 'yes' | 'no'> };

export const listParties = () => apiFetch<{ parties: PartySummary[] }>('/api/parties').then(r => r.parties);

export const inviteToParty = (username: string, mediaType: 'movie' | 'tv', providers: number[]) =>
  apiFetch<{ party: PartySummary }>('/api/parties', { body: { username, mediaType, providers } }).then(r => r.party);

export const acceptParty = (id: string, providers: number[]) =>
  apiFetch<{ party: PartySummary }>(`/api/parties/${id}/accept`, { body: { providers } }).then(r => r.party);

export const declineParty = (id: string) => apiFetch(`/api/parties/${id}/decline`, { body: {} });

export const leaveParty = (id: string) => apiFetch(`/api/parties/${id}`, { method: 'DELETE' });

export const getParty = (id: string) => apiFetch<PartyView>(`/api/parties/${id}`);

export const voteInParty = (id: string, key: string, vote: 'yes' | 'no') =>
  apiFetch<{ match: boolean; party: PartySummary }>(`/api/parties/${id}/vote`, { body: { key, vote } });
