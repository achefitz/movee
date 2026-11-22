import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Copy .env.example to .env and run `pnpm db:up`.",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";

// Query helpers, re-exported so apps share this package's single drizzle-orm copy.
export { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
