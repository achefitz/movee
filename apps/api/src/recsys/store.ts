import { labelOf, type Action, type CatalogItem, type Interaction } from './types';
import type { EnsembleModel, TrainingRow } from './ranker';

export type ImpressionRow = {
  id: string;
  userId: string;
  itemKey: string;
  featureVersion: number;
  features: number[];
  position: number;
  score: number;
};

export interface RecsStore {
  getUserInteractions(userId: string): Promise<Interaction[]>;
  getAllInteractions(limit: number): Promise<Interaction[]>;
  upsertInteraction(i: Interaction, impressionId: string | null): Promise<void>;
  deleteInteraction(userId: string, itemKey: string): Promise<void>;
  getItems(keys: string[]): Promise<Map<string, CatalogItem>>;
  getRecentItems(limit: number): Promise<CatalogItem[]>;
  upsertItems(items: CatalogItem[]): Promise<void>;
  logImpressions(rows: ImpressionRow[]): Promise<void>;
  getTrainingRows(featureVersion: number, limit: number): Promise<TrainingRow[]>;
  countTrainingRows(featureVersion: number): Promise<number>;
  pruneImpressions(olderThanDays: number): Promise<void>;
  saveModel(model: EnsembleModel): Promise<void>;
  loadLatestModel(featureVersion: number): Promise<EnsembleModel | null>;
}

// ------------------------------------------------------------------ Postgres

type Db = typeof import('@muse/db');

export async function createPgStore(): Promise<RecsStore> {
  const {
    db, recsInteractions: I, recsImpressions: P, recsMediaItems: M, recsModels: R,
    and, desc, eq, inArray, lt, sql,
  } = (await import('@muse/db')) as Db;
  const CHUNK = 500;

  const toInteraction = (r: { userId: string; itemKey: string; action: string; createdAt: Date }): Interaction => ({
    userId: r.userId, itemKey: r.itemKey, action: r.action as Action, ts: r.createdAt.getTime(),
  });

  return {
    async getUserInteractions(userId) {
      const rows = await db.select().from(I).where(eq(I.userId, userId)).orderBy(I.createdAt);
      return rows.map(toInteraction);
    },
    async getAllInteractions(limit) {
      const rows = await db.select().from(I).orderBy(desc(I.createdAt)).limit(limit);
      return rows.map(toInteraction);
    },
    async upsertInteraction(i, impressionId) {
      await db.insert(I)
        .values({ userId: i.userId, itemKey: i.itemKey, action: i.action, impressionId, createdAt: new Date(i.ts) })
        .onConflictDoUpdate({
          target: [I.userId, I.itemKey],
          set: { action: i.action, impressionId, createdAt: new Date(i.ts) },
        });
    },
    async deleteInteraction(userId, itemKey) {
      await db.delete(I).where(and(eq(I.userId, userId), eq(I.itemKey, itemKey)));
    },
    async getItems(keys) {
      const out = new Map<string, CatalogItem>();
      for (let i = 0; i < keys.length; i += CHUNK) {
        const rows = await db.select().from(M).where(inArray(M.key, keys.slice(i, i + CHUNK)));
        for (const r of rows) out.set(r.key, r.data as CatalogItem);
      }
      return out;
    },
    async getRecentItems(limit) {
      const rows = await db.select().from(M).orderBy(desc(M.updatedAt)).limit(limit);
      return rows.map(r => r.data as CatalogItem);
    },
    async upsertItems(input) {
      // Postgres rejects an upsert that touches the same key twice in one statement.
      const items = [...new Map(input.map(it => [it.key, it])).values()];
      for (let i = 0; i < items.length; i += CHUNK) {
        const batch = items.slice(i, i + CHUNK);
        if (batch.length === 0) continue;
        await db.insert(M)
          .values(batch.map(it => ({ key: it.key, data: it, updatedAt: new Date() })))
          .onConflictDoUpdate({ target: M.key, set: { data: sql`excluded.data`, updatedAt: sql`excluded.updated_at` } });
      }
    },
    async logImpressions(rows) {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK);
        if (batch.length) await db.insert(P).values(batch).onConflictDoNothing();
      }
    },
    async getTrainingRows(featureVersion, limit) {
      const rows = await db
        .select({ userId: I.userId, action: I.action, ts: I.createdAt, x: P.features })
        .from(I)
        .innerJoin(P, eq(P.id, I.impressionId))
        .where(eq(P.featureVersion, featureVersion))
        .orderBy(desc(I.createdAt))
        .limit(limit);
      return rows.map(r => ({ userId: r.userId, y: labelOf(r.action as Action), ts: r.ts.getTime(), x: r.x }));
    },
    async countTrainingRows(featureVersion) {
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(I)
        .innerJoin(P, eq(P.id, I.impressionId))
        .where(eq(P.featureVersion, featureVersion));
      return r?.n ?? 0;
    },
    async pruneImpressions(olderThanDays) {
      const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
      // Keep impressions that became training rows; drop stale unswiped ones.
      await db.delete(P).where(and(
        lt(P.servedAt, cutoff),
        sql`not exists (select 1 from ${I} where ${I.impressionId} = ${P.id})`,
      ));
    },
    async saveModel(model) {
      await db.insert(R).values({ featureVersion: model.featureVersion, model, metrics: model.metrics });
    },
    async loadLatestModel(featureVersion) {
      const [r] = await db.select().from(R).where(eq(R.featureVersion, featureVersion)).orderBy(desc(R.createdAt)).limit(1);
      return r ? (r.model as EnsembleModel) : null;
    },
  };
}

