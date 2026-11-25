import { createMemoryAuthStore, createPgAuthStore, type AuthStore } from '../auth/store';
import { RecsService } from '../recsys/service';
import { createMemoryStore, createPgStore } from '../recsys/store';
import { logger } from './logger';
import { createMemoryPartyStore, createPgPartyStore, type PartyStore } from '../parties/store';

let authPromise: Promise<AuthStore> | null = null;
let recsPromise: Promise<RecsService> | null = null;
let partyPromise: Promise<PartyStore> | null = null;

const usePg = () => !!process.env.DATABASE_URL;

export function getAuthStore(): Promise<AuthStore> {
  if (!authPromise) {
    if (!usePg()) logger.warn('DATABASE_URL not set — accounts are kept in memory and lost on restart');
    authPromise = usePg() ? createPgAuthStore() : Promise.resolve(createMemoryAuthStore());
    authPromise.catch(() => { authPromise = null; });
  }
  return authPromise;
}

export function getRecsService(): Promise<RecsService> {
  if (!recsPromise) {
    recsPromise = (async () => {
      if (!usePg()) logger.warn('DATABASE_URL not set — recommender is using an in-memory store (swipes are lost on restart)');
      const store = usePg() ? await createPgStore() : createMemoryStore();
      const svc = new RecsService(store, logger);
      await svc.init();
      return svc;
    })();
    recsPromise.catch(() => { recsPromise = null; }); // retry init on next request
  }
  return recsPromise;
}

export function getPartyStore(): Promise<PartyStore> {
  if (!partyPromise) {
    partyPromise = usePg() ? createPgPartyStore() : Promise.resolve(createMemoryPartyStore());
    partyPromise.catch(() => { partyPromise = null; });
  }
  return partyPromise;
}