// ------------------------------------------------------------------ in-memory (tests, or no DATABASE_URL)

export function createMemoryStore(): RecsStore {
  const interactions = new Map<string, Interaction & { impressionId: string | null }>();
  const items = new Map<string, { item: CatalogItem; at: number }>();
  const impressions = new Map<string, ImpressionRow & { at: number }>();
  const models: EnsembleModel[] = [];
  const k = (u: string, i: string) => `${u}\u0000${i}`;

  const training = (fv: number) => [...interactions.values()]
    .filter(i => i.impressionId && impressions.get(i.impressionId)?.featureVersion === fv)
    .map(i => ({ userId: i.userId, y: labelOf(i.action), ts: i.ts, x: impressions.get(i.impressionId!)!.features }));

  return {
    async getUserInteractions(userId) {
      return [...interactions.values()].filter(i => i.userId === userId).sort((a, b) => a.ts - b.ts);
    },
    async getAllInteractions(limit) {
      return [...interactions.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
    },
    async upsertInteraction(i, impressionId) { interactions.set(k(i.userId, i.itemKey), { ...i, impressionId }); },
    async deleteInteraction(userId, itemKey) { interactions.delete(k(userId, itemKey)); },
    async getItems(keys) {
      const out = new Map<string, CatalogItem>();
      for (const key of keys) { const v = items.get(key); if (v) out.set(key, v.item); }
      return out;
    },
    async getRecentItems(limit) {
      return [...items.values()].sort((a, b) => b.at - a.at).slice(0, limit).map(v => v.item);
    },
    async upsertItems(list) { const at = Date.now(); for (const it of list) items.set(it.key, { item: it, at }); },
    async logImpressions(rows) { const at = Date.now(); for (const r of rows) impressions.set(r.id, { ...r, at }); },
    async getTrainingRows(fv, limit) { return training(fv).sort((a, b) => b.ts - a.ts).slice(0, limit); },
    async countTrainingRows(fv) { return training(fv).length; },
    async pruneImpressions() {},
    async saveModel(m) { models.push(m); },
    async loadLatestModel(fv) { return [...models].reverse().find(m => m.featureVersion === fv) ?? null; },
  };
}

